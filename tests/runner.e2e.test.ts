import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JUDGE_IDS } from "../src/domain/constants";
import type { AggregateFile, DebateResolution } from "../src/domain/scoring";
import { buildBrief } from "../src/orchestration/briefs";
import { readEvents, readJsonFile } from "../src/orchestration/persistence";
import { ArenaRunner } from "../src/orchestration/runner";
import type { RankingFile } from "../src/reports/generator";
import { ids, mapping, tempRunsDir, writeDebates, writeEvaluations, writeGenerations, writeJson, writeRevisions } from "./fixtures";

let runsDir: string;
let cleanup: () => void;
let runner: ArenaRunner;

beforeEach(() => {
  ({ dir: runsDir, cleanup } = tempRunsDir());
  let tick = Date.parse("2026-11-05T09:00:00.000Z");
  runner = new ArenaRunner({ runsDir, now: () => new Date((tick += 1000)) });
});
afterEach(() => cleanup());

function createToScoring() {
  const run = runner.create("대학생 생활 불편 해결 서비스", ["2~3명", "4주 MVP"]);
  const p = runner.paths(run.runId);
  expect(runner.advance(run.runId).run.phase).toBe("GENERATING");
  writeGenerations(p);
  const o = runner.advance(run.runId);
  // BLINDING은 자동 단계라 SCORING까지 한 번에 진행된다
  expect(o.transitions).toEqual([
    { from: "GENERATING", to: "BLINDING" },
    { from: "BLINDING", to: "SCORING" },
  ]);
  return { runId: run.runId, p };
}

describe("ArenaRunner — 전체 실행", () => {
  it("불일치 → 토론 → 개선 → 재평가 → TOP 3 보고서", () => {
    const { runId, p } = createToScoring();
    const allIds = ids(p);
    const disputed = allIds[0] as string;

    // 1차: disputed는 feasibility 항목에서 3점 차이
    writeEvaluations(p, 1, (id, j) => (id === disputed ? { feasibility: j === "feasibility" ? 1 : 4 } : {}));
    const scored = runner.advance(runId);
    expect(scored.transitions).toEqual([{ from: "SCORING", to: "DEBATING" }]);
    const agenda = readJsonFile(p.debateAgenda) as { targets: { ideaId: string }[] };
    expect(agenda.targets.map((t) => t.ideaId)).toEqual([disputed]);

    // 토론: feasibility는 일부 수용, innovation은 입장 유지
    writeDebates(p, (j, targets) =>
      targets.map((id) =>
        j === "feasibility"
          ? {
              ideaId: id,
              position: "구현 범위가 4주를 넘는다",
              rebuttal: "상대는 외부 API 의존 위험을 과소평가했다",
              concessions: ["기존 오픈소스로 일부 대체 가능"],
              scoreChanges: [{ criterion: "feasibility" as const, from: 1, to: 2, basis: "NEW_ARGUMENT" as const, rationale: "오픈소스 대체 경로를 직접 확인" }],
              stance: "REVISE" as const,
            }
          : { ideaId: id, position: "핵심 기능은 2주면 충분", rebuttal: "외부 API는 대체 가능", concessions: [], scoreChanges: [], stance: "MAINTAIN" as const },
      ),
    );
    expect(runner.advance(runId).run.phase).toBe("REVISING");
    const resolution = readJsonFile(p.debateResolution) as DebateResolution;
    expect(resolution.basisCounts.NEW_ARGUMENT).toBe(1);
    expect(resolution.unresolved).toEqual([disputed]); // 1 vs 4 → 2 vs 4, 여전히 2점 차

    // 생성자별 피드백 패키지에는 자기 아이디어만 들어 있다
    const m = mapping(p);
    const fb = readJsonFile(p.feedback("creative")) as { ideas: { ideaId: string }[] };
    expect(fb.ideas.map((i) => i.ideaId).sort()).toEqual(m.entries.filter((e) => e.generatorId === "creative").map((e) => e.ideaId).sort());

    writeRevisions(p);
    expect(runner.advance(runId).run.phase).toBe("RESCORING");
    const v2 = readJsonFile(p.blindIdea(2, disputed)) as Record<string, unknown>;
    expect(v2.version).toBe(2);
    expect(v2).not.toHaveProperty("generatorId");

    const v1Before = readFileSync(p.blindIdea(1, disputed), "utf8");

    // 재평가: 마지막 아이디어가 가장 크게 개선
    const best = allIds[allIds.length - 1] as string;
    writeEvaluations(p, 2, (id) => (id === best ? { problemValue: 5, originality: 5, feasibility: 5, mvpTestability: 5, differentiation: 5 } : { problemValue: 4 }));
    const fin = runner.advance(runId);
    expect(fin.transitions).toEqual([
      { from: "RESCORING", to: "FINALIZING" },
      { from: "FINALIZING", to: "COMPLETED" },
    ]);
    expect(fin.run.completedAt).toBeDefined();

    const ranking = readJsonFile(p.ranking) as RankingFile;
    expect(ranking.top).toHaveLength(3);
    expect(ranking.top[0]).toBe(best);
    const top = ranking.ranking[0]!;
    expect(top.finalScore).toBe(100);
    expect(top.initialScore).toBe(60);
    expect(top.delta).toBe(40);
    expect(ranking.metrics.debateTargets).toEqual([disputed]);

    // 원본은 보존된다(최초 점수와 개선 점수 모두 남음)
    expect(readFileSync(p.blindIdea(1, disputed), "utf8")).toBe(v1Before);
    expect((readJsonFile(p.aggregate(1)) as AggregateFile).round).toBe(1);
    expect((readJsonFile(p.aggregate(2)) as AggregateFile).round).toBe(2);

    const report = readFileSync(p.report, "utf8");
    for (const s of ["## 최종 순위", "## TOP 3 상세", "실패 가능성", "검증해야 할 가설", "반박과 개선 과정", "MVP 개발 계획", "## 해석 시 주의"]) {
      expect(report).toContain(s);
    }

    const events = readEvents(p);
    expect(events.filter((e) => e.type === "PHASE_TRANSITION").map((e) => e.to)).toEqual([
      "GENERATING", "BLINDING", "SCORING", "DEBATING", "REVISING", "RESCORING", "FINALIZING", "COMPLETED",
    ]);
    expect(runner.advance(runId).status).toBe("noop");
  });

  it("평가가 일치하면 토론을 건너뛴다", () => {
    const { runId, p } = createToScoring();
    writeEvaluations(p, 1);
    expect(runner.advance(runId).transitions).toEqual([{ from: "SCORING", to: "REVISING" }]);
    writeRevisions(p);
    runner.advance(runId);
    writeEvaluations(p, 2);
    expect(runner.advance(runId).run.phase).toBe("COMPLETED");
    const ranking = readJsonFile(p.ranking) as RankingFile;
    expect(ranking.metrics.debateTargets).toEqual([]);
    expect(readFileSync(p.report, "utf8")).toContain("토론 대상 아님");
  });

  it("중대한 이슈가 있으면 점수가 같아도 토론 대상이 된다", () => {
    const { runId, p } = createToScoring();
    const target = ids(p)[2] as string;
    writeEvaluations(p, 1, undefined, (id, j) => (id === target && j === "innovation" ? ["핵심 가정 미검증"] : []));
    expect(runner.advance(runId).run.phase).toBe("DEBATING");
    expect((readJsonFile(p.debateAgenda) as { targets: { ideaId: string }[] }).targets.map((t) => t.ideaId)).toEqual([target]);
  });
});

describe("ArenaRunner — 검증과 실패 처리", () => {
  it("산출물이 없거나 잘못되면 전이를 중단하고 상태는 그대로", () => {
    const run = runner.create("주제");
    const p = runner.paths(run.runId);
    runner.advance(run.runId);
    const blocked = runner.advance(run.runId);
    expect(blocked.status).toBe("blocked");
    expect(blocked.run.phase).toBe("GENERATING");
    expect(blocked.errors.some((e) => e.includes("누락: private/generations/creative.json"))).toBe(true);

    writeGenerations(p);
    writeJson(p.generation("problem"), { generatorId: "problem", ideas: [{ title: "하나뿐" }] });
    const invalid = runner.advance(run.runId);
    expect(invalid.status).toBe("blocked");
    expect(invalid.errors.some((e) => e.includes("problem.json"))).toBe(true);
    expect(readEvents(p).some((e) => e.type === "ADVANCE_BLOCKED")).toBe(true);
  });

  it("토론에서 from이 1차 점수와 다르면 거부", () => {
    const { runId, p } = createToScoring();
    const id = ids(p)[0] as string;
    writeEvaluations(p, 1, (x, j) => (x === id ? { originality: j === "innovation" ? 5 : 2 } : {}));
    runner.advance(runId);
    writeDebates(p, (_j, targets) =>
      targets.map((t) => ({
        ideaId: t,
        position: "p",
        rebuttal: "r",
        concessions: [],
        scoreChanges: [{ criterion: "originality" as const, from: 4, to: 3, basis: "ERROR_CORRECTION" as const, rationale: "정정" }],
        stance: "REVISE" as const,
      })),
    );
    const o = runner.advance(runId);
    expect(o.status).toBe("blocked");
    expect(o.errors.some((e) => e.includes("1차 평가 점수"))).toBe(true);
  });

  it("완료된 단계의 산출물이 바뀌어 있으면 FAILED, 원복 후 retry로 재개", () => {
    const { runId, p } = createToScoring();
    writeEvaluations(p, 1);
    // 다음 단계가 써야 할 집계 파일을 미리 다른 내용으로 만들어 충돌 유도
    writeJson(p.aggregate(1), { tampered: true });
    const o = runner.advance(runId);
    expect(o.status).toBe("failed");
    expect(o.run.phase).toBe("FAILED");
    expect(o.run.error).toMatchObject({ phase: "SCORING", retryable: false });

    expect(runner.retry(runId).status).toBe("failed"); // retryable=false → --force 필요
    rmSync(p.aggregate(1)); // Lead가 손상 파일을 확인·정리했다고 가정
    const retried = runner.retry(runId, { force: true });
    expect(retried.status).toBe("advanced");
    expect(retried.run.phase).toBe("REVISING");
    expect(readEvents(p).some((e) => e.type === "RUN_RECOVERED")).toBe(true);
  });

  it("brief는 단계와 에이전트에 맞는 지시를 낸다", () => {
    const { runId, p } = createToScoring();
    const run = runner.load(runId);
    const judgeBrief = buildBrief(run, p, "feasibility");
    expect(judgeBrief).toContain("evaluations/round-1/feasibility.json");
    expect(judgeBrief).toContain("private/");
    for (const id of ids(p)) expect(judgeBrief).toContain(id);
    expect(buildBrief(run, p, "creative")).toContain("작업은 없습니다");
    expect(JUDGE_IDS).toHaveLength(2);
  });
});
