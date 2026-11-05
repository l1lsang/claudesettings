import { existsSync } from "node:fs";
import {
  AGENT_LABELS,
  CRITERIA,
  CRITERION_LABELS,
  GENERATOR_IDS,
  JUDGE_IDS,
  type GeneratorId,
  type JudgeId,
} from "../domain/constants";
import type { ArenaPhase, ArenaRun } from "../domain/schemas";
import { readJsonFile } from "./persistence";
import { rel, type RunPaths } from "./paths";
import type { MappingFile } from "./anonymizer";
import type { DebateAgenda } from "./validator";

/**
 * 단계별로 누가 어떤 파일을 써야 하는지, 그리고 각 에이전트에게 전달할 작업 지시문.
 * Team Lead는 `arena brief`로 지시문을 뽑아 팀원에게 메시지로 보낸다.
 */

export type AgentId = GeneratorId | JudgeId;
export const AGENT_IDS: AgentId[] = [...GENERATOR_IDS, ...JUDGE_IDS];

export interface ExpectedFile {
  path: string;
  owner: AgentId | "orchestrator";
  exists: boolean;
}

export function expectedFiles(run: ArenaRun, paths: RunPaths): ExpectedFile[] {
  const f = (abs: string, owner: ExpectedFile["owner"]): ExpectedFile => ({ path: rel(paths, abs), owner, exists: existsSync(abs) });
  switch (run.phase) {
    case "CREATED":
      return [f(paths.input, "orchestrator")];
    case "GENERATING":
      return GENERATOR_IDS.map((g) => f(paths.generation(g), g));
    case "BLINDING":
      return [f(paths.mapping, "orchestrator")];
    case "SCORING":
      return JUDGE_IDS.map((j) => f(paths.evaluation(1, j), j));
    case "DEBATING":
      return JUDGE_IDS.map((j) => f(paths.debate(j), j));
    case "REVISING":
      return GENERATOR_IDS.map((g) => f(paths.revision(g), g));
    case "RESCORING":
      return JUDGE_IDS.map((j) => f(paths.evaluation(2, j), j));
    case "FINALIZING":
      return [f(paths.ranking, "orchestrator"), f(paths.report, "orchestrator")];
    default:
      return [];
  }
}

const isGenerator = (a: AgentId): a is GeneratorId => (GENERATOR_IDS as readonly string[]).includes(a);

function ideaTemplate(withPlan: boolean) {
  const base: Record<string, unknown> = {
    title: "서비스 이름",
    problem: "해결하려는 구체적 문제",
    targetUsers: "핵심 사용자",
    solution: "제안하는 해결 방식",
    differentiation: "기존 대안과의 차이",
    mvp: ["핵심 기능 1", "핵심 기능 2"],
    assumptions: ["[가설] 아직 검증하지 않은 가정"],
  };
  if (withPlan) base.mvpPlan = [{ week: 1, goal: "이번 주 목표", deliverables: ["산출물"] }];
  return base;
}

function evaluationTemplate(judge: JudgeId, round: 1 | 2, ids: string[]) {
  const scores = Object.fromEntries(CRITERIA.map((c) => [c, { score: 3, rationale: `${CRITERION_LABELS[c]} 근거` }]));
  return {
    judgeId: judge,
    round,
    evaluations: ids.slice(0, 1).map((id) => ({
      ideaId: id,
      version: round,
      scores,
      strengths: ["강점"],
      weaknesses: ["약점"],
      risks: ["실패 시나리오"],
      criticalIssues: [],
      hypotheses: ["[가설] 근거 없이 가정한 시장/기술 판단"],
      summary: "한 문장 총평",
      ...(round === 2 ? { changeFromPrevious: "1차 대비 판단이 바뀐 점" } : {}),
    })),
  };
}

const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";

export function buildBrief(run: ArenaRun, paths: RunPaths, agent: AgentId): string {
  const label = AGENT_LABELS[agent];
  const header = `# ${label} 작업 지시 — 실행 ${run.runId} / 단계 ${run.phase}\n\n주제: ${run.topic}\n제약: ${run.constraints.length ? run.constraints.join(" / ") : "(없음)"}\n`;
  const none = `${header}\n이 단계(${run.phase})에서 ${label}의 작업은 없습니다.\n`;
  const r = (abs: string) => rel(paths, abs);
  const ids = existsSync(paths.mapping) ? (readJsonFile(paths.mapping) as MappingFile).entries.map((e) => e.ideaId).sort() : [];

  if (isGenerator(agent)) {
    if (run.phase === "GENERATING") {
      return `${header}
## 할 일
주제에 맞는 서비스 아이디어를 **정확히 ${run.config.ideasPerGenerator}개** 작성해 \`${r(paths.generation(agent))}\`에 저장한다.

## 규칙
- 다른 생성자의 파일(private/generations/의 다른 파일)을 읽지 않는다. 독립 생성 단계다.
- 시장 수요·경쟁사·법률·기술 가능성에 대한 근거 없는 추론은 assumptions에 "[가설]"로 적는다.
- 본문(title~assumptions)에 자신의 에이전트 이름이나 역할을 쓰지 않는다. 익명 심사에 그대로 전달된다.
- authorNotes(선택)는 심사위원에게 전달되지 않는다.

## 형식
${json({ generatorId: agent, ideas: [ideaTemplate(false), "…두 번째 아이디어"] })}
`;
    }
    if (run.phase === "REVISING") {
      return `${header}
## 할 일
1. \`${r(paths.feedback(agent))}\`에서 내 아이디어에 대한 심사 결과·토론 내용을 읽는다.
2. 각 아이디어의 개선본을 \`${r(paths.revision(agent))}\`에 저장한다.

## 규칙
- 타당한 피드백은 반영하고 changelog에 "무엇을 바꿨는지 ← 어떤 피드백 때문인지"를 적는다.
- 동의하지 않는 피드백은 rejectedFeedback에 근거와 함께 반박한다. 무조건 수용하지 않는다.
- mvpPlan에 주 단위 개발 계획을 넣는다(주제의 팀 규모·기간 제약 준수).
- 원본 파일은 수정하지 않는다. 본문에 에이전트 이름을 쓰지 않는다.

## 형식
${json({
  generatorId: agent,
  revisions: [
    {
      ideaId: "IDEA-00X",
      idea: ideaTemplate(true),
      changelog: [{ change: "바꾼 내용", addresses: "대응한 피드백(심사위원·항목)" }],
      rejectedFeedback: [{ feedback: "수용하지 않은 피드백", reason: "반박 근거" }],
    },
  ],
})}
`;
    }
    return none;
  }

  // 심사위원
  const access = `- 읽을 수 있는 곳: \`blind/\`, \`evaluations/\`, \`debates/\`, input.json\n- 읽으면 안 되는 곳: \`private/\`, \`revisions/\` (작성자 정보가 있음)`;
  const criteria = CRITERIA.map((c) => `  - ${c} (${CRITERION_LABELS[c]}, 가중치 ${run.config.scoring.weights[c]}%)`).join("\n");
  const lens =
    agent === "feasibility"
      ? "당신의 관점: 기술·일정·구현 가능성. 제약 조건 안에서 실제로 만들 수 있는지 냉정하게 본다."
      : "당신의 관점: 독창성·문제 가치·차별성. 정말 새롭고 의미 있는 문제를 푸는지 본다.";

  if (run.phase === "SCORING" || run.phase === "RESCORING") {
    const round = run.phase === "SCORING" ? 1 : 2;
    const extra =
      round === 1
        ? "- 다른 심사위원의 평가 파일을 읽지 않는다. 독립 심사 단계다."
        : `- 개선본(v2)을 평가한다. changelog와 rejectedFeedback을 확인하고, 1차 대비 바뀐 판단은 changeFromPrevious에 적는다.\n- 1차·토론 기록은 참고할 수 있지만 개선본 자체를 기준으로 점수를 준다.`;
    return `${header}
${lens}

## 할 일
\`blind/v${round}/\`의 아이디어 ${ids.length}개(${ids.join(", ")})를 모두 평가해 \`${r(paths.evaluation(round, agent))}\`에 저장한다.

## 규칙
${access}
${extra}
- 모든 항목을 0~5 정수로 채점하고 rationale에 근거를 적는다:
${criteria}
- risks(실패 가능성)는 필수. 중대한 기술 장애나 검증되지 않은 핵심 가정은 criticalIssues에 적는다(토론 대상이 됨).
- 근거 없이 가정한 시장·경쟁·법률·기술 판단은 hypotheses에 가설로 적는다. 사실처럼 쓰지 않는다.

## 형식 (evaluations 배열에 모든 아이디어를 넣는다)
${json(evaluationTemplate(agent, round, ids.length ? ids : ["IDEA-001"]))}
`;
  }

  if (run.phase === "DEBATING") {
    const other = JUDGE_IDS.find((j) => j !== agent) as JudgeId;
    const agenda = existsSync(paths.debateAgenda) ? (readJsonFile(paths.debateAgenda) as DebateAgenda) : { round: 1, targets: [] };
    const targets = agenda.targets.map((t) => `${t.ideaId}(격차 ${t.totalGap})`).join(", ");
    return `${header}
${lens}

## 할 일
1. \`${r(paths.debateAgenda)}\`의 토론 대상(${targets})을 확인한다. 격차가 큰 순서다.
2. \`${r(paths.evaluation(1, other))}\`(상대 심사위원)와 내 1차 평가를 비교한다.
3. 대상 아이디어마다 입장을 정리해 \`${r(paths.debate(agent))}\`에 저장한다.

## 규칙
${access}
- 합의가 목표가 아니다. 근거가 유효하면 입장을 유지(MAINTAIN)한다. 상대 논거의 약점을 rebuttal에 구체적으로 지적한다.
- 점수를 바꾸면 stance는 REVISE, from은 내 1차 점수와 같아야 한다.
- basis를 정직하게 고른다: NEW_ARGUMENT(스스로 새 논거 발견) / PEER_PERSUASION(상대 논거에 설득됨 — 어떤 논거인지 명시) / ERROR_CORRECTION(내 평가 실수 정정).
- 토론은 1회뿐이다.

## 형식
${json({
  judgeId: agent,
  round: 1,
  entries: [
    {
      ideaId: agenda.targets[0]?.ideaId ?? "IDEA-00X",
      position: "내 평가의 핵심 근거",
      rebuttal: "상대 평가의 약점",
      concessions: ["상대 논거 중 인정하는 부분"],
      scoreChanges: [{ criterion: "feasibility", from: 2, to: 3, basis: "NEW_ARGUMENT", rationale: "변경 근거" }],
      stance: "REVISE",
    },
  ],
})}
`;
  }
  return none;
}

export function phaseActors(phase: ArenaPhase): string {
  switch (phase) {
    case "GENERATING":
    case "REVISING":
      return "생성자 3명 (creative, problem, business)";
    case "SCORING":
    case "DEBATING":
    case "RESCORING":
      return "심사위원 2명 (feasibility, innovation)";
    case "COMPLETED":
      return "-";
    case "FAILED":
      return "Team Lead (원인 확인 후 retry)";
    default:
      return "오케스트레이터 (advance 실행)";
  }
}
