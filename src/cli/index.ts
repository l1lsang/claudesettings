import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PRESET, PRESET_IDS, getPreset, isPresetId, listPresets, presetLabels, type PresetId } from "../domain/presets";
import { llmFromEnv } from "../engine/llm";
import { runToCompletion } from "../orchestration/autopilot";
import { AGENT_IDS, buildBrief, expectedFiles, phaseActors, type AgentId } from "../orchestration/briefs";
import { readEvents } from "../orchestration/persistence";
import { ArenaRunner, type AdvanceOutcome } from "../orchestration/runner";
import { depsFromEnv } from "../web/http";
import { createAppServer } from "../web/server";

// .env(LETSUR_API_KEY, APP_PASSWORD 등)를 읽는다. 없으면 무시.
try {
  process.loadEnvFile(".env");
} catch {
  /* .env 없음 */
}

const HELP = `IDEA ARENA CLI

사용법: npm run arena -- <명령> [옵션]

  auto    --topic "<주제>" [--constraint "<제약>"]... [--preset <상황>]
                                                         새 실행을 만들고 GPT로 끝까지 자동 진행
  auto    --run <id>                                     중단된 실행을 이어서 자동 진행
  create  --topic "<주제>" [--constraint "<제약>"]... [--preset <상황>]
                                                         새 연구 실행 생성(수동 진행용)
  presets                                                상황 프리셋 목록 (기본: ${DEFAULT_PRESET})
  list                                                   실행 목록
  status  --run <id>                                     현재 단계·필요한 파일·최근 이벤트
  brief   --run <id> --agent <agent>                     팀원에게 보낼 작업 지시문
            agent: ${AGENT_IDS.join(" | ")}
  check   --run <id>                                     현재 단계 산출물 검증(변경 없음)
  advance --run <id>                                     검증 후 다음 단계로 전이
  retry   --run <id> [--force]                           FAILED 실행을 실패 단계부터 재시도
  report  --run <id>                                     최종 보고서 출력
  export  --run <id>                                     실행 파일 묶음(JSON) 출력 — 웹 화면의 "가져오기"로 열 수 있음
  serve   [--port 4173]                                  웹 앱을 로컬에서 실행 (127.0.0.1, Vercel 배포와 같은 화면)

환경 변수(.env): LETSUR_API_KEY, APP_PASSWORD, [ARENA_MODEL | ARENA_GENERATOR_MODEL | ARENA_JUDGE_MODEL], [LETSUR_BASE_URL]

공통 옵션: --runs-dir <경로> (기본: ./runs 또는 ARENA_RUNS_DIR)
`;

const EXIT = { ok: 0, blocked: 1, usage: 2, failed: 3 } as const;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return EXIT.ok;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      topic: { type: "string" },
      constraint: { type: "string", multiple: true },
      run: { type: "string" },
      agent: { type: "string" },
      force: { type: "boolean" },
      preset: { type: "string" },
      port: { type: "string" },
      "runs-dir": { type: "string" },
    },
    strict: true,
  });

  const runner = new ArenaRunner({ runsDir: values["runs-dir"] ?? process.env.ARENA_RUNS_DIR ?? "runs" });
  const presetArg = (): PresetId => {
    if (values.preset === undefined) return DEFAULT_PRESET;
    if (!isPresetId(values.preset)) throw new UsageError(`--preset은 ${PRESET_IDS.join(", ")} 중 하나여야 합니다`);
    return values.preset;
  };
  const requireRun = (): string => {
    if (!values.run) throw new UsageError("--run <id>가 필요합니다");
    return values.run;
  };

  switch (command) {
    case "create": {
      if (!values.topic?.trim()) throw new UsageError('--topic "<주제>"가 필요합니다');
      const run = runner.create(values.topic, values.constraint ?? [], presetArg());
      console.log(`실행 생성: ${run.runId}`);
      console.log(`  위치: ${runner.runsDir}\\${run.runId}`);
      console.log(`\n다음: npm run arena -- advance --run ${run.runId}   (입력 검증 → GENERATING)`);
      return EXIT.ok;
    }

    case "presets": {
      for (const p of listPresets()) console.log(`${p.id.padEnd(10)} ${p.name} — ${p.description}`);
      return EXIT.ok;
    }

    case "list": {
      const runs = runner.list();
      if (!runs.length) console.log("실행이 없습니다.");
      for (const r of runs) console.log(`${r.runId}  ${r.phase.padEnd(11)}  ${r.topic.slice(0, 60)}`);
      return EXIT.ok;
    }

    case "status": {
      const runId = requireRun();
      const run = runner.load(runId);
      const paths = runner.paths(runId);
      console.log(`실행 ${run.runId}`);
      console.log(`  주제: ${run.topic}`);
      console.log(`  단계: ${run.phase}${run.previousPhase ? ` (이전 ${run.previousPhase})` : ""}`);
      console.log(`  담당: ${phaseActors(run.phase)}`);
      if (run.error) console.log(`  오류: [${run.error.phase}] ${run.error.message} (재시도 ${run.error.retryable ? "가능" : "불가"})`);
      const files = expectedFiles(run, paths);
      if (files.length) {
        console.log("\n이 단계에서 필요한 파일:");
        for (const f of files) console.log(`  ${f.exists ? "✓" : "✗"} ${f.path}  (${f.owner})`);
      }
      const events = readEvents(paths).slice(-5);
      if (events.length) {
        console.log("\n최근 이벤트:");
        for (const e of events) {
          const what = e.type === "PHASE_TRANSITION" ? `${e.from} → ${e.to}` : (e.phase ?? "");
          console.log(`  ${e.ts}  ${e.type}  ${what}${e.message ? `  ${e.message}` : ""}`);
        }
      }
      return EXIT.ok;
    }

    case "brief": {
      const runId = requireRun();
      const agent = values.agent as AgentId | undefined;
      if (!agent || !AGENT_IDS.includes(agent)) throw new UsageError(`--agent는 ${AGENT_IDS.join(", ")} 중 하나여야 합니다`);
      console.log(buildBrief(runner.load(runId), runner.paths(runId), agent));
      return EXIT.ok;
    }

    case "check": {
      const result = runner.check(requireRun());
      for (const w of result.warnings) console.log(`경고: ${w}`);
      if (result.ok) {
        console.log("검증 통과 — advance로 다음 단계로 진행할 수 있습니다.");
        return EXIT.ok;
      }
      console.log("검증 실패:");
      for (const e of result.errors) console.log(`  - ${e}`);
      return EXIT.blocked;
    }

    case "auto": {
      const { client, models } = llmFromEnv();
      if (!client) throw new UsageError("LETSUR_API_KEY 환경 변수(.env)가 필요합니다");
      let runId = values.run;
      if (!runId) {
        if (!values.topic?.trim()) throw new UsageError('--topic "<주제>" 또는 --run <id>가 필요합니다');
        runId = runner.create(values.topic, values.constraint ?? [], presetArg()).runId;
        console.log(`실행 생성: ${runId}`);
      }
      const preset = getPreset(runner.load(runId).preset);
      const AGENT_LABELS = presetLabels(preset).agents;
      console.log(`상황: ${preset.name}`);
      console.log(`모델: 생성자 ${models.generator} · 심사위원 ${models.judge}
`);
      const t0 = Date.now();
      const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`.padStart(5);
      const outcome = await runToCompletion(runner, runId, {
        llm: client,
        models,
        onEvent: (e) => {
          if (e.type === "agent-start") console.log(`${secs()}  [${e.phase}] ${AGENT_LABELS[e.agent]} 작업 시작`);
          if (e.type === "agent-done") {
            const r = e.result;
            const tokens = `토큰 ${r.usage.promptTokens}/${r.usage.completionTokens}`;
            console.log(`${secs()}  [${r.phase}] ${AGENT_LABELS[r.agent]} ${r.ok ? "완료" : "검증 실패"} (시도 ${r.attempts}회, ${tokens})`);
            for (const err of r.errors) console.log(`         - ${err}`);
          }
          if (e.type === "advance") for (const t of e.outcome.transitions) console.log(`${secs()}  전이: ${t.from} → ${t.to}`);
        },
      });
      return printOutcome(outcome);
    }

    case "export": {
      const runId = requireRun();
      const dir = runner.paths(runId).runDir;
      const files: Record<string, string> = {};
      const walk = (abs: string, rel: string) => {
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(join(abs, e.name), r);
          else if (e.isFile() && e.name !== ".lock" && !e.name.endsWith(".tmp")) files[r] = readFileSync(join(abs, e.name), "utf8");
        }
      };
      walk(dir, "");
      console.log(JSON.stringify({ format: "idea-arena-run", version: 1, runId, files }));
      return EXIT.ok;
    }

    case "advance":
      return printOutcome(runner.advance(requireRun()));

    case "retry":
      return printOutcome(runner.retry(requireRun(), { force: values.force ?? false }));

    case "report": {
      const runId = requireRun();
      const report = runner.paths(runId).report;
      if (!existsSync(report)) {
        console.log(`보고서가 아직 없습니다 (현재 단계 ${runner.load(runId).phase}).`);
        return EXIT.blocked;
      }
      console.log(readFileSync(report, "utf8"));
      return EXIT.ok;
    }

    case "serve": {
      const port = Number(values.port ?? process.env.ARENA_PORT ?? 4173);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port는 0~65535 정수여야 합니다");
      const deps = depsFromEnv();
      const server = createAppServer(deps);
      server.on("error", (err: NodeJS.ErrnoException) => {
        console.error(err.code === "EADDRINUSE" ? `포트 ${port}이(가) 사용 중입니다. --port로 다른 포트를 지정하세요.` : `서버 오류: ${err.message}`);
        process.exit(EXIT.failed);
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        const actual = typeof addr === "object" && addr ? addr.port : port;
        console.log(`IDEA ARENA: http://127.0.0.1:${actual}`);
        if (!deps.password) console.log("  ⚠ APP_PASSWORD가 없어 로그인할 수 없습니다 (.env에 설정)");
        if (!deps.llm) console.log("  ⚠ LETSUR_API_KEY가 없어 에이전트를 실행할 수 없습니다 (.env에 설정)");
        console.log("  실행 데이터는 브라우저에 저장됩니다 · 이 컴퓨터에서만 접속 가능 · 종료: Ctrl+C");
      });
      return EXIT.ok; // 서버가 열려 있는 동안 프로세스는 계속 실행된다
    }

    default:
      throw new UsageError(`알 수 없는 명령: ${command}`);
  }
}

function printOutcome(o: AdvanceOutcome): number {
  for (const t of o.transitions) console.log(`전이: ${t.from} → ${t.to}`);
  for (const w of o.warnings) console.log(`경고: ${w}`);
  if (o.errors.length) {
    console.log(o.status === "failed" ? "실패:" : "전이 중단 — 다음 문제를 해결하세요:");
    for (const e of o.errors) console.log(`  - ${e}`);
  }
  console.log(`현재 단계: ${o.run.phase}  (담당: ${phaseActors(o.run.phase)})`);
  if (o.run.phase === "COMPLETED") console.log(`보고서: npm run arena -- report --run ${o.run.runId}`);
  if (o.status === "failed") return EXIT.failed;
  if (o.status === "blocked") return EXIT.blocked;
  return EXIT.ok;
}

class UsageError extends Error {}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    console.error(`사용법 오류: ${(err as Error).message}\n`);
    console.error(HELP);
    process.exitCode = EXIT.usage;
  } else {
    console.error(`오류: ${(err as Error).message}`);
    process.exitCode = EXIT.failed;
  }
}
