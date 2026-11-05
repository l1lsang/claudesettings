import {
  AGENT_LABELS,
  CRITERIA,
  CRITERION_LABELS,
  GENERATOR_IDS,
  SCORE_CHANGE_BASIS_LABELS,
  type GeneratorId,
  type JudgeId,
  type ScoreChangeBasis,
} from "../domain/constants";
import type { BlindIdeaV1, BlindIdeaV2, DebateFile, EvaluationFile, RunInput } from "../domain/schemas";
import { rankAggregates, round2, type AggregateFile, type DebateResolution, type ScoreVector } from "../domain/scoring";
import type { MappingFile } from "../orchestration/anonymizer";

/**
 * 최종 순위와 보고서. 입력 파일만으로 결정되는 순수 함수다(현재 시각 등을 넣지 않는다).
 */

export const TOP_N = 3;

export interface RankingInputs {
  input: RunInput;
  mapping: MappingFile;
  v1: BlindIdeaV1[];
  v2: BlindIdeaV2[];
  round1: AggregateFile;
  resolution?: DebateResolution;
  round2: AggregateFile;
  round1Evaluations: EvaluationFile[];
  round2Evaluations: EvaluationFile[];
  debates: DebateFile[];
}

export interface RankedIdea {
  rank: number;
  ideaId: string;
  title: string;
  /** 심사가 모두 끝난 뒤에만 공개되는 작성자 */
  generatorId: GeneratorId;
  initialScore: number;
  postDebateScore: number;
  finalScore: number;
  delta: number;
  debated: boolean;
  finalJudges: { judgeId: JudgeId; total: number; scores: ScoreVector }[];
  finalGap: number;
  /** 재평가 후에도 심사위원 의견이 갈리는 경우 */
  persistentDisagreement: boolean;
}

export interface RankingFile {
  runId: string;
  topic: string;
  top: string[];
  ranking: RankedIdea[];
  metrics: {
    meanInitialScore: number;
    meanFinalScore: number;
    meanDelta: number;
    judgeGap: { round1: number; postDebate: number; round2: number };
    debateTargets: string[];
    scoreChangesByBasis: Record<ScoreChangeBasis, number>;
    stances: { maintain: number; revise: number };
    byGenerator: { generatorId: GeneratorId; meanFinalScore: number; bestRank: number }[];
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : round2(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`보고서 생성에 필요한 데이터가 없습니다: ${what}`);
  return value;
}

export function buildRanking(inp: RankingInputs): RankingFile {
  const postDebate = inp.resolution?.postDebate ?? inp.round1;
  const ordered = rankAggregates(inp.round2.ideas);

  const ranking: RankedIdea[] = ordered.map((agg, i) => {
    const initial = must(inp.round1.ideas.find((x) => x.ideaId === agg.ideaId), `${agg.ideaId} 1차 점수`);
    const post = must(postDebate.ideas.find((x) => x.ideaId === agg.ideaId), `${agg.ideaId} 토론 후 점수`);
    const v2 = must(inp.v2.find((x) => x.ideaId === agg.ideaId), `${agg.ideaId} v2`);
    const owner = must(inp.mapping.entries.find((e) => e.ideaId === agg.ideaId), `${agg.ideaId} 매핑`);
    return {
      rank: i + 1,
      ideaId: agg.ideaId,
      title: v2.title,
      generatorId: owner.generatorId,
      initialScore: initial.score,
      postDebateScore: post.score,
      finalScore: agg.score,
      delta: round2(agg.score - initial.score),
      debated: inp.round1.disagreements.includes(agg.ideaId),
      finalJudges: agg.judges.map((j) => ({ judgeId: j.judgeId, total: j.total, scores: j.scores })),
      finalGap: agg.totalGap,
      persistentDisagreement: agg.disagreementReasons.some((r) => r.type !== "CRITICAL_ISSUE"),
    };
  });

  const byGenerator = GENERATOR_IDS.map((g) => {
    const own = ranking.filter((r) => r.generatorId === g);
    return {
      generatorId: g,
      meanFinalScore: mean(own.map((r) => r.finalScore)),
      bestRank: own.length ? Math.min(...own.map((r) => r.rank)) : 0,
    };
  });

  const stances = inp.resolution?.stances ?? [];
  return {
    runId: inp.input.runId,
    topic: inp.input.topic,
    top: ranking.slice(0, TOP_N).map((r) => r.ideaId),
    ranking,
    metrics: {
      meanInitialScore: mean(ranking.map((r) => r.initialScore)),
      meanFinalScore: mean(ranking.map((r) => r.finalScore)),
      meanDelta: mean(ranking.map((r) => r.delta)),
      judgeGap: { round1: inp.round1.meanTotalGap, postDebate: postDebate.meanTotalGap, round2: inp.round2.meanTotalGap },
      debateTargets: [...inp.round1.disagreements],
      scoreChangesByBasis: inp.resolution?.basisCounts ?? { NEW_ARGUMENT: 0, PEER_PERSUASION: 0, ERROR_CORRECTION: 0 },
      stances: {
        maintain: stances.filter((s) => s.stance === "MAINTAIN").length,
        revise: stances.filter((s) => s.stance === "REVISE").length,
      },
      byGenerator,
    },
  };
}

// ─── Markdown ────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const fmt = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const bullets = (items: string[], empty = "- (없음)") => (items.length ? items.map((s) => `- ${s}`).join("\n") : empty);
const unique = (items: string[]) => [...new Set(items)];

export const REQUIRED_REPORT_SECTIONS = ["## 최종 순위", "## TOP 3 상세", "## 오케스트레이션 지표", "## 해석 시 주의"];

export function renderReport(inp: RankingInputs, ranking: RankingFile): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(`# IDEA ARENA 연구 보고서`, "");
  push(`- **주제**: ${inp.input.topic}`);
  push(`- **제약 조건**: ${inp.input.constraints.length ? inp.input.constraints.join(" / ") : "(없음)"}`);
  push(`- **실행 ID**: \`${inp.input.runId}\` (생성 ${inp.input.createdAt})`);
  push(`- **절차**: 독립 생성 6개 → 익명 심사 2인 → 교차 토론 ${ranking.metrics.debateTargets.length}건 → 개선 → 재평가`, "");

  push(`## 최종 순위`, "");
  push(`| 순위 | ID | 아이디어 | 생성 관점 | 최초 | 토론 후 | 최종 | 변화 | 심사 격차 |`);
  push(`|---:|---|---|---|---:|---:|---:|---:|---:|`);
  for (const r of ranking.ranking) {
    const gap = `${fmt(r.finalGap)}${r.persistentDisagreement ? " ⚠" : ""}`;
    push(
      `| ${r.rank} | ${r.ideaId} | ${esc(r.title)} | ${AGENT_LABELS[r.generatorId]} | ${fmt(r.initialScore)} | ${fmt(r.postDebateScore)} | ${fmt(r.finalScore)} | ${signed(r.delta)} | ${gap} |`,
    );
  }
  push("", `점수는 0~100 (가중치: ${CRITERIA.map((c) => `${CRITERION_LABELS[c]} ${inp.round2.weights[c]}%`).join(", ")}). ⚠ = 재평가 후에도 심사위원 의견이 갈림.`, "");

  push(`## TOP 3 상세`, "");
  for (const r of ranking.ranking.slice(0, TOP_N)) {
    push(...renderIdeaDetail(inp, r), "");
  }

  const rest = ranking.ranking.slice(TOP_N);
  if (rest.length) {
    push(`## 선정되지 않은 아이디어`, "");
    for (const r of rest) {
      const evs = inp.round2Evaluations.map((f) => f.evaluations.find((e) => e.ideaId === r.ideaId)).filter((e) => e !== undefined);
      push(`- **${r.rank}위 ${r.ideaId} ${r.title}** (${fmt(r.finalScore)}점) — ${evs.map((e) => e.summary).join(" / ")}`);
    }
    push("");
  }

  const m = ranking.metrics;
  push(`## 오케스트레이션 지표`, "");
  push(`| 지표 | 값 |`, `|---|---|`);
  push(`| 평균 점수 (최초 → 최종) | ${fmt(m.meanInitialScore)} → ${fmt(m.meanFinalScore)} (${signed(m.meanDelta)}) |`);
  push(`| 심사위원 평균 총점 격차 (1차 → 토론 후 → 재평가) | ${fmt(m.judgeGap.round1)} → ${fmt(m.judgeGap.postDebate)} → ${fmt(m.judgeGap.round2)} |`);
  push(`| 토론 대상 | ${m.debateTargets.length ? m.debateTargets.join(", ") : "없음 (평가 일치)"} |`);
  push(`| 토론 입장 | 유지 ${m.stances.maintain} / 수정 ${m.stances.revise} |`);
  for (const basis of Object.keys(m.scoreChangesByBasis) as ScoreChangeBasis[]) {
    push(`| 점수 변경 — ${SCORE_CHANGE_BASIS_LABELS[basis]} | ${m.scoreChangesByBasis[basis]}건 |`);
  }
  for (const g of m.byGenerator) {
    push(`| ${AGENT_LABELS[g.generatorId]} 평균 최종 점수 / 최고 순위 | ${fmt(g.meanFinalScore)} / ${g.bestRank}위 |`);
  }
  push("");
  if (inp.resolution && inp.resolution.unresolved.length) {
    push(`토론 후에도 의견 차이가 남은 아이디어: ${inp.resolution.unresolved.join(", ")} — 합의를 강요하지 않고 양측 근거를 그대로 기록했다.`, "");
  }

  push(`## 해석 시 주의`, "");
  push(
    `- 모든 점수는 AI 심사위원의 판단이다. AI끼리 높은 점수를 줬다고 실제 품질이 좋아졌다고 단정할 수 없다. 외부(사람) 평가로 교차 검증해야 한다.`,
    `- 시장 수요·경쟁사·법률·기술 가능성에 관한 내용은 별도 근거가 제시되지 않은 한 **가설**이다. 각 아이디어의 "검증해야 할 가설"을 먼저 확인할 것.`,
    `- 같은 작업 디렉터리를 공유하는 Agent Teams 특성상 익명성은 운영 규칙으로 보장했다(파일 접근 격리 아님).`,
    `- 개선 후 점수 상승에는 "피드백 반영 효과"와 "같은 심사위원의 재평가 관대화"가 섞여 있을 수 있다. 단일 Claude 베이스라인과 비교 실험이 필요하다.`,
  );
  return `${out.join("\n")}\n`;
}

function renderIdeaDetail(inp: RankingInputs, r: RankedIdea): string[] {
  const v1 = must(inp.v1.find((x) => x.ideaId === r.ideaId), `${r.ideaId} v1`);
  const v2 = must(inp.v2.find((x) => x.ideaId === r.ideaId), `${r.ideaId} v2`);
  const evals2 = inp.round2Evaluations
    .map((f) => ({ judgeId: f.judgeId, ev: f.evaluations.find((e) => e.ideaId === r.ideaId) }))
    .filter((x): x is { judgeId: JudgeId; ev: NonNullable<typeof x.ev> } => x.ev !== undefined);
  const evals1 = inp.round1Evaluations
    .map((f) => ({ judgeId: f.judgeId, ev: f.evaluations.find((e) => e.ideaId === r.ideaId) }))
    .filter((x): x is { judgeId: JudgeId; ev: NonNullable<typeof x.ev> } => x.ev !== undefined);

  const L: string[] = [];
  L.push(`### ${r.rank}위. ${v2.title} (${r.ideaId})`, "");
  L.push(`**최종 ${fmt(r.finalScore)}점** · 최초 ${fmt(r.initialScore)} → 토론 후 ${fmt(r.postDebateScore)} → 최종 ${fmt(r.finalScore)} (${signed(r.delta)}) · 생성 관점: ${AGENT_LABELS[r.generatorId]}`, "");
  L.push(`- **문제**: ${v2.problem}`);
  L.push(`- **핵심 사용자**: ${v2.targetUsers}`);
  L.push(`- **해결 방식**: ${v2.solution}`);
  L.push(`- **차별성**: ${v2.differentiation}`, "");

  L.push(`#### 심사 점수 (재평가 기준, 0~5)`, "");
  L.push(`| 항목 | ${evals2.map((e) => AGENT_LABELS[e.judgeId]).join(" | ")} |`);
  L.push(`|---|${evals2.map(() => "---:").join("|")}|`);
  for (const c of CRITERIA) {
    L.push(`| ${CRITERION_LABELS[c]} | ${evals2.map((e) => String(e.ev.scores[c].score)).join(" | ")} |`);
  }
  L.push(`| **가중 점수** | ${r.finalJudges.map((j) => fmt(j.total)).join(" | ")} |`, "");

  L.push(`#### 선정 이유`, "");
  for (const e of evals2) L.push(`- **${AGENT_LABELS[e.judgeId]}**: ${e.ev.summary}`);
  L.push(...unique(evals2.flatMap((e) => e.ev.strengths)).map((s) => `- 강점: ${s}`), "");

  L.push(`#### 실패 가능성`, "");
  L.push(bullets(unique([...evals2.flatMap((e) => e.ev.risks), ...evals2.flatMap((e) => e.ev.criticalIssues.map((i) => `**[중대]** ${i}`))])), "");

  L.push(`#### 검증해야 할 가설`, "");
  L.push(bullets(unique([...v2.assumptions, ...evals2.flatMap((e) => e.ev.hypotheses)])), "");

  L.push(`#### 반박과 개선 과정`, "");
  L.push(`**1차 심사 (v1 "${v1.title}")**`);
  for (const e of evals1) L.push(`- ${AGENT_LABELS[e.judgeId]}: ${e.ev.summary} — 약점: ${e.ev.weaknesses.join("; ")}`);
  const debateEntries = inp.debates
    .map((d) => ({ judgeId: d.judgeId, entry: d.entries.find((x) => x.ideaId === r.ideaId) }))
    .filter((x) => x.entry !== undefined);
  if (debateEntries.length) {
    L.push("", `**교차 토론**`);
    for (const { judgeId, entry } of debateEntries) {
      if (!entry) continue;
      L.push(`- ${AGENT_LABELS[judgeId]} (${entry.stance === "MAINTAIN" ? "입장 유지" : "점수 수정"}): ${entry.position}`);
      L.push(`  - 반박: ${entry.rebuttal}`);
      for (const c of entry.concessions) L.push(`  - 인정: ${c}`);
      for (const sc of entry.scoreChanges) {
        L.push(`  - ${CRITERION_LABELS[sc.criterion]} ${sc.from}→${sc.to} [${SCORE_CHANGE_BASIS_LABELS[sc.basis]}] ${sc.rationale}`);
      }
    }
  } else {
    L.push("", `**교차 토론**: 토론 대상 아님 (심사위원 평가 일치)`);
  }
  L.push("", `**개선 (v2)**`);
  for (const c of v2.changelog) L.push(`- ${c.change} ← ${c.addresses}`);
  for (const rj of v2.rejectedFeedback) L.push(`- 수용하지 않음: "${rj.feedback}" — ${rj.reason}`);
  L.push("");

  L.push(`#### MVP 개발 계획`, "");
  L.push(`핵심 기능: ${v2.mvp.join(", ")}`, "");
  L.push(`| 주차 | 목표 | 산출물 |`, `|---:|---|---|`);
  for (const s of [...v2.mvpPlan].sort((a, b) => a.week - b.week)) {
    L.push(`| ${s.week} | ${esc(s.goal)} | ${esc(s.deliverables.join(", "))} |`);
  }
  return L;
}

export function validateReport(report: string, ranking: RankingFile): string[] {
  const errors: string[] = [];
  for (const s of REQUIRED_REPORT_SECTIONS) if (!report.includes(s)) errors.push(`report.md에 "${s}" 섹션이 없습니다`);
  for (const id of ranking.top) if (!report.includes(id)) errors.push(`report.md에 TOP 아이디어 ${id}가 없습니다`);
  if (ranking.top.length !== Math.min(TOP_N, ranking.ranking.length)) errors.push(`TOP ${TOP_N} 선정 개수가 맞지 않습니다`);
  return errors;
}
