import { existsSync, readdirSync } from "node:fs";
import { JUDGE_IDS, type JudgeId } from "../domain/constants";
import type { ArenaRun } from "../domain/schemas";
import type { AggregateFile, DebateResolution } from "../domain/scoring";
import { expectedFiles, type ExpectedFile } from "../orchestration/briefs";
import type { MappingFile } from "../orchestration/anonymizer";
import { readEvents, readJsonFile, type ArenaEvent } from "../orchestration/persistence";
import type { ArenaRunner } from "../orchestration/runner";
import type { DebateAgenda } from "../orchestration/validator";
import type { RankingFile } from "../reports/generator";

/**
 * 대시보드용 읽기 전용 데이터 묶음. 파일을 절대 쓰지 않는다.
 * 에이전트가 쓰는 중인 파일은 깨진 JSON일 수 있으므로 읽기 실패는 null + 경고로 처리한다.
 * 작성자(생성자) 정보는 실행이 COMPLETED일 때만 공개한다 — 보고서와 같은 규칙.
 */

export interface RunSummary {
  runId: string;
  topic: string;
  phase: ArenaRun["phase"];
  createdAt: string;
  updatedAt: string;
}

export interface RunBundle {
  state: ArenaRun;
  expected: ExpectedFile[];
  events: ArenaEvent[];
  authorsRevealed: boolean;
  authors: Record<string, string> | null;
  ideas: { v1: unknown[]; v2: unknown[] };
  evaluations: { round1: Partial<Record<JudgeId, unknown>>; round2: Partial<Record<JudgeId, unknown>> };
  aggregates: { round1: AggregateFile | null; round2: AggregateFile | null };
  debate: { agenda: DebateAgenda | null; entries: Partial<Record<JudgeId, unknown>>; resolution: DebateResolution | null };
  ranking: RankingFile | null;
  hasReport: boolean;
  warnings: string[];
}

export function listRuns(runner: ArenaRunner): RunSummary[] {
  return runner.list().map((r) => ({ runId: r.runId, topic: r.topic, phase: r.phase, createdAt: r.createdAt, updatedAt: r.updatedAt }));
}

export function loadRunBundle(runner: ArenaRunner, runId: string): RunBundle {
  const paths = runner.paths(runId);
  const state = runner.load(runId);
  const warnings: string[] = [];

  const read = <T>(path: string): T | null => {
    if (!existsSync(path)) return null;
    try {
      return readJsonFile(path) as T;
    } catch (err) {
      warnings.push(`${path.slice(paths.runDir.length + 1)} 읽기 실패: ${(err as Error).message}`);
      return null;
    }
  };

  const readDir = (version: 1 | 2): unknown[] => {
    const dir = paths.blindDir(version);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^IDEA-\d{3}\.json$/.test(f))
      .sort()
      .map((f) => read<unknown>(`${dir}/${f}`))
      .filter((x) => x !== null);
  };

  const byJudge = (path: (j: JudgeId) => string) => {
    const out: Partial<Record<JudgeId, unknown>> = {};
    for (const j of JUDGE_IDS) {
      const v = read<unknown>(path(j));
      if (v !== null) out[j] = v;
    }
    return out;
  };

  const authorsRevealed = state.phase === "COMPLETED";
  const mapping = authorsRevealed ? read<MappingFile>(paths.mapping) : null;

  return {
    state,
    expected: expectedFiles(state, paths),
    events: readEvents(paths).slice(-50),
    authorsRevealed,
    authors: mapping ? Object.fromEntries(mapping.entries.map((e) => [e.ideaId, e.generatorId])) : null,
    ideas: { v1: readDir(1), v2: readDir(2) },
    evaluations: { round1: byJudge((j) => paths.evaluation(1, j)), round2: byJudge((j) => paths.evaluation(2, j)) },
    aggregates: { round1: read<AggregateFile>(paths.aggregate(1)), round2: read<AggregateFile>(paths.aggregate(2)) },
    debate: {
      agenda: read<DebateAgenda>(paths.debateAgenda),
      entries: byJudge((j) => paths.debate(j)),
      resolution: read<DebateResolution>(paths.debateResolution),
    },
    ranking: read<RankingFile>(paths.ranking),
    hasReport: existsSync(paths.report),
    warnings,
  };
}
