import { CRITERIA, JUDGE_IDS, type Criterion, type GeneratorId, type JudgeId } from "../domain/constants";
import type { Preset } from "../domain/presets";
import type { BlindIdea, BlindIdeaV1, DebateFile, IdeaEvaluation } from "../domain/schemas";
import { evaluationTemplate, ideaTemplate } from "../orchestration/briefs";
import type { FeedbackPackage } from "../orchestration/runner";
import type { DebateAgenda } from "../orchestration/validator";

/**
 * 에이전트별 프롬프트(순수 함수). 각 에이전트가 볼 수 있는 데이터만 인자로 받는다 —
 * 정보 격리는 "무엇을 프롬프트에 넣는가"로 코드에서 보장된다.
 * 규칙 문구는 .claude/agents/*.md, orchestration/briefs.ts와 같은 내용을 유지한다.
 */

export interface PromptParts {
  system: string;
  user: string;
}

interface TopicCtx {
  topic: string;
  constraints: string[];
  preset: Preset;
}

function generatorPersona(agent: GeneratorId, preset: Preset): string {
  return `관점: ${preset.generators[agent].lens}`;
}

function judgePersona(agent: JudgeId, preset: Preset): string {
  const j = preset.judges[agent];
  return `너는 ${j.name}(judgeId: ${agent})다. 관점: ${j.lens}`;
}

const OUTPUT_RULE =
  "출력은 반드시 아래 형식을 따르는 JSON 객체 하나뿐이다. 설명 문장이나 마크다운 코드 블록을 붙이지 않는다. 형식에 없는 필드를 추가하지 않는다. 모든 텍스트는 한국어로 쓴다.";

const generatorRules = (preset: Preset) => [
  `너는 IDEA ARENA의 생성자다. 상황: ${preset.name}(${preset.description}). 여러 생성자가 독립적으로 ${preset.kind}를 내고, 익명 심사위원이 채점한다.`,
  "아이디어 본문에 너의 이름·역할·관점 이름을 쓰지 않는다. 본문은 익명으로 심사위원에게 전달된다.",
  "시장 수요·경쟁사·법률·기술 가능성에 대한 근거 없는 추론은 사실처럼 쓰지 말고 assumptions에 \"[가설]\"로 적는다.",
  "주제의 제약(팀 규모, 기간, 예산 등)을 지킨다.",
];

const judgeRules = (preset: Preset) => [
  `너는 IDEA ARENA의 심사위원이다. 상황: ${preset.name}(${preset.description}). 심사 대상은 ${preset.kind}이며, 작성자를 알 수 없게 익명화되어 있다. 작성자를 추측하려고 하지 않는다.`,
  "5개 항목 모두 0~5 정수로 채점하고 rationale에 구체적 근거를 적는다. 내 전문 관점이 아닌 항목도 근거를 들어 채점한다.",
  "합의가 목표가 아니다. 다른 심사위원과 의견이 달라도 근거가 유효하면 그대로 유지한다.",
  "근거 없이 가정한 시장·경쟁·법률·기술 판단은 hypotheses에 가설로 적는다. 사실처럼 쓰지 않는다.",
];

const json = (v: unknown) => JSON.stringify(v, null, 2);
const bullets = (items: string[]) => items.map((s) => `- ${s}`).join("\n");

function topicBlock(ctx: TopicCtx): string {
  return `## 주제\n${ctx.topic}\n\n## 제약\n${ctx.constraints.length ? bullets(ctx.constraints) : "(없음)"}`;
}

function criteriaBlock(preset: Preset, weights: Record<Criterion, number>): string {
  return CRITERIA.map((c) => `- ${c} = ${preset.criteria[c].label} (가중치 ${weights[c]}%): ${preset.criteria[c].description}`).join("\n");
}

function fieldGuide(preset: Preset, withPlan: boolean): string {
  const f = preset.fields;
  const lines = [
    `- title: ${f.title}`,
    `- problem: ${f.problem}`,
    `- targetUsers: ${f.targetUsers}`,
    `- solution: ${f.solution}`,
    `- differentiation: ${f.differentiation}`,
    `- mvp: ${f.mvp} (1개 이상)`,
    `- assumptions: ${f.assumptions} (1개 이상, "[가설]"로 시작)`,
  ];
  if (withPlan) lines.push(`- mvpPlan: ${f.plan}. week는 ${preset.planUnit} 번호(1부터), 각 항목에 goal과 deliverables(1개 이상)`);
  return lines.join("\n");
}

export function generationPrompt(agent: GeneratorId, ctx: TopicCtx & { count: number }): PromptParts {
  return {
    system: [...generatorRules(ctx.preset), generatorPersona(agent, ctx.preset)].join("\n"),
    user: `${topicBlock(ctx)}

## 할 일
주제에 맞는 ${ctx.preset.kind}를 **정확히 ${ctx.count}개** 만든다. 서로 다른 문제나 접근을 다루고 제목이 겹치지 않게 한다.
각 필드의 의미:
${fieldGuide(ctx.preset, false)}
- authorNotes(선택): 심사위원에게 전달되지 않는 개인 메모

${OUTPUT_RULE}
${json({ generatorId: agent, ideas: Array.from({ length: ctx.count }, () => ideaTemplate(false, ctx.preset.fields, ctx.preset.planUnit)) })}`,
  };
}

export function revisionPrompt(agent: GeneratorId, ctx: TopicCtx & { feedback: FeedbackPackage }): PromptParts {
  const template = {
    generatorId: agent,
    revisions: ctx.feedback.ideas.map((i) => ({
      ideaId: i.ideaId,
      idea: ideaTemplate(true, ctx.preset.fields, ctx.preset.planUnit),
      changelog: [{ change: "바꾼 내용", addresses: "대응한 피드백(심사위원·항목)" }],
      rejectedFeedback: [{ feedback: "수용하지 않은 피드백", reason: "반박 근거" }],
    })),
  };
  return {
    system: [...generatorRules(ctx.preset), generatorPersona(agent, ctx.preset), "피드백을 무조건 수용하지 않는다. 동의하지 않으면 rejectedFeedback에 근거를 들어 반박한다. 합의하려고 관점을 흐리지 마라."].join("\n"),
    user: `${topicBlock(ctx)}

## 내 아이디어에 대한 심사 결과와 토론 (원본 = original)
${json(ctx.feedback.ideas)}

## 할 일
각 아이디어(${ctx.feedback.ideas.map((i) => i.ideaId).join(", ")})의 개선본(version 2)을 만든다.
${bullets(ctx.feedback.instructions)}
- changelog에는 "무엇을 바꿨는지"와 "어떤 피드백(심사위원·항목)에 대응했는지"를 적는다(1개 이상).
- 수용하지 않은 피드백이 없으면 rejectedFeedback은 빈 배열로 둔다.
각 필드의 의미:
${fieldGuide(ctx.preset, true)}

${OUTPUT_RULE}
${json(template)}`,
  };
}

export interface ScoringCtx extends TopicCtx {
  round: 1 | 2;
  ideas: BlindIdea[];
  weights: Record<Criterion, number>;
  /** 재평가 때만: 내 1차 평가와 토론 기록 */
  previous?: { ownRound1: IdeaEvaluation[]; debates: DebateFile[] };
}

export function scoringPrompt(agent: JudgeId, ctx: ScoringCtx): PromptParts {
  const ids = ctx.ideas.map((i) => i.ideaId);
  const roundRules =
    ctx.round === 1
      ? "독립 심사 단계다. 다른 심사위원의 평가는 보지 않는다."
      : "개선본(v2)을 평가한다. changelog와 rejectedFeedback을 확인하고, 1차 대비 바뀐 판단을 changeFromPrevious에 적는다. 1차·토론 기록은 참고만 하고 개선본 자체를 기준으로 점수를 준다.";
  const previous = ctx.previous
    ? `\n\n## 참고: 내 1차 평가\n${json(ctx.previous.ownRound1)}\n\n## 참고: 토론 기록\n${json(ctx.previous.debates)}`
    : "";
  return {
    system: [...judgeRules(ctx.preset), judgePersona(agent, ctx.preset)].join("\n"),
    user: `${topicBlock(ctx)}

## 평가할 아이디어 (v${ctx.round}, ${ids.length}개)
${json(ctx.ideas)}${previous}

## 할 일
${roundRules}
아이디어 ${ids.length}개(${ids.join(", ")})를 모두 평가해 evaluations 배열에 넣는다. 평가 항목:
${criteriaBlock(ctx.preset, ctx.weights)}
- risks(실패 가능성): 이 아이디어가 실패할 수 있는 구체적 시나리오(필수, 1개 이상)
- criticalIssues: 중대한 기술 장애나 검증되지 않은 핵심 가정(없으면 빈 배열). 하나라도 적으면 토론 대상이 된다.
- summary: 한 문장 총평

${OUTPUT_RULE}
${json(evaluationTemplate(agent, ctx.round, ids.slice(0, 1), Object.fromEntries(CRITERIA.map((c) => [c, ctx.preset.criteria[c].label]))))}
(evaluations 배열에는 ${ids.length}개 아이디어를 모두 넣는다)`,
  };
}

export interface DebateCtx extends TopicCtx {
  agenda: DebateAgenda;
  weights: Record<Criterion, number>;
  ideas: BlindIdeaV1[];
  own: IdeaEvaluation[];
  other: IdeaEvaluation[];
}

export function debatePrompt(agent: JudgeId, ctx: DebateCtx): PromptParts {
  const other = JUDGE_IDS.find((j) => j !== agent) as JudgeId;
  const targets = ctx.agenda.targets.map((t) => t.ideaId);
  return {
    system: [...judgeRules(ctx.preset), judgePersona(agent, ctx.preset)].join("\n"),
    user: `${topicBlock(ctx)}

## 평가 항목
${criteriaBlock(ctx.preset, ctx.weights)}

## 토론 대상 (격차가 큰 순서)
${json(ctx.agenda.targets)}

## 대상 아이디어
${json(ctx.ideas)}

## 내 1차 평가 (${agent})
${json(ctx.own)}

## 상대 심사위원의 1차 평가 (${other})
${json(ctx.other)}

## 할 일
대상 아이디어(${targets.join(", ")})마다 entries에 하나씩 입장을 정리한다. 토론은 1회뿐이다.
- position: 내 평가의 핵심 근거 / rebuttal: 상대 평가의 약점을 구체적으로 / concessions: 상대 논거 중 인정하는 부분(없으면 빈 배열)
- 근거가 유효하면 입장을 유지한다: stance "MAINTAIN", scoreChanges는 빈 배열.
- 점수를 바꾸면 stance "REVISE". scoreChanges의 from은 반드시 내 1차 점수와 같아야 하고 to는 달라야 한다. 같은 항목을 두 번 바꾸지 않는다.
- basis를 정직하게 고른다: NEW_ARGUMENT(스스로 새 논거 발견) / PEER_PERSUASION(상대 논거에 설득됨 — rationale에 어떤 논거인지 구체적으로) / ERROR_CORRECTION(내 평가 실수 정정).

${OUTPUT_RULE}
${json({
  judgeId: agent,
  round: 1,
  entries: [
    {
      ideaId: targets[0] ?? "IDEA-00X",
      position: "내 평가의 핵심 근거",
      rebuttal: "상대 평가의 약점",
      concessions: ["상대 논거 중 인정하는 부분"],
      scoreChanges: [{ criterion: "feasibility", from: 2, to: 3, basis: "NEW_ARGUMENT", rationale: "변경 근거" }],
      stance: "REVISE",
    },
  ],
})}`,
  };
}

export function fixPrompt(errors: string[]): string {
  return `제출한 JSON이 검증을 통과하지 못했다. 아래 문제를 모두 고친 **전체 JSON**을 다시 출력하라. 형식 규칙은 그대로다.\n${bullets(errors)}`;
}
