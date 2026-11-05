import { describe, expect, it } from "vitest";
import type { ArenaRun } from "../src/domain/schemas";
import { canTransition, markFailed, recoverFromFailure, transition } from "../src/domain/state-machine";
import { defaultConfig } from "../src/orchestration/runner";

const now = new Date("2026-11-05T00:00:00.000Z");
const base: ArenaRun = {
  runId: "r1",
  topic: "t",
  constraints: [],
  phase: "CREATED",
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  config: defaultConfig(),
  artifacts: {},
};

describe("state machine", () => {
  it("정해진 순서의 전이만 허용한다", () => {
    expect(canTransition("CREATED", "GENERATING")).toBe(true);
    expect(canTransition("CREATED", "SCORING")).toBe(false);
    expect(canTransition("SCORING", "DEBATING")).toBe(true);
    expect(canTransition("SCORING", "REVISING")).toBe(true); // 평가 일치 시 토론 생략
    expect(canTransition("DEBATING", "SCORING")).toBe(false); // 토론은 1회
    expect(canTransition("COMPLETED", "FAILED")).toBe(false);
  });

  it("허용되지 않은 전이는 예외", () => {
    expect(() => transition(base, "FINALIZING", now)).toThrow(/허용되지 않은/);
  });

  it("전이 시 previousPhase와 updatedAt을 갱신하고 COMPLETED면 completedAt 기록", () => {
    const r = transition({ ...base, phase: "FINALIZING" }, "COMPLETED", now);
    expect(r.previousPhase).toBe("FINALIZING");
    expect(r.completedAt).toBe(now.toISOString());
  });

  it("FAILED에서는 실패했던 단계로만 복구된다", () => {
    const failed = markFailed({ ...base, phase: "SCORING" }, { phase: "SCORING", message: "x", retryable: true }, now);
    expect(failed.phase).toBe("FAILED");
    expect(failed.previousPhase).toBe("SCORING");
    const recovered = recoverFromFailure(failed, now);
    expect(recovered.phase).toBe("SCORING");
    expect(recovered.error).toBeUndefined();
    expect(() => recoverFromFailure(base, now)).toThrow();
  });
});
