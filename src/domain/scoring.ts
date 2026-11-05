import { CRITERIA, type Criterion, type JudgeId, type ScoreChangeBasis, type ScoringSettings } from "./constants";
import type { CriterionScores, DebateFile, EvaluationFile } from "./schemas";

/**
 * 점수 산정 알고리즘.
 *
 *   judgeTotal_j = Σ_i w_i · s_ij / maxScore          (0~100, Σw = 100)
 *   S            = (1/J) Σ_j judgeTotal_j               (J = 심사위원 수)
 *
 * 모든 함수는 순수 함수다. 같은 입력이면 같은 출력이 나와야 재시도 시 파생 파일이 바뀌지 않는다.
 */

export type ScoreVector = Record<Criterion, number>;

export interface JudgeIdeaScore {
  judgeId: JudgeId;
  scores: ScoreVector;
  total: number;
  criticalIssues: string[];
}

export type DebateReason =
  | { type: "TOTAL_GAP"; gap: number }
  | { type: "CRITERION_GAP"; criterion: Criterion; gap: number }
  | { type: "CRITICAL_ISSUE"; judgeId: JudgeId; issue: string };

export interface IdeaAggregate {
  ideaId: string;
  version: number;
  judges: JudgeIdeaScore[];
  /** 심사위원 가중 점수의 평균 (0~100) */
  score: number;
  /** 심사위원 가중 점수의 최댓값 − 최솟값 */
  totalGap: number;
  criterionGaps: ScoreVector;
  disagreementReasons: DebateReason[];
}

export interface AggregateFile {
  round: number;
  version: number;
  weights: ScoreVector;
  ideas: IdeaAggregate[];
  /** 불일치가 발견된 아이디어. 총점 차이가 큰 순서 */
  disagreements: string[];
  /** 심사위원 간 평균 총점 차이 — 판정 일치도 지표 */
  meanTotalGap: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toScoreVector(scores: CriterionScores): ScoreVector {
  return {
    problemValue: scores.problemValue.score,
    originality: scores.originality.score,
    feasibility: scores.feasibility.score,
    mvpTestability: scores.mvpTestability.score,
    differentiation: scores.differentiation.score,
  };
}

export function assertValidWeights(weights: ScoreVector): void {
  const sum = CRITERIA.reduce((acc, c) => acc + weights[c], 0);
  if (Math.abs(sum - 100) > 1e-9) {
    throw new Error(`가중치 합계는 100이어야 합니다 (현재 ${sum})`);
  }
}

export function judgeTotal(scores: ScoreVector, settings: ScoringSettings): number {
  assertValidWeights(settings.weights);
  const raw = CRITERIA.reduce(
    (acc, c) => acc + (settings.weights[c] * scores[c]) / settings.maxCriterionScore,
    0,
  );
  return round2(raw);
}

export function aggregateIdea(
  ideaId: string,
  version: number,
  judges: { judgeId: JudgeId; scores: ScoreVector; criticalIssues: string[] }[],
  settings: ScoringSettings,
): IdeaAggregate {
  if (judges.length === 0) throw new Error(`${ideaId}: 심사 결과가 없습니다`);

  const judgeScores: JudgeIdeaScore[] = judges.map((j) => ({
    judgeId: j.judgeId,
    scores: { ...j.scores },
    total: judgeTotal(j.scores, settings),
    criticalIssues: [...j.criticalIssues],
  }));

  const totals = judgeScores.map((j) => j.total);
  const score = round2(totals.reduce((a, b) => a + b, 0) / totals.length);
  const totalGap = round2(Math.max(...totals) - Math.min(...totals));

  const criterionGaps = {} as ScoreVector;
  for (const c of CRITERIA) {
    const values = judgeScores.map((j) => j.scores[c]);
    criterionGaps[c] = Math.max(...values) - Math.min(...values);
  }

  const reasons: DebateReason[] = [];
  if (totalGap >= settings.totalGapThreshold) reasons.push({ type: "TOTAL_GAP", gap: totalGap });
  for (const c of CRITERIA) {
    if (criterionGaps[c] >= settings.criterionGapThreshold) {
      reasons.push({ type: "CRITERION_GAP", criterion: c, gap: criterionGaps[c] });
    }
  }
  for (const j of judgeScores) {
    for (const issue of j.criticalIssues) reasons.push({ type: "CRITICAL_ISSUE", judgeId: j.judgeId, issue });
  }

  return { ideaId, version, judges: judgeScores, score, totalGap, criterionGaps, disagreementReasons: reasons };
}

/** 심사위원별 평가 파일을 아이디어별 집계로 변환한다. */
export function aggregateRound(
  round: number,
  version: number,
  ideaIds: string[],
  files: EvaluationFile[],
  settings: ScoringSettings,
): AggregateFile {
  const ideas = [...ideaIds].sort().map((ideaId) => {
    const judges = files.map((f) => {
      const ev = f.evaluations.find((e) => e.ideaId === ideaId);
      if (!ev) throw new Error(`${f.judgeId} 평가에 ${ideaId}가 없습니다`);
      return { judgeId: f.judgeId, scores: toScoreVector(ev.scores), criticalIssues: ev.criticalIssues };
    });
    return aggregateIdea(ideaId, version, judges, settings);
  });
  return buildAggregateFile(round, version, ideas, settings);
}

export function buildAggregateFile(
  round: number,
  version: number,
  ideas: IdeaAggregate[],
  settings: ScoringSettings,
): AggregateFile {
  const disagreements = ideas
    .filter((i) => i.disagreementReasons.length > 0)
    .sort((a, b) => b.totalGap - a.totalGap || a.ideaId.localeCompare(b.ideaId))
    .map((i) => i.ideaId);
  const meanTotalGap = ideas.length === 0 ? 0 : round2(ideas.reduce((a, i) => a + i.totalGap, 0) / ideas.length);
  return { round, version, weights: { ...settings.weights }, ideas, disagreements, meanTotalGap };
}

// ─── 토론 결과 반영 ───────────────────────────────────────────────

export interface AppliedScoreChange {
  ideaId: string;
  judgeId: JudgeId;
  criterion: Criterion;
  from: number;
  to: number;
  basis: ScoreChangeBasis;
  rationale: string;
}

export interface DebateResolution {
  round: number;
  /** 토론 후 점수(토론 대상이 아닌 아이디어는 그대로) */
  postDebate: AggregateFile;
  changes: AppliedScoreChange[];
  stances: { ideaId: string; judgeId: JudgeId; stance: "MAINTAIN" | "REVISE" }[];
  /** 점수 변경 근거 유형별 개수 — 동조(PEER_PERSUASION)와 새 논거를 구분해 추적 */
  basisCounts: Record<ScoreChangeBasis, number>;
  /** 토론 후에도 불일치가 남은 아이디어 — 억지 합의를 강요하지 않는다 */
  unresolved: string[];
  meanTotalGapBefore: number;
  meanTotalGapAfter: number;
}

export function applyDebate(
  before: AggregateFile,
  debates: DebateFile[],
  settings: ScoringSettings,
): DebateResolution {
  const changes: AppliedScoreChange[] = [];
  const stances: DebateResolution["stances"] = [];

  const ideas = before.ideas.map((idea) => {
    const judges = idea.judges.map((j) => {
      const scores = { ...j.scores };
      const entry = debates.find((d) => d.judgeId === j.judgeId)?.entries.find((e) => e.ideaId === idea.ideaId);
      if (entry) {
        stances.push({ ideaId: idea.ideaId, judgeId: j.judgeId, stance: entry.stance });
        for (const sc of entry.scoreChanges) {
          scores[sc.criterion] = sc.to;
          changes.push({ ideaId: idea.ideaId, judgeId: j.judgeId, ...sc });
        }
      }
      return { judgeId: j.judgeId, scores, criticalIssues: j.criticalIssues };
    });
    return aggregateIdea(idea.ideaId, idea.version, judges, settings);
  });

  const postDebate = buildAggregateFile(before.round, before.version, ideas, settings);
  const basisCounts: Record<ScoreChangeBasis, number> = { NEW_ARGUMENT: 0, PEER_PERSUASION: 0, ERROR_CORRECTION: 0 };
  for (const c of changes) basisCounts[c.basis] += 1;

  // 토론 이전에 불일치였고 이후에도 점수 격차가 남아 있는 항목만 "미해결"로 본다.
  // (치명적 이슈는 토론으로 사라지지 않으므로 점수 격차 기준만 사용)
  const unresolved = postDebate.ideas
    .filter((i) => before.disagreements.includes(i.ideaId))
    .filter((i) => i.disagreementReasons.some((r) => r.type !== "CRITICAL_ISSUE"))
    .map((i) => i.ideaId);

  return {
    round: before.round,
    postDebate,
    changes,
    stances,
    basisCounts,
    unresolved,
    meanTotalGapBefore: before.meanTotalGap,
    meanTotalGapAfter: postDebate.meanTotalGap,
  };
}

// ─── 순위 ────────────────────────────────────────────────────────

/**
 * 최종 점수 내림차순. 동점이면 심사위원 의견 차이가 작은 쪽, 그다음 문제 해결 가치 평균, 마지막으로 ID.
 */
export function rankAggregates(ideas: IdeaAggregate[]): IdeaAggregate[] {
  const pv = (i: IdeaAggregate) => i.judges.reduce((a, j) => a + j.scores.problemValue, 0) / i.judges.length;
  return [...ideas].sort(
    (a, b) => b.score - a.score || a.totalGap - b.totalGap || pv(b) - pv(a) || a.ideaId.localeCompare(b.ideaId),
  );
}
