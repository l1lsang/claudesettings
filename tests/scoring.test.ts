import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING } from "../src/domain/constants";
import { aggregateIdea, applyDebate, buildAggregateFile, judgeTotal, rankAggregates, type ScoreVector } from "../src/domain/scoring";

const v = (pv: number, o: number, f: number, m: number, d: number): ScoreVector => ({
  problemValue: pv,
  originality: o,
  feasibility: f,
  mvpTestability: m,
  differentiation: d,
});

describe("judgeTotal", () => {
  it("만점은 100, 0점은 0", () => {
    expect(judgeTotal(v(5, 5, 5, 5, 5), DEFAULT_SCORING)).toBe(100);
    expect(judgeTotal(v(0, 0, 0, 0, 0), DEFAULT_SCORING)).toBe(0);
  });

  it("가중치 25/20/20/20/15를 적용한다", () => {
    // 25*4/5 + 20*3/5 + 20*2/5 + 20*5/5 + 15*1/5 = 20 + 12 + 8 + 20 + 3
    expect(judgeTotal(v(4, 3, 2, 5, 1), DEFAULT_SCORING)).toBe(63);
  });

  it("가중치 합계가 100이 아니면 거부한다", () => {
    expect(() => judgeTotal(v(1, 1, 1, 1, 1), { ...DEFAULT_SCORING, weights: v(10, 10, 10, 10, 10) })).toThrow();
  });
});

describe("aggregateIdea — 토론 대상 판정", () => {
  const agg = (a: ScoreVector, b: ScoreVector, critical: string[] = []) =>
    aggregateIdea(
      "IDEA-001",
      1,
      [
        { judgeId: "feasibility", scores: a, criticalIssues: critical },
        { judgeId: "innovation", scores: b, criticalIssues: [] },
      ],
      DEFAULT_SCORING,
    );

  it("점수는 두 심사위원 가중 점수의 평균", () => {
    const r = agg(v(5, 5, 5, 5, 5), v(3, 3, 3, 3, 3));
    expect(r.score).toBe(80);
    expect(r.totalGap).toBe(40);
  });

  it("평가가 일치하면 토론 사유가 없다", () => {
    expect(agg(v(3, 3, 3, 3, 3), v(4, 3, 3, 3, 3)).disagreementReasons).toEqual([]);
  });

  it("세부 항목 차이 2점 이상이면 토론 대상", () => {
    const r = agg(v(3, 3, 3, 3, 3), v(3, 3, 5, 3, 3));
    expect(r.totalGap).toBe(8);
    expect(r.disagreementReasons).toEqual([{ type: "CRITERION_GAP", criterion: "feasibility", gap: 2 }]);
  });

  it("총점 차이 15점 이상이면 토론 대상 (경계값 포함)", () => {
    // 각 항목 1점씩 차이 → 25/5+20/5*3+15/5 = 5+12+3 = 20
    const r = agg(v(3, 3, 3, 3, 3), v(4, 4, 4, 4, 4));
    expect(r.totalGap).toBe(20);
    expect(r.disagreementReasons.map((x) => x.type)).toEqual(["TOTAL_GAP"]);

    const atThreshold = aggregateIdea(
      "IDEA-002",
      1,
      [
        { judgeId: "feasibility", scores: v(3, 3, 3, 3, 3), criticalIssues: [] },
        { judgeId: "innovation", scores: v(4, 4, 4, 4, 4), criticalIssues: [] },
      ],
      { ...DEFAULT_SCORING, totalGapThreshold: 20 },
    );
    expect(atThreshold.disagreementReasons.some((x) => x.type === "TOTAL_GAP")).toBe(true);
  });

  it("중대한 이슈가 하나라도 있으면 토론 대상", () => {
    const r = agg(v(3, 3, 3, 3, 3), v(3, 3, 3, 3, 3), ["핵심 API 사용 불가 가능성"]);
    expect(r.disagreementReasons).toEqual([{ type: "CRITICAL_ISSUE", judgeId: "feasibility", issue: "핵심 API 사용 불가 가능성" }]);
  });
});

describe("applyDebate", () => {
  it("점수 변경을 반영하고 근거 유형과 미해결 불일치를 기록한다", () => {
    const ideas = [
      aggregateIdea(
        "IDEA-001",
        1,
        [
          { judgeId: "feasibility", scores: v(3, 3, 1, 3, 3), criticalIssues: [] },
          { judgeId: "innovation", scores: v(3, 3, 4, 3, 3), criticalIssues: [] },
        ],
        DEFAULT_SCORING,
      ),
      aggregateIdea(
        "IDEA-002",
        1,
        [
          { judgeId: "feasibility", scores: v(2, 2, 2, 2, 2), criticalIssues: [] },
          { judgeId: "innovation", scores: v(5, 5, 5, 5, 5), criticalIssues: [] },
        ],
        DEFAULT_SCORING,
      ),
    ];
    const before = buildAggregateFile(1, 1, ideas, DEFAULT_SCORING);
    expect(before.disagreements).toEqual(["IDEA-002", "IDEA-001"]); // 격차 큰 순

    const res = applyDebate(
      before,
      [
        {
          judgeId: "feasibility",
          round: 1,
          entries: [
            {
              ideaId: "IDEA-001",
              position: "p",
              rebuttal: "r",
              concessions: [],
              scoreChanges: [{ criterion: "feasibility", from: 1, to: 3, basis: "PEER_PERSUASION", rationale: "상대가 제시한 기존 오픈소스 활용 경로가 타당" }],
              stance: "REVISE",
            },
            { ideaId: "IDEA-002", position: "p", rebuttal: "r", concessions: [], scoreChanges: [], stance: "MAINTAIN" },
          ],
        },
        {
          judgeId: "innovation",
          round: 1,
          entries: [
            { ideaId: "IDEA-001", position: "p", rebuttal: "r", concessions: [], scoreChanges: [], stance: "MAINTAIN" },
            { ideaId: "IDEA-002", position: "p", rebuttal: "r", concessions: [], scoreChanges: [], stance: "MAINTAIN" },
          ],
        },
      ],
      DEFAULT_SCORING,
    );

    expect(res.changes).toHaveLength(1);
    expect(res.basisCounts).toEqual({ NEW_ARGUMENT: 0, PEER_PERSUASION: 1, ERROR_CORRECTION: 0 });
    expect(res.postDebate.ideas.find((i) => i.ideaId === "IDEA-001")?.disagreementReasons).toEqual([]);
    expect(res.unresolved).toEqual(["IDEA-002"]);
    // 원본 집계는 변경되지 않는다
    expect(before.ideas[0]?.judges[0]?.scores.feasibility).toBe(1);
  });
});

describe("rankAggregates", () => {
  it("동점이면 심사 격차가 작은 아이디어가 앞선다", () => {
    const a = aggregateIdea("IDEA-001", 2, [
      { judgeId: "feasibility", scores: v(5, 5, 5, 5, 5), criticalIssues: [] },
      { judgeId: "innovation", scores: v(3, 3, 3, 3, 3), criticalIssues: [] },
    ], DEFAULT_SCORING);
    const b = aggregateIdea("IDEA-002", 2, [
      { judgeId: "feasibility", scores: v(4, 4, 4, 4, 4), criticalIssues: [] },
      { judgeId: "innovation", scores: v(4, 4, 4, 4, 4), criticalIssues: [] },
    ], DEFAULT_SCORING);
    expect(a.score).toBe(b.score);
    expect(rankAggregates([a, b]).map((x) => x.ideaId)).toEqual(["IDEA-002", "IDEA-001"]);
  });
});
