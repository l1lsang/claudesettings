import { expectedFiles, type AgentId } from "./briefs";
import { runAgentTask, type AgentTaskOptions, type AgentTaskResult } from "./agent-tasks";
import type { AdvanceOutcome, ArenaRunner } from "./runner";

/**
 * 로컬 자동 실행(CLI `auto`). Team Lead 프로토콜과 같은 순서를 코드로 수행한다:
 *   단계 담당자 병렬 작업 → advance → 전이 중단이면 해당 에이전트에게만 오류 전달 후 재작성.
 * 웹 앱은 같은 순서를 브라우저(public/app.js)에서 /api 호출로 수행한다.
 */

export type AutopilotEvent =
  | { type: "agent-start"; agent: AgentId; phase: string }
  | { type: "agent-done"; result: AgentTaskResult }
  | { type: "advance"; outcome: AdvanceOutcome };

export interface AutopilotOptions extends AgentTaskOptions {
  /** 같은 단계에서 전이 중단 후 다시 쓰게 하는 최대 횟수 (기본 2) */
  maxBlockedRounds?: number;
  onEvent?: (e: AutopilotEvent) => void;
}

export async function runToCompletion(runner: ArenaRunner, runId: string, opts: AutopilotOptions): Promise<AdvanceOutcome> {
  const maxBlocked = opts.maxBlockedRounds ?? 2;
  let blocked = 0;
  let hints = new Map<AgentId, string[]>();

  for (;;) {
    const run = runner.load(runId);
    if (run.phase === "FAILED") return runner.advance(runId); // 실패 상태를 그대로 보고
    if (run.phase === "COMPLETED") return { status: "noop", run, transitions: [], errors: [], warnings: [] };

    const paths = runner.paths(runId);
    const pending = expectedFiles(run, paths).filter(
      (f): f is typeof f & { owner: AgentId } => f.owner !== "orchestrator" && (!f.exists || hints.has(f.owner)),
    );
    await Promise.all(
      pending.map(async (f) => {
        opts.onEvent?.({ type: "agent-start", agent: f.owner, phase: run.phase });
        const result = await runAgentTask(runner, runId, f.owner, { ...opts, hint: hints.get(f.owner) });
        opts.onEvent?.({ type: "agent-done", result });
      }),
    );
    hints = new Map();

    const outcome = runner.advance(runId);
    opts.onEvent?.({ type: "advance", outcome });
    if (outcome.status === "failed") return outcome;
    if (outcome.status !== "blocked") {
      blocked = 0;
      continue;
    }

    if (++blocked > maxBlocked) return outcome;
    for (const f of expectedFiles(outcome.run, paths)) {
      if (f.owner === "orchestrator") continue;
      const errs = outcome.errors.filter((e) => e.includes(f.path));
      if (errs.length) hints.set(f.owner, errs);
    }
    if (hints.size === 0) return outcome; // 에이전트가 고칠 수 없는 문제
  }
}
