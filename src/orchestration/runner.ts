import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SCORING, GENERATOR_IDS, JUDGE_IDS, type GeneratorId, type ScoringSettings } from "../domain/constants";
import {
  BlindIdeaV1Schema,
  BlindIdeaV2Schema,
  RunInputSchema,
  type ArenaConfig,
  type ArenaPhase,
  type ArenaRun,
  type BlindIdeaV1,
  type BlindIdeaV2,
  type DebateFile,
  type EvaluationFile,
  type RunInput,
} from "../domain/schemas";
import { aggregateRound, applyDebate, type AggregateFile, type DebateResolution } from "../domain/scoring";
import { AUTOMATED_PHASES, addArtifacts, markFailed, recoverFromFailure, transition } from "../domain/state-machine";
import { buildRanking, renderReport, validateReport, type RankingFile, type RankingInputs } from "../reports/generator";
import { anonymizeGenerations, blindRevision, detectAuthorLeaks, type MappingFile } from "./anonymizer";
import { rel, runPaths, type RunPaths } from "./paths";
import {
  ImmutableArtifactError,
  acquireLock,
  appendEvent,
  ensureDir,
  loadState,
  readJsonFile,
  saveState,
  writeJsonOnce,
  writeTextOnce,
} from "./persistence";
import {
  Collector,
  validateDebates,
  validateEvaluations,
  validateGenerations,
  validateInput,
  validateRevisions,
  type DebateAgenda,
  type ValidationResult,
} from "./validator";

/**
 * 오케스트레이터. 상태 파일을 바꾸는 유일한 주체다(Team Lead만 CLI로 호출).
 *
 * 각 단계는 세 훅으로 정의한다.
 *   enter    — 단계에 들어갈 때 오케스트레이터가 준비할 파일(익명 패키지, 토론 안건, 피드백 등)
 *   check    — 단계를 끝내기 위한 산출물 검증. 실패하면 전이를 중단(BLOCKED)
 *   complete — 검증된 산출물로 파생 파일(집계 등)을 만들고 다음 단계를 결정
 * 모든 파일 쓰기는 write-once라서 enter/complete를 재실행해도 결과가 같다.
 */

export interface RunnerOptions {
  runsDir: string;
  now?: () => Date;
}

export interface AdvanceOutcome {
  status: "advanced" | "blocked" | "failed" | "noop";
  run: ArenaRun;
  transitions: { from: ArenaPhase; to: ArenaPhase }[];
  errors: string[];
  warnings: string[];
}

export interface FeedbackPackage {
  generatorId: GeneratorId;
  instructions: string[];
  ideas: {
    ideaId: string;
    original: BlindIdeaV1;
    postDebateScore: number;
    judges: {
      judgeId: string;
      postDebateTotal: number;
      scores: Record<string, { initial: number; postDebate: number; rationale: string }>;
      strengths: string[];
      weaknesses: string[];
      risks: string[];
      criticalIssues: string[];
      hypotheses: string[];
      summary: string;
    }[];
    debate: { judgeId: string; position: string; rebuttal: string; concessions: string[]; stance: string }[];
  }[];
}

interface Ctx {
  paths: RunPaths;
  run: ArenaRun;
  produced: string[];
  warnings: string[];
}

interface PhaseHandler {
  enter?: (ctx: Ctx) => void;
  check: (ctx: Ctx) => ValidationResult<unknown>;
  complete: (ctx: Ctx) => ArenaPhase;
}

const ok = (): ValidationResult => ({ ok: true, errors: [], warnings: [] });

function settingsOf(run: ArenaRun): ScoringSettings {
  return run.config.scoring;
}

function write(ctx: Ctx, path: string, data: unknown): void {
  writeJsonOnce(path, data);
  ctx.produced.push(rel(ctx.paths, path));
}

function record(ctx: Ctx, ...paths: string[]): void {
  ctx.produced.push(...paths.map((p) => rel(ctx.paths, p)));
}

/** 앞 단계에서 이미 검증된 데이터를 다시 읽는다. 여기서 실패하면 파일이 사후에 바뀐 것이므로 예외. */
function mustValid<T>(result: ValidationResult<T>, what: string): T {
  if (!result.ok || result.data === undefined) {
    throw new Error(`${what} 재검증 실패(완료된 단계의 파일이 변경되었을 수 있음): ${result.errors.join("; ")}`);
  }
  return result.data;
}

// ─── 데이터 로더 ──────────────────────────────────────────────────

const loadInput = (p: RunPaths): RunInput => RunInputSchema.parse(readJsonFile(p.input));
const loadMapping = (p: RunPaths): MappingFile => readJsonFile(p.mapping) as MappingFile;
const loadAggregate = (p: RunPaths, round: number): AggregateFile => readJsonFile(p.aggregate(round)) as AggregateFile;
const loadAgenda = (p: RunPaths): DebateAgenda => readJsonFile(p.debateAgenda) as DebateAgenda;
const loadResolution = (p: RunPaths): DebateResolution | undefined =>
  existsSync(p.debateResolution) ? (readJsonFile(p.debateResolution) as DebateResolution) : undefined;

function ideaIds(p: RunPaths): string[] {
  return loadMapping(p).entries.map((e) => e.ideaId).sort();
}

function loadBlindV1(p: RunPaths): BlindIdeaV1[] {
  return ideaIds(p).map((id) => BlindIdeaV1Schema.parse(readJsonFile(p.blindIdea(1, id))));
}

function loadBlindV2(p: RunPaths): BlindIdeaV2[] {
  return ideaIds(p).map((id) => BlindIdeaV2Schema.parse(readJsonFile(p.blindIdea(2, id))));
}

function loadRound1(p: RunPaths): EvaluationFile[] {
  return mustValid(validateEvaluations(p, 1, ideaIds(p)), "1차 평가");
}

function loadDebates(p: RunPaths): DebateFile[] {
  if (!existsSync(p.debateAgenda)) return [];
  return mustValid(validateDebates(p, loadAgenda(p), loadRound1(p)), "토론");
}

// ─── 단계별 핸들러 ────────────────────────────────────────────────

const HANDLERS: Partial<Record<ArenaPhase, PhaseHandler>> = {
  CREATED: {
    check: (ctx) => validateInput(ctx.paths),
    complete: (ctx) => {
      record(ctx, ctx.paths.input);
      return "GENERATING";
    },
  },

  GENERATING: {
    check: (ctx) => validateGenerations(ctx.paths, ctx.run.config),
    complete: (ctx) => {
      record(ctx, ...GENERATOR_IDS.map((g) => ctx.paths.generation(g)));
      return "BLINDING";
    },
  },

  BLINDING: {
    enter: (ctx) => {
      const generations = mustValid(validateGenerations(ctx.paths, ctx.run.config), "생성 결과");
      const { blindIdeas, mapping } = anonymizeGenerations(generations, ctx.run.runId);
      write(ctx, ctx.paths.mapping, mapping);
      for (const idea of blindIdeas) {
        const leaks = detectAuthorLeaks(idea);
        if (leaks.length) ctx.warnings.push(`${idea.ideaId}: 익명성 경고 — 본문에 "${leaks.join(", ")}" 포함`);
        write(ctx, ctx.paths.blindIdea(1, idea.ideaId), idea);
      }
    },
    check: (ctx) => {
      const c = new Collector(ctx.paths);
      if (!existsSync(ctx.paths.mapping)) {
        c.error("누락: private/mapping.json");
        return c.result();
      }
      const ids = ideaIds(ctx.paths);
      const expected = ctx.run.config.generatorCount * ctx.run.config.ideasPerGenerator;
      if (ids.length !== expected) c.error(`익명 아이디어가 ${expected}개여야 합니다 (현재 ${ids.length}개)`);
      for (const id of ids) c.load(ctx.paths.blindIdea(1, id), BlindIdeaV1Schema);
      return c.result();
    },
    complete: () => "SCORING",
  },

  SCORING: {
    check: (ctx) => validateEvaluations(ctx.paths, 1, ideaIds(ctx.paths)),
    complete: (ctx) => {
      const files = loadRound1(ctx.paths);
      const agg = aggregateRound(1, 1, ideaIds(ctx.paths), files, settingsOf(ctx.run));
      record(ctx, ...JUDGE_IDS.map((j) => ctx.paths.evaluation(1, j)));
      write(ctx, ctx.paths.aggregate(1), agg);
      return agg.disagreements.length > 0 && ctx.run.config.maxDebateRounds > 0 ? "DEBATING" : "REVISING";
    },
  },

  DEBATING: {
    enter: (ctx) => {
      const agg = loadAggregate(ctx.paths, 1);
      const agenda: DebateAgenda = {
        round: 1,
        targets: agg.disagreements.map((id) => {
          const idea = agg.ideas.find((i) => i.ideaId === id);
          return { ideaId: id, totalGap: idea?.totalGap ?? 0, reasons: idea?.disagreementReasons ?? [] };
        }),
      };
      write(ctx, ctx.paths.debateAgenda, agenda);
    },
    check: (ctx) => validateDebates(ctx.paths, loadAgenda(ctx.paths), loadRound1(ctx.paths)),
    complete: (ctx) => {
      const debates = loadDebates(ctx.paths);
      const resolution = applyDebate(loadAggregate(ctx.paths, 1), debates, settingsOf(ctx.run));
      record(ctx, ...JUDGE_IDS.map((j) => ctx.paths.debate(j)));
      write(ctx, ctx.paths.debateResolution, resolution);
      return "REVISING";
    },
  },

  REVISING: {
    enter: (ctx) => {
      for (const g of GENERATOR_IDS) write(ctx, ctx.paths.feedback(g), buildFeedback(ctx.paths, g));
    },
    check: (ctx) => validateRevisions(ctx.paths, loadMapping(ctx.paths)),
    complete: (ctx) => {
      record(ctx, ...GENERATOR_IDS.map((g) => ctx.paths.revision(g)));
      return "RESCORING";
    },
  },

  RESCORING: {
    enter: (ctx) => {
      const files = mustValid(validateRevisions(ctx.paths, loadMapping(ctx.paths)), "개선안");
      for (const f of files) {
        for (const entry of f.revisions) write(ctx, ctx.paths.blindIdea(2, entry.ideaId), blindRevision(entry));
      }
    },
    check: (ctx) => validateEvaluations(ctx.paths, 2, ideaIds(ctx.paths)),
    complete: (ctx) => {
      const files = mustValid(validateEvaluations(ctx.paths, 2, ideaIds(ctx.paths)), "재평가");
      record(ctx, ...JUDGE_IDS.map((j) => ctx.paths.evaluation(2, j)));
      write(ctx, ctx.paths.aggregate(2), aggregateRound(2, 2, ideaIds(ctx.paths), files, settingsOf(ctx.run)));
      return "FINALIZING";
    },
  },

  FINALIZING: {
    enter: (ctx) => {
      const inputs = gatherRankingInputs(ctx.paths);
      const ranking = buildRanking(inputs);
      write(ctx, ctx.paths.ranking, ranking);
      writeTextOnce(ctx.paths.report, renderReport(inputs, ranking));
      record(ctx, ctx.paths.report);
    },
    check: (ctx) => {
      const c = new Collector(ctx.paths);
      if (!existsSync(ctx.paths.ranking)) c.error("누락: final/ranking.json");
      if (!existsSync(ctx.paths.report)) c.error("누락: final/report.md");
      if (c.errors.length) return c.result();
      const ranking = readJsonFile(ctx.paths.ranking) as RankingFile;
      for (const e of validateReport(readFileSync(ctx.paths.report, "utf8"), ranking)) c.error(e);
      return c.result();
    },
    complete: () => "COMPLETED",
  },
};

function buildFeedback(p: RunPaths, g: GeneratorId): FeedbackPackage {
  const mapping = loadMapping(p);
  const v1 = loadBlindV1(p);
  const round1 = loadRound1(p);
  const debates = loadDebates(p);
  const post = loadResolution(p)?.postDebate ?? loadAggregate(p, 1);

  const ideas = mapping.entries
    .filter((e) => e.generatorId === g)
    .sort((a, b) => a.index - b.index)
    .map((e) => {
      const original = v1.find((i) => i.ideaId === e.ideaId);
      const agg = post.ideas.find((i) => i.ideaId === e.ideaId);
      if (!original || !agg) throw new Error(`${e.ideaId} 피드백 데이터가 없습니다`);
      return {
        ideaId: e.ideaId,
        original,
        postDebateScore: agg.score,
        judges: round1.map((f) => {
          const ev = f.evaluations.find((x) => x.ideaId === e.ideaId);
          const after = agg.judges.find((j) => j.judgeId === f.judgeId);
          if (!ev || !after) throw new Error(`${f.judgeId}의 ${e.ideaId} 평가가 없습니다`);
          const scores = Object.fromEntries(
            Object.entries(ev.scores).map(([criterion, s]) => [
              criterion,
              { initial: s.score, postDebate: after.scores[criterion as keyof typeof after.scores], rationale: s.rationale },
            ]),
          );
          return {
            judgeId: f.judgeId,
            postDebateTotal: after.total,
            scores,
            strengths: ev.strengths,
            weaknesses: ev.weaknesses,
            risks: ev.risks,
            criticalIssues: ev.criticalIssues,
            hypotheses: ev.hypotheses,
            summary: ev.summary,
          };
        }),
        debate: debates.flatMap((d) =>
          d.entries
            .filter((x) => x.ideaId === e.ideaId)
            .map((x) => ({ judgeId: d.judgeId, position: x.position, rebuttal: x.rebuttal, concessions: x.concessions, stance: x.stance })),
        ),
      };
    });

  return {
    generatorId: g,
    instructions: [
      "각 아이디어마다 개선본(version 2)을 작성한다. 원본은 수정하지 않는다.",
      "타당한 피드백은 반영하고 changelog에 어떤 피드백에 대응했는지 적는다.",
      "동의하지 않는 피드백은 무조건 수용하지 말고 rejectedFeedback에 근거와 함께 반박한다. 자신의 관점을 유지하라.",
      "mvpPlan에 주 단위 개발 계획을 넣는다. 주제의 팀 규모·기간 제약을 지켜야 한다.",
      "본문에 자신의 에이전트 이름이나 역할을 쓰지 않는다(익명 재평가).",
    ],
    ideas,
  };
}

function gatherRankingInputs(p: RunPaths): RankingInputs {
  return {
    input: loadInput(p),
    mapping: loadMapping(p),
    v1: loadBlindV1(p),
    v2: loadBlindV2(p),
    round1: loadAggregate(p, 1),
    resolution: loadResolution(p),
    round2: loadAggregate(p, 2),
    round1Evaluations: loadRound1(p),
    round2Evaluations: mustValid(validateEvaluations(p, 2, ideaIds(p)), "재평가"),
    debates: loadDebates(p),
  };
}

// ─── Runner ──────────────────────────────────────────────────────

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function newRunId(now: Date): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${d}-${t}-${randomBytes(2).toString("hex")}`;
}

export function defaultConfig(): ArenaConfig {
  return {
    generatorCount: 3,
    ideasPerGenerator: 2,
    judgeCount: 2,
    maxDebateRounds: 1,
    maxRevisionRounds: 1,
    scoring: { ...DEFAULT_SCORING, weights: { ...DEFAULT_SCORING.weights } },
  };
}

export class RunNotFoundError extends Error {
  override name = "RunNotFoundError";
}

export class ArenaRunner {
  readonly runsDir: string;
  private readonly now: () => Date;

  constructor(opts: RunnerOptions) {
    this.runsDir = resolve(opts.runsDir);
    this.now = opts.now ?? (() => new Date());
  }

  paths(runId: string): RunPaths {
    if (!/^[\w-][\w.-]*$/.test(runId) || runId.includes("..")) throw new RunNotFoundError(`잘못된 실행 ID: ${runId}`);
    const dir = join(this.runsDir, runId);
    if (!existsSync(join(dir, "state.json"))) throw new RunNotFoundError(`실행을 찾을 수 없습니다: ${runId} (${this.runsDir})`);
    return runPaths(dir);
  }

  create(topic: string, constraints: string[] = []): ArenaRun {
    const now = this.now();
    const runId = newRunId(now);
    const dir = join(this.runsDir, runId);
    if (existsSync(dir)) throw new Error(`이미 존재하는 실행 ID: ${runId}`);
    ensureDir(dir);
    const paths = runPaths(dir);
    for (const sub of ["private", "blind", "evaluations", "debates", "revisions", "final"]) ensureDir(join(dir, sub));

    const ts = now.toISOString();
    const input: RunInput = RunInputSchema.parse({
      runId,
      topic,
      constraints: constraints.map((c) => c.trim()).filter(Boolean),
      createdAt: ts,
    });
    writeJsonOnce(paths.input, input);

    const run: ArenaRun = {
      runId,
      topic: input.topic,
      constraints: input.constraints,
      phase: "CREATED",
      createdAt: ts,
      updatedAt: ts,
      config: defaultConfig(),
      artifacts: {},
    };
    saveState(paths, run);
    appendEvent(paths, { ts, type: "RUN_CREATED", phase: "CREATED", details: { topic: input.topic, constraints: input.constraints } });
    return run;
  }

  load(runId: string): ArenaRun {
    return loadState(this.paths(runId));
  }

  list(): ArenaRun[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.runsDir, d.name, "state.json")))
      .map((d) => loadState(runPaths(join(this.runsDir, d.name))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 현재 단계의 산출물을 검증만 한다(파일·상태 변경 없음). */
  check(runId: string): ValidationResult<unknown> {
    const paths = this.paths(runId);
    const run = loadState(paths);
    const handler = HANDLERS[run.phase];
    if (!handler) return { ok: false, errors: [`${run.phase} 단계에는 검증할 산출물이 없습니다`], warnings: [] };
    return handler.check({ paths, run, produced: [], warnings: [] });
  }

  advance(runId: string): AdvanceOutcome {
    const paths = this.paths(runId);
    const release = acquireLock(paths);
    try {
      const run = loadState(paths);
      if (run.phase === "COMPLETED") return { status: "noop", run, transitions: [], errors: [], warnings: [] };
      if (run.phase === "FAILED") {
        return {
          status: "failed",
          run,
          transitions: [],
          errors: [`실행이 FAILED 상태입니다(${run.error?.phase}: ${run.error?.message}). 원인을 확인한 뒤 retry를 실행하세요.`],
          warnings: [],
        };
      }
      return this.drive(paths, run, false);
    } finally {
      release();
    }
  }

  /** FAILED 상태에서 실패 단계로 복구하고, 그 단계의 입력을 다시 준비·검증한 뒤 진행한다. */
  retry(runId: string, opts: { force?: boolean } = {}): AdvanceOutcome {
    const paths = this.paths(runId);
    const release = acquireLock(paths);
    try {
      let run = loadState(paths);
      if (run.phase !== "FAILED" || !run.error) {
        return { status: "noop", run, transitions: [], errors: [`FAILED 상태가 아닙니다 (현재 ${run.phase}). advance를 사용하세요.`], warnings: [] };
      }
      if (!run.error.retryable && !opts.force) {
        return {
          status: "failed",
          run,
          transitions: [],
          errors: [`재시도 불가로 표시된 오류입니다: ${run.error.message}. 파일을 직접 확인·정리한 뒤 --force로 재시도하세요.`],
          warnings: [],
        };
      }
      const failedPhase = run.error.phase;
      run = recoverFromFailure(run, this.now());
      saveState(paths, run);
      appendEvent(paths, { ts: run.updatedAt, type: "RUN_RECOVERED", from: "FAILED", to: failedPhase });
      return this.drive(paths, run, true);
    } finally {
      release();
    }
  }

  private fail(paths: RunPaths, run: ArenaRun, err: unknown, outcome: Omit<AdvanceOutcome, "status" | "run">): AdvanceOutcome {
    const message = err instanceof Error ? err.message : String(err);
    const failed = markFailed(run, { phase: run.phase, message, retryable: !(err instanceof ImmutableArtifactError) }, this.now());
    saveState(paths, failed);
    appendEvent(paths, { ts: failed.updatedAt, type: "PHASE_FAILED", phase: run.phase, message });
    return { status: "failed", run: failed, ...outcome, errors: [...outcome.errors, message] };
  }

  private drive(paths: RunPaths, start: ArenaRun, reenter: boolean): AdvanceOutcome {
    let run = start;
    const transitions: AdvanceOutcome["transitions"] = [];
    const warnings: string[] = [];
    const flushWarnings = (phase: ArenaPhase, list: string[]) => {
      for (const w of list) appendEvent(paths, { ts: this.now().toISOString(), type: "WARNING", phase, message: w });
      warnings.push(...list);
    };

    // 복구 직후: 실패했던 단계의 준비 작업을 다시 수행(write-once라 이미 있는 파일은 그대로)
    if (reenter) {
      try {
        run = this.enter(paths, run, flushWarnings);
      } catch (err) {
        return this.fail(paths, run, err, { transitions, errors: [], warnings });
      }
    }

    for (;;) {
      const phase = run.phase;
      const handler = HANDLERS[phase];
      if (!handler) return { status: "advanced", run, transitions, errors: [], warnings };

      const ctx: Ctx = { paths, run, produced: [], warnings: [] };
      try {
        const v = handler.check(ctx);
        flushWarnings(phase, v.warnings);
        if (!v.ok) {
          if (AUTOMATED_PHASES.has(phase)) throw new Error(`오케스트레이터 산출물 검증 실패: ${v.errors.join("; ")}`);
          appendEvent(paths, { ts: this.now().toISOString(), type: "ADVANCE_BLOCKED", phase, details: v.errors });
          return { status: transitions.length ? "advanced" : "blocked", run, transitions, errors: v.errors, warnings };
        }

        const next = handler.complete(ctx);
        flushWarnings(phase, ctx.warnings);
        run = addArtifacts(run, phase, ctx.produced);
        run = transition(run, next, this.now());
        saveState(paths, run);
        appendEvent(paths, { ts: run.updatedAt, type: "PHASE_TRANSITION", from: phase, to: next, details: { artifacts: ctx.produced } });
        transitions.push({ from: phase, to: next });

        run = this.enter(paths, run, flushWarnings);
      } catch (err) {
        return this.fail(paths, run, err, { transitions, errors: [], warnings });
      }

      // 사람이(에이전트가) 작업해야 하는 단계에 들어가면 멈춘다
      if (!AUTOMATED_PHASES.has(run.phase)) return { status: "advanced", run, transitions, errors: [], warnings };
    }
  }

  private enter(paths: RunPaths, run: ArenaRun, flushWarnings: (phase: ArenaPhase, w: string[]) => void): ArenaRun {
    const enter = HANDLERS[run.phase]?.enter;
    if (!enter) return run;
    const ctx: Ctx = { paths, run, produced: [], warnings: [] };
    enter(ctx);
    flushWarnings(run.phase, ctx.warnings);
    const updated = addArtifacts(run, run.phase, ctx.produced);
    if (updated !== run) {
      saveState(paths, updated);
      appendEvent(paths, { ts: this.now().toISOString(), type: "ARTIFACT_WRITTEN", phase: run.phase, details: ctx.produced });
    }
    return updated;
  }
}
