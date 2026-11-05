import type { ArenaPhase, ArenaRun } from "./schemas";

/**
 * 상태 전이 규칙(순수 로직). 파일 검증·저장은 orchestration/runner.ts가 담당한다.
 *
 *   CREATED → GENERATING → BLINDING → SCORING ─┬─(불일치)→ DEBATING → REVISING
 *                                              └─(일치)──────────────→ REVISING
 *   REVISING → RESCORING → FINALIZING → COMPLETED
 *   (COMPLETED를 제외한 모든 단계) → FAILED → (실패한 단계로만 복구)
 */
export const TRANSITIONS: Readonly<Record<ArenaPhase, readonly ArenaPhase[]>> = {
  CREATED: ["GENERATING"],
  GENERATING: ["BLINDING"],
  BLINDING: ["SCORING"],
  SCORING: ["DEBATING", "REVISING"],
  DEBATING: ["REVISING"],
  REVISING: ["RESCORING"],
  RESCORING: ["FINALIZING"],
  FINALIZING: ["COMPLETED"],
  COMPLETED: [],
  FAILED: [],
};

/** 에이전트 없이 오케스트레이터가 바로 처리하는 단계 — advance가 멈추지 않고 통과한다 */
export const AUTOMATED_PHASES: ReadonlySet<ArenaPhase> = new Set(["BLINDING", "FINALIZING"]);

export class InvalidTransitionError extends Error {
  constructor(from: ArenaPhase, to: ArenaPhase) {
    super(`허용되지 않은 상태 전이: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: ArenaPhase, to: ArenaPhase): boolean {
  if (to === "FAILED") return from !== "COMPLETED" && from !== "FAILED";
  return TRANSITIONS[from].includes(to);
}

export function transition(run: ArenaRun, to: ArenaPhase, now: Date): ArenaRun {
  if (!canTransition(run.phase, to)) throw new InvalidTransitionError(run.phase, to);
  const ts = now.toISOString();
  const next: ArenaRun = { ...run, previousPhase: run.phase, phase: to, updatedAt: ts };
  if (to === "COMPLETED") next.completedAt = ts;
  return next;
}

export function markFailed(
  run: ArenaRun,
  error: { phase: ArenaPhase; message: string; retryable: boolean },
  now: Date,
): ArenaRun {
  if (!canTransition(run.phase, "FAILED")) throw new InvalidTransitionError(run.phase, "FAILED");
  return { ...run, previousPhase: run.phase, phase: "FAILED", updatedAt: now.toISOString(), error };
}

/** FAILED 상태에서 실패했던 단계로 되돌린다. 다른 단계로 건너뛰는 것은 허용하지 않는다. */
export function recoverFromFailure(run: ArenaRun, now: Date): ArenaRun {
  if (run.phase !== "FAILED" || !run.error) {
    throw new Error(`복구할 실패 상태가 아닙니다 (현재 ${run.phase})`);
  }
  const { error: _error, ...rest } = run;
  return { ...rest, previousPhase: "FAILED", phase: run.error.phase, updatedAt: now.toISOString() };
}

export function addArtifacts(run: ArenaRun, phase: ArenaPhase, paths: string[]): ArenaRun {
  if (paths.length === 0) return run;
  const existing = run.artifacts[phase] ?? [];
  const merged = [...existing];
  for (const p of paths) if (!merged.includes(p)) merged.push(p);
  return { ...run, artifacts: { ...run.artifacts, [phase]: merged } };
}
