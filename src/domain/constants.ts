/**
 * IDEA ARENA 도메인 상수.
 * 에이전트 ID와 평가 기준은 파일 이름·스키마·보고서가 모두 공유하므로 여기서만 정의한다.
 */

export const GENERATOR_IDS = ["creative", "problem", "business"] as const;
export type GeneratorId = (typeof GENERATOR_IDS)[number];

export const JUDGE_IDS = ["feasibility", "innovation"] as const;
export type JudgeId = (typeof JUDGE_IDS)[number];

export const AGENT_LABELS: Record<GeneratorId | JudgeId, string> = {
  creative: "Creative Agent",
  problem: "Problem Agent",
  business: "Business Agent",
  feasibility: "Feasibility Judge",
  innovation: "Innovation Judge",
};

export const CRITERIA = [
  "problemValue",
  "originality",
  "feasibility",
  "mvpTestability",
  "differentiation",
] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_LABELS: Record<Criterion, string> = {
  problemValue: "문제 해결 가치",
  originality: "독창성",
  feasibility: "구현 가능성",
  mvpTestability: "MVP 검증 용이성",
  differentiation: "차별성",
};

/** 가중치(%) — 합계 100. 가중 점수는 0~100 범위가 된다. */
export const DEFAULT_WEIGHTS: Record<Criterion, number> = {
  problemValue: 25,
  originality: 20,
  feasibility: 20,
  mvpTestability: 20,
  differentiation: 15,
};

export const MAX_CRITERION_SCORE = 5;

export interface ScoringSettings {
  weights: Record<Criterion, number>;
  maxCriterionScore: number;
  /** 두 심사위원의 가중 총점 차이가 이 값 이상이면 토론 대상 */
  totalGapThreshold: number;
  /** 어떤 세부 항목이든 점수 차이가 이 값 이상이면 토론 대상 */
  criterionGapThreshold: number;
}

export const DEFAULT_SCORING: ScoringSettings = {
  weights: DEFAULT_WEIGHTS,
  maxCriterionScore: MAX_CRITERION_SCORE,
  totalGapThreshold: 15,
  criterionGapThreshold: 2,
};

export const SCORE_CHANGE_BASES = ["NEW_ARGUMENT", "PEER_PERSUASION", "ERROR_CORRECTION"] as const;
export type ScoreChangeBasis = (typeof SCORE_CHANGE_BASES)[number];

export const SCORE_CHANGE_BASIS_LABELS: Record<ScoreChangeBasis, string> = {
  NEW_ARGUMENT: "새 논거 발견",
  PEER_PERSUASION: "상대 심사위원 논거 수용",
  ERROR_CORRECTION: "자기 평가 오류 정정",
};

/** 익명화 결과에 작성자 정보가 섞였는지 탐지할 때 쓰는 용어 */
export const AUTHOR_LEAK_TERMS = [
  ...GENERATOR_IDS.map((id) => AGENT_LABELS[id]),
  "generatorId",
  "크리에이티브 에이전트",
  "문제 에이전트",
  "비즈니스 에이전트",
];
