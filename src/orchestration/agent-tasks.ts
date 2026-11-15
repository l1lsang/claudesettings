import { existsSync, readdirSync } from "node:fs";
import { GENERATOR_IDS, JUDGE_IDS, type GeneratorId, type JudgeId } from "../domain/constants";
import { getPreset } from "../domain/presets";
import {
  BlindIdeaV1Schema,
  BlindIdeaV2Schema,
  DebateFileSchema,
  EvaluationFileSchema,
  type ArenaRun,
  type BlindIdea,
  type DebateFile,
  type IdeaEvaluation,
} from "../domain/schemas";
import type { LlmClient, ModelConfig } from "../engine/llm";
import { debatePrompt, fixPrompt, generationPrompt, revisionPrompt, scoringPrompt, type PromptParts } from "../engine/prompts";
import { expectedFiles, type AgentId } from "./briefs";
import type { RunPaths } from "./paths";
import { readJsonFile, toJson, writeFileAtomic } from "./persistence";
import type { ArenaRunner, FeedbackPackage } from "./runner";
import type { DebateAgenda } from "./validator";

/**
 * 에이전트 작업 실행기 — Claude Code 팀원 대신 GPT(OpenAI 호환 API)가 산출물을 쓴다.
 *
 *  1. 현재 단계에서 이 에이전트가 볼 수 있는 파일만 읽어 프롬프트를 만든다(정보 격리).
 *  2. 모델 응답(JSON)을 에이전트 몫의 경로에 저장한다. 상태 파일은 건드리지 않는다.
 *  3. 오케스트레이터 검증(runner.check)으로 이 파일의 오류만 골라, 있으면 오류를 알려주고 다시 쓰게 한다.
 *
 * 단계 전이는 여전히 runner.advance만 한다.
 */

export interface AgentTaskOptions {
  llm: LlmClient;
  models: ModelConfig;
  /** 검증 실패 시 포함한 총 시도 횟수 (기본 3) */
  maxAttempts?: number;
  /** 작업 전체 시간 제한(ms) — 서버리스 함수 시간 제한 대비. 남은 시간이 부족하면 재시도하지 않는다 */
  timeBudgetMs?: number;
  /** 이전 advance에서 이 에이전트 파일에 대해 나온 오류(다시 쓸 때 함께 전달) */
  hint?: string[];
}

export interface AgentTaskResult {
  agent: AgentId;
  phase: ArenaRun["phase"];
  /** 실행 디렉터리 기준 상대 경로 */
  path: string;
  ok: boolean;
  errors: string[];
  attempts: number;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export class AgentTaskError extends Error {
  override name = "AgentTaskError";
}

const isGenerator = (a: AgentId): a is GeneratorId => (GENERATOR_IDS as readonly string[]).includes(a);

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && ([...GENERATOR_IDS, ...JUDGE_IDS] as string[]).includes(value);
}

export async function runAgentTask(runner: ArenaRunner, runId: string, agent: AgentId, opts: AgentTaskOptions): Promise<AgentTaskResult> {
  const started = Date.now();
  const paths = runner.paths(runId);
  const run = runner.load(runId);
  const target = expectedFiles(run, paths).find((f) => f.owner === agent);
  if (!target) throw new AgentTaskError(`${run.phase} 단계에는 ${agent}의 작업이 없습니다`);

  const prompt = buildPrompt(run, paths, agent);
  const model = isGenerator(agent) ? opts.models.generator : opts.models.judge;
  const abs = `${paths.runDir}/${target.path}`;
  const maxAttempts = opts.maxAttempts ?? 3;
  const usage = { promptTokens: 0, completionTokens: 0 };

  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: opts.hint?.length ? `${prompt.user}\n\n## 이전 제출이 거부된 이유\n${opts.hint.map((e) => `- ${e}`).join("\n")}` : prompt.user },
  ];

  for (let attempt = 1; ; attempt++) {
    const remaining = opts.timeBudgetMs === undefined ? undefined : opts.timeBudgetMs - (Date.now() - started);
    const res = await opts.llm.completeJson({ model, system: prompt.system, messages, timeoutMs: remaining });
    usage.promptTokens += res.usage?.promptTokens ?? 0;
    usage.completionTokens += res.usage?.completionTokens ?? 0;

    let errors: string[];
    const parsed = parseJsonObject(res.text);
    if (parsed === undefined) {
      errors = ["응답이 올바른 JSON 객체가 아닙니다"];
    } else {
      writeFileAtomic(abs, toJson(normalize(parsed, run, agent)));
      errors = runner.check(runId).errors.filter((e) => e.includes(target.path));
    }

    const result = { agent, phase: run.phase, path: target.path, ok: errors.length === 0, errors, attempts: attempt, model: res.model, usage };
    // 재시도 요청에 최소 90초는 남아 있어야 한다
    const outOfTime = opts.timeBudgetMs !== undefined && opts.timeBudgetMs - (Date.now() - started) < 90_000;
    if (result.ok || attempt >= maxAttempts || outOfTime) return result;
    messages.push({ role: "assistant", content: res.text }, { role: "user", content: fixPrompt(errors) });
  }
}

// ─── 프롬프트 컨텍스트 (에이전트가 볼 수 있는 파일만 읽는다) ─────────────

function buildPrompt(run: ArenaRun, paths: RunPaths, agent: AgentId): PromptParts {
  const topic = { topic: run.topic, constraints: run.constraints, preset: getPreset(run.preset) };

  if (isGenerator(agent)) {
    if (run.phase === "GENERATING") return generationPrompt(agent, { ...topic, count: run.config.ideasPerGenerator });
    if (run.phase === "REVISING") {
      // 생성자는 자기 피드백 패키지만 본다(다른 생성자의 아이디어·작성자 매핑 없음)
      return revisionPrompt(agent, { ...topic, feedback: readJsonFile(paths.feedback(agent)) as FeedbackPackage });
    }
  } else {
    // 심사위원은 blind/, evaluations/, debates/만 본다 — private/, revisions/는 읽지 않는다
    const judge = agent as JudgeId;
    if (run.phase === "SCORING") {
      return scoringPrompt(judge, { ...topic, round: 1, ideas: blindIdeas(paths, 1), weights: run.config.scoring.weights });
    }
    if (run.phase === "RESCORING") {
      return scoringPrompt(judge, {
        ...topic,
        round: 2,
        ideas: blindIdeas(paths, 2),
        weights: run.config.scoring.weights,
        previous: { ownRound1: evaluations(paths, 1, judge), debates: debates(paths) },
      });
    }
    if (run.phase === "DEBATING") {
      const agenda = readJsonFile(paths.debateAgenda) as DebateAgenda;
      const targets = new Set(agenda.targets.map((t) => t.ideaId));
      const other = JUDGE_IDS.find((j) => j !== judge) as JudgeId;
      const only = <T extends { ideaId: string }>(xs: T[]) => xs.filter((x) => targets.has(x.ideaId));
      return debatePrompt(judge, {
        ...topic,
        agenda,
        weights: run.config.scoring.weights,
        ideas: only(blindIdeas(paths, 1)).map((i) => BlindIdeaV1Schema.parse(i)),
        own: only(evaluations(paths, 1, judge)),
        other: only(evaluations(paths, 1, other)),
      });
    }
  }
  throw new AgentTaskError(`${run.phase} 단계에는 ${agent}의 작업이 없습니다`);
}

function blindIdeas(paths: RunPaths, version: 1 | 2): BlindIdea[] {
  const dir = paths.blindDir(version);
  const schema = version === 1 ? BlindIdeaV1Schema : BlindIdeaV2Schema;
  return readdirSync(dir)
    .filter((f) => /^IDEA-\d{3}\.json$/.test(f))
    .sort()
    .map((f) => schema.parse(readJsonFile(`${dir}/${f}`)));
}

function evaluations(paths: RunPaths, round: 1 | 2, judge: JudgeId): IdeaEvaluation[] {
  return EvaluationFileSchema.parse(readJsonFile(paths.evaluation(round, judge))).evaluations;
}

function debates(paths: RunPaths): DebateFile[] {
  return JUDGE_IDS.map((j) => paths.debate(j))
    .filter((p) => existsSync(p))
    .map((p) => DebateFileSchema.parse(readJsonFile(p)));
}

// ─── 응답 정리 ────────────────────────────────────────────────────

/** 코드 블록으로 감싼 응답도 받아준다. 객체가 아니면 undefined. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const v = JSON.parse(trimmed) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 오케스트레이터가 이미 아는 식별 필드(작성자·라운드·버전)는 모델 응답과 관계없이 정해진 값으로 채운다. */
function normalize(data: Record<string, unknown>, run: ArenaRun, agent: AgentId): Record<string, unknown> {
  if (isGenerator(agent)) return { ...data, generatorId: agent };
  if (run.phase === "DEBATING") return { ...data, judgeId: agent, round: 1 };
  const round = run.phase === "RESCORING" ? 2 : 1;
  const evals = Array.isArray(data.evaluations)
    ? data.evaluations.map((e) => (e && typeof e === "object" ? { ...(e as object), version: round } : e))
    : data.evaluations;
  return { ...data, judgeId: agent, round, evaluations: evals };
}

