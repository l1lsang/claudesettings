import { z } from "zod";
import { CRITERIA, GENERATOR_IDS, JUDGE_IDS, SCORE_CHANGE_BASES } from "./constants";

/**
 * 에이전트가 작성하는 파일은 모두 여기 정의된 스키마로 검증한다.
 * 오케스트레이터가 만드는 파생 파일은 아래 인터페이스(타입)로만 정의한다.
 */

const text = z.string().trim().min(1, "빈 문자열은 허용되지 않습니다");
const textList = z.array(text);

export const ArenaPhaseSchema = z.enum([
  "CREATED",
  "GENERATING",
  "BLINDING",
  "SCORING",
  "DEBATING",
  "REVISING",
  "RESCORING",
  "FINALIZING",
  "COMPLETED",
  "FAILED",
]);
export type ArenaPhase = z.infer<typeof ArenaPhaseSchema>;

export const GeneratorIdSchema = z.enum(GENERATOR_IDS);
export const JudgeIdSchema = z.enum(JUDGE_IDS);
export const CriterionSchema = z.enum(CRITERIA);
export const IdeaIdSchema = z.string().regex(/^IDEA-\d{3}$/, "IDEA-001 형식이어야 합니다");

// ─── 실행 입력 / 상태 ──────────────────────────────────────────────

export const RunInputSchema = z
  .object({
    runId: text,
    topic: text.max(4000),
    constraints: textList,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type RunInput = z.infer<typeof RunInputSchema>;

const WeightsSchema = z
  .object({
    problemValue: z.number().nonnegative(),
    originality: z.number().nonnegative(),
    feasibility: z.number().nonnegative(),
    mvpTestability: z.number().nonnegative(),
    differentiation: z.number().nonnegative(),
  })
  .strict();

export const ArenaConfigSchema = z
  .object({
    generatorCount: z.literal(3),
    ideasPerGenerator: z.literal(2),
    judgeCount: z.literal(2),
    maxDebateRounds: z.literal(1),
    maxRevisionRounds: z.literal(1),
    scoring: z
      .object({
        weights: WeightsSchema,
        maxCriterionScore: z.number().int().positive(),
        totalGapThreshold: z.number().nonnegative(),
        criterionGapThreshold: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type ArenaConfig = z.infer<typeof ArenaConfigSchema>;

export const ArenaRunSchema = z
  .object({
    runId: text,
    topic: text,
    constraints: textList,
    phase: ArenaPhaseSchema,
    previousPhase: ArenaPhaseSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    config: ArenaConfigSchema,
    /** 단계별로 생성·검증된 파일(실행 디렉터리 기준 상대 경로) */
    artifacts: z.record(z.string(), z.array(z.string())),
    error: z
      .object({
        phase: ArenaPhaseSchema,
        message: z.string(),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ArenaRun = z.infer<typeof ArenaRunSchema>;

// ─── 아이디어 ─────────────────────────────────────────────────────

const ideaCoreShape = {
  title: text,
  problem: text,
  targetUsers: text,
  solution: text,
  differentiation: text,
  mvp: textList.min(1, "MVP 핵심 기능을 최소 1개 적어야 합니다"),
  /** 시장 수요·경쟁·법률·기술에 관한 미검증 추론은 반드시 여기에 가설로 기록 */
  assumptions: textList.min(1, "검증되지 않은 가정을 최소 1개 적어야 합니다"),
};

/** 생성자가 Phase 1에서 작성하는 원본 아이디어 */
export const GeneratedIdeaSchema = z
  .object({
    ...ideaCoreShape,
    /** 심사위원에게 전달되지 않는 생성자 개인 메모 */
    authorNotes: z.string().optional(),
  })
  .strict();
export type GeneratedIdea = z.infer<typeof GeneratedIdeaSchema>;

export const GenerationFileSchema = z
  .object({
    generatorId: GeneratorIdSchema,
    ideas: z.array(GeneratedIdeaSchema).min(1),
  })
  .strict();
export type GenerationFile = z.infer<typeof GenerationFileSchema>;

/** 심사위원이 받는 익명화된 v1 아이디어 */
export const BlindIdeaV1Schema = z
  .object({
    ideaId: IdeaIdSchema,
    version: z.literal(1),
    ...ideaCoreShape,
  })
  .strict();
export type BlindIdeaV1 = z.infer<typeof BlindIdeaV1Schema>;

export const MvpPlanStepSchema = z
  .object({
    week: z.number().int().min(1).max(52),
    goal: text,
    deliverables: textList.min(1),
  })
  .strict();
export type MvpPlanStep = z.infer<typeof MvpPlanStepSchema>;

export const RevisedIdeaSchema = z
  .object({
    ...ideaCoreShape,
    mvpPlan: z.array(MvpPlanStepSchema).min(1, "주 단위 MVP 개발 계획이 필요합니다"),
  })
  .strict();
export type RevisedIdea = z.infer<typeof RevisedIdeaSchema>;

export const ChangeLogEntrySchema = z
  .object({
    change: text,
    /** 어떤 피드백(심사위원·항목)에 대응한 변경인지 */
    addresses: text,
  })
  .strict();

export const RejectedFeedbackSchema = z
  .object({
    feedback: text,
    reason: text,
  })
  .strict();

export const RevisionEntrySchema = z
  .object({
    ideaId: IdeaIdSchema,
    idea: RevisedIdeaSchema,
    changelog: z.array(ChangeLogEntrySchema).min(1, "변경 내역이 최소 1개 필요합니다"),
    /** 받아들이지 않은 피드백과 반박 근거 — 생성자의 관점 유지 */
    rejectedFeedback: z.array(RejectedFeedbackSchema).default([]),
  })
  .strict();
export type RevisionEntry = z.infer<typeof RevisionEntrySchema>;

export const RevisionFileSchema = z
  .object({
    generatorId: GeneratorIdSchema,
    revisions: z.array(RevisionEntrySchema).min(1),
  })
  .strict();
export type RevisionFile = z.infer<typeof RevisionFileSchema>;

/** 심사위원이 재평가 때 받는 익명화된 v2 아이디어 */
export const BlindIdeaV2Schema = z
  .object({
    ideaId: IdeaIdSchema,
    version: z.literal(2),
    ...RevisedIdeaSchema.shape,
    changelog: z.array(ChangeLogEntrySchema),
    rejectedFeedback: z.array(RejectedFeedbackSchema),
  })
  .strict();
export type BlindIdeaV2 = z.infer<typeof BlindIdeaV2Schema>;

export type BlindIdea = BlindIdeaV1 | BlindIdeaV2;

// ─── 평가 ────────────────────────────────────────────────────────

const CriterionScoreSchema = z
  .object({
    score: z.number().int().min(0).max(5),
    rationale: text,
  })
  .strict();

export const CriterionScoresSchema = z
  .object({
    problemValue: CriterionScoreSchema,
    originality: CriterionScoreSchema,
    feasibility: CriterionScoreSchema,
    mvpTestability: CriterionScoreSchema,
    differentiation: CriterionScoreSchema,
  })
  .strict();
export type CriterionScores = z.infer<typeof CriterionScoresSchema>;

export const IdeaEvaluationSchema = z
  .object({
    ideaId: IdeaIdSchema,
    version: z.union([z.literal(1), z.literal(2)]),
    scores: CriterionScoresSchema,
    strengths: textList.min(1),
    weaknesses: textList.min(1),
    /** 실패 가능성 — 이 아이디어가 실패할 수 있는 구체적 시나리오 */
    risks: textList.min(1),
    /** 중대한 기술적 장애 또는 검증되지 않은 핵심 가정. 하나라도 있으면 토론 대상 */
    criticalIssues: textList.default([]),
    /** 평가에 사용했지만 확인되지 않은 가설(시장·경쟁·법률·기술) */
    hypotheses: textList.default([]),
    summary: text,
    /** 재평가(round 2)에서 이전 평가 대비 바뀐 판단 */
    changeFromPrevious: z.string().optional(),
  })
  .strict();
export type IdeaEvaluation = z.infer<typeof IdeaEvaluationSchema>;

export const EvaluationFileSchema = z
  .object({
    judgeId: JudgeIdSchema,
    round: z.union([z.literal(1), z.literal(2)]),
    evaluations: z.array(IdeaEvaluationSchema).min(1),
  })
  .strict();
export type EvaluationFile = z.infer<typeof EvaluationFileSchema>;

// ─── 토론 ────────────────────────────────────────────────────────

export const ScoreChangeSchema = z
  .object({
    criterion: CriterionSchema,
    from: z.number().int().min(0).max(5),
    to: z.number().int().min(0).max(5),
    basis: z.enum(SCORE_CHANGE_BASES),
    rationale: text,
  })
  .strict();
export type ScoreChange = z.infer<typeof ScoreChangeSchema>;

export const DebateEntrySchema = z
  .object({
    ideaId: IdeaIdSchema,
    /** 내 평가의 핵심 근거 */
    position: text,
    /** 상대 심사위원 평가의 약점 지적 */
    rebuttal: text,
    /** 상대 논거 중 인정하는 부분 */
    concessions: textList.default([]),
    scoreChanges: z.array(ScoreChangeSchema).default([]),
    stance: z.enum(["MAINTAIN", "REVISE"]),
  })
  .strict();
export type DebateEntry = z.infer<typeof DebateEntrySchema>;

export const DebateFileSchema = z
  .object({
    judgeId: JudgeIdSchema,
    round: z.literal(1),
    entries: z.array(DebateEntrySchema),
  })
  .strict();
export type DebateFile = z.infer<typeof DebateFileSchema>;
