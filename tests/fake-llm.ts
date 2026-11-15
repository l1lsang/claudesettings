import { CRITERIA } from "../src/domain/constants";
import type { JsonCompletionRequest, LlmClient } from "../src/engine/llm";
import { evaluationFile, idea } from "./fixtures";

/**
 * 테스트용 가짜 모델. 프롬프트의 JSON 형식 예시를 보고 어떤 작업인지 판단해 유효한 응답을 만든다.
 * 실제 네트워크를 쓰지 않는다. 모든 요청을 calls에 기록한다.
 */
export interface FakeLlm extends LlmClient {
  calls: JsonCompletionRequest[];
}

export type Override = (req: JsonCompletionRequest, callIndex: number) => string | undefined;

const lastUser = (req: JsonCompletionRequest) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
const firstUser = (req: JsonCompletionRequest) => req.messages[0]?.content ?? "";
const idList = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter((x) => /^IDEA-\d{3}$/.test(x));

export function respond(req: JsonCompletionRequest): string {
  const prompt = firstUser(req);
  const gen = /"generatorId": "(\w+)"/.exec(prompt)?.[1];
  const judge = /"judgeId": "(\w+)"/.exec(prompt)?.[1];

  if (gen && prompt.includes('"ideas": [')) {
    return JSON.stringify({ generatorId: gen, ideas: [idea(`${gen}-아이디어-1`), { ...idea(`${gen}-아이디어-2`), authorNotes: `SECRET-NOTE-${gen}` }] });
  }
  if (gen && prompt.includes('"revisions": [')) {
    const ids = [...new Set([...prompt.matchAll(/"ideaId": "(IDEA-\d{3})"/g)].map((m) => m[1] as string))];
    return JSON.stringify({
      generatorId: gen,
      revisions: ids.map((id) => ({
        ideaId: id,
        idea: { ...idea(`${id} 개선판`), mvpPlan: [1, 2].map((w) => ({ week: w, goal: `${w}단계 목표`, deliverables: ["산출물"] })) },
        changelog: [{ change: "범위를 좁힘", addresses: "feasibility: 범위 지적" }],
        rejectedFeedback: [],
      })),
    });
  }
  if (judge && /를 모두 평가/.test(prompt)) {
    const round = prompt.includes('"round": 2') ? 2 : 1;
    const ids = idList(/아이디어 \d+개\(([^)]+)\)를 모두 평가/.exec(prompt)?.[1]);
    // 1차: 첫 아이디어에서 심사위원 의견이 크게 갈리게 해 토론을 유도한다
    const file = evaluationFile(judge as "feasibility" | "innovation", round as 1 | 2, ids, (id) =>
      round === 1 && id === ids[0] ? { feasibility: judge === "feasibility" ? 1 : 5 } : Object.fromEntries(CRITERIA.map((c) => [c, 4])),
    );
    return JSON.stringify(file);
  }
  if (judge && prompt.includes('"entries": [')) {
    const targets = idList(/대상 아이디어\(([^)]+)\)마다/.exec(prompt)?.[1]);
    return JSON.stringify({
      judgeId: judge,
      round: 1,
      entries: targets.map((id) => ({ ideaId: id, position: "근거 유지", rebuttal: "상대 근거 부족", concessions: [], scoreChanges: [], stance: "MAINTAIN" })),
    });
  }
  throw new Error(`가짜 모델이 알 수 없는 요청: ${prompt.slice(0, 200)}`);
}

export function fakeLlm(override?: Override): FakeLlm {
  const calls: JsonCompletionRequest[] = [];
  return {
    calls,
    async completeJson(req) {
      const i = calls.length;
      calls.push(req);
      const text = override?.(req, i) ?? respond(req);
      return { text, model: req.model, usage: { promptTokens: 10, completionTokens: 20 } };
    },
  };
}

export { lastUser, firstUser };
