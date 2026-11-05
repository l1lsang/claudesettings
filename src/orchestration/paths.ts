import { join, relative, sep } from "node:path";
import type { GeneratorId, JudgeId } from "../domain/constants";

/**
 * 실행 디렉터리 레이아웃. 모든 파일 경로는 여기서만 만든다.
 *
 * 접근 규칙(MVP는 운영 규칙으로 보장):
 *   private/, revisions/  — 심사위원 접근 금지
 *   blind/, evaluations/, debates/ — 심사위원이 읽을 수 있는 영역
 */
export function runPaths(runDir: string) {
  return {
    runDir,
    input: join(runDir, "input.json"),
    state: join(runDir, "state.json"),
    events: join(runDir, "events.jsonl"),
    lock: join(runDir, ".lock"),

    generation: (g: GeneratorId) => join(runDir, "private", "generations", `${g}.json`),
    mapping: join(runDir, "private", "mapping.json"),

    blindDir: (version: number) => join(runDir, "blind", `v${version}`),
    blindIdea: (version: number, ideaId: string) => join(runDir, "blind", `v${version}`, `${ideaId}.json`),

    evaluation: (round: number, judge: JudgeId) => join(runDir, "evaluations", `round-${round}`, `${judge}.json`),
    aggregate: (round: number) => join(runDir, "evaluations", `round-${round}`, "aggregate.json"),

    debateAgenda: join(runDir, "debates", "round-1", "agenda.json"),
    debate: (judge: JudgeId) => join(runDir, "debates", "round-1", `${judge}.json`),
    debateResolution: join(runDir, "debates", "round-1", "resolution.json"),

    feedback: (g: GeneratorId) => join(runDir, "revisions", g, "feedback.json"),
    revision: (g: GeneratorId) => join(runDir, "revisions", g, "revised.json"),

    ranking: join(runDir, "final", "ranking.json"),
    report: join(runDir, "final", "report.md"),
  };
}

export type RunPaths = ReturnType<typeof runPaths>;

/** 실행 디렉터리 기준 상대 경로(항상 / 구분자) — state.json, 브리프, 상태 출력에 사용 */
export function rel(paths: RunPaths, absolute: string): string {
  return relative(paths.runDir, absolute).split(sep).join("/");
}
