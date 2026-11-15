import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATOR_IDS } from "../src/domain/constants";
import { PRESET_IDS, getPreset, presetWeights } from "../src/domain/presets";
import { createOpenAiCompatibleClient, LlmError } from "../src/engine/llm";
import { parseJsonObject, runAgentTask } from "../src/orchestration/agent-tasks";
import { runToCompletion } from "../src/orchestration/autopilot";
import { readJsonFile } from "../src/orchestration/persistence";
import { ArenaRunner } from "../src/orchestration/runner";
import type { RankingFile } from "../src/reports/generator";
import { fakeLlm, firstUser, lastUser, respond } from "./fake-llm";
import { tempRunsDir } from "./fixtures";

const models = { generator: "gen-model", judge: "judge-model" };
let runsDir: string;
let cleanup: () => void;
let runner: ArenaRunner;

beforeEach(() => {
  ({ dir: runsDir, cleanup } = tempRunsDir());
  runner = new ArenaRunner({ runsDir });
});
afterEach(() => cleanup());

describe("자동 실행 (가짜 모델)", () => {
  it("생성 → 심사 → 토론 → 개선 → 재평가 → 보고서까지 끝난다", async () => {
    const llm = fakeLlm();
    const run = runner.create("동아리 신입 회원 유지", ["운영진 3명", "한 학기"], "general");
    const outcome = await runToCompletion(runner, run.runId, { llm, models });

    expect(outcome.run.phase).toBe("COMPLETED");
    const p = runner.paths(run.runId);
    const ranking = readJsonFile(p.ranking) as RankingFile;
    expect(ranking.top).toHaveLength(3);
    expect(ranking.metrics.debateTargets).toHaveLength(1); // 가짜 모델은 첫 아이디어에서 의견을 가른다

    // 생성 3 + 1차 심사 2 + 토론 2 + 개선 3 + 재평가 2
    expect(llm.calls).toHaveLength(12);
    expect(llm.calls.filter((c) => c.model === "gen-model")).toHaveLength(6);

    const report = readFileSync(p.report, "utf8");
    expect(report).toContain("범용");
    expect(report).toContain("실행 계획");
    expect(report).toContain("회의론자 심사위원");
  });

  it("심사위원 프롬프트에는 작성자 정보·개인 메모가 들어가지 않는다", async () => {
    const llm = fakeLlm();
    const run = runner.create("주제", [], "product");
    await runToCompletion(runner, run.runId, { llm, models });

    const judgeCalls = llm.calls.filter((c) => c.model === "judge-model");
    expect(judgeCalls).toHaveLength(6);
    for (const c of judgeCalls) {
      const text = c.system + c.messages.map((m) => m.content).join("\n");
      expect(text).not.toContain("SECRET-NOTE");
      expect(text).not.toMatch(/"generatorId"/);
      expect(text).not.toContain("authorNotes");
    }
  });

  it("개선 단계의 생성자는 자기 아이디어만 본다", async () => {
    const llm = fakeLlm();
    const run = runner.create("주제", []);
    await runToCompletion(runner, run.runId, { llm, models });
    const revisionCalls = llm.calls.filter((c) => firstUser(c).includes('"revisions": ['));
    expect(revisionCalls).toHaveLength(3);
    for (const c of revisionCalls) {
      const g = /"generatorId": "(\w+)"/.exec(firstUser(c))?.[1] as string;
      for (const other of GENERATOR_IDS.filter((x) => x !== g)) expect(firstUser(c)).not.toContain(`${other}-아이디어`);
    }
  });

  it("검증에 실패하면 오류를 알려 주고 다시 쓰게 한다", async () => {
    const llm = fakeLlm((req, i) => {
      if (i !== 0) return undefined;
      const one = JSON.parse(respond(req)) as { ideas: unknown[] };
      return JSON.stringify({ ...one, ideas: one.ideas.slice(0, 1) }); // 아이디어 1개만
    });
    const run = runner.create("주제", []);
    runner.advance(run.runId);
    const result = await runAgentTask(runner, run.runId, "creative", { llm, models });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(lastUser(llm.calls[1]!)).toContain("정확히 2개");
  });

  it("코드 블록으로 감싼 JSON도 읽는다", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject("[1,2]")).toBeUndefined();
    expect(parseJsonObject("not json")).toBeUndefined();
  });
});

describe("상황 프리셋", () => {
  it("모든 프리셋의 가중치 합은 100이다", () => {
    for (const id of PRESET_IDS) {
      const sum = Object.values(presetWeights(getPreset(id))).reduce((a, b) => a + b, 0);
      expect(sum, id).toBe(100);
    }
  });

  it("프리셋이 실행 설정·프롬프트에 반영된다", async () => {
    const llm = fakeLlm();
    const run = runner.create("한류 지속성 정책", ["교수 1명, 학생 1명"], "strategy");
    expect(run.preset).toBe("strategy");
    expect(run.config.scoring.weights).toEqual(presetWeights(getPreset("strategy")));
    runner.advance(run.runId);
    await runAgentTask(runner, run.runId, "business", { llm, models });
    const prompt = llm.calls[0]!;
    expect(prompt.system).toContain("전략·정책");
    expect(prompt.system).toContain(getPreset("strategy").generators.business.lens);
    expect(firstUser(prompt)).toContain("전략·정책 방안");
  });

  it("preset이 없는 예전 실행은 서비스·창업으로 취급한다", () => {
    expect(getPreset(undefined).id).toBe("product");
  });
});

describe("OpenAI 호환 클라이언트", () => {
  it("JSON 모드로 요청하고 키를 오류 메시지에 넣지 않는다", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const ok = createOpenAiCompatibleClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://gw.example/v1/",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("Authorization") ?? "" });
        return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: '{"x":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
      }) as typeof fetch,
    });
    const res = await ok.completeJson({ model: "m", system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe('{"x":1}');
    expect(seen[0]!.url).toBe("https://gw.example/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer sk-test-secret");
    expect(seen[0]!.body.response_format).toEqual({ type: "json_object" });
    expect((seen[0]!.body.messages as { role: string }[])[0]!.role).toBe("system");

    const bad = createOpenAiCompatibleClient({
      apiKey: "sk-test-secret",
      retries: 0,
      fetchImpl: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    });
    const err = await bad.completeJson({ model: "m", system: "s", messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as Error).message).toContain("API 키를 확인");
    expect((err as Error).message).not.toContain("sk-test-secret");
  });
});
