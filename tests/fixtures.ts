import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CRITERIA, GENERATOR_IDS, JUDGE_IDS, type Criterion, type GeneratorId, type JudgeId } from "../src/domain/constants";
import type { DebateFile, EvaluationFile, GenerationFile, RevisionFile } from "../src/domain/schemas";
import type { MappingFile } from "../src/orchestration/anonymizer";
import type { RunPaths } from "../src/orchestration/paths";
import { readJsonFile } from "../src/orchestration/persistence";

export function tempRunsDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "idea-arena-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function idea(title: string) {
  return {
    title,
    problem: `${title}가 해결하는 문제`,
    targetUsers: "대학생",
    solution: `${title} 해결 방식`,
    differentiation: "기존 대안 대비 차이",
    mvp: ["핵심 기능 A", "핵심 기능 B"],
    assumptions: ["[가설] 대학생이 주 1회 이상 사용한다"],
  };
}

export function generation(g: GeneratorId): GenerationFile {
  return { generatorId: g, ideas: [idea(`${g}-아이디어-1`), idea(`${g}-아이디어-2`)] };
}

export function writeGenerations(p: RunPaths): void {
  for (const g of GENERATOR_IDS) writeJson(p.generation(g), generation(g));
}

export function mapping(p: RunPaths): MappingFile {
  return readJsonFile(p.mapping) as MappingFile;
}

export function ids(p: RunPaths): string[] {
  return mapping(p).entries.map((e) => e.ideaId).sort();
}

export type ScoreFn = (ideaId: string, judge: JudgeId) => Partial<Record<Criterion, number>>;

export function evaluationFile(
  judge: JudgeId,
  round: 1 | 2,
  ideaIds: string[],
  scoreFn: ScoreFn = () => ({}),
  critical: (ideaId: string, judge: JudgeId) => string[] = () => [],
): EvaluationFile {
  return {
    judgeId: judge,
    round,
    evaluations: ideaIds.map((id) => {
      const s = scoreFn(id, judge);
      return {
        ideaId: id,
        version: round,
        scores: Object.fromEntries(CRITERIA.map((c) => [c, { score: s[c] ?? 3, rationale: `${c} 근거` }])) as EvaluationFile["evaluations"][number]["scores"],
        strengths: [`${id} 강점`],
        weaknesses: [`${id} 약점`],
        risks: [`${id} 실패 시나리오`],
        criticalIssues: critical(id, judge),
        hypotheses: [`[가설] ${id} 수요 존재`],
        summary: `${judge}의 ${id} 총평`,
      };
    }),
  };
}

export function writeEvaluations(p: RunPaths, round: 1 | 2, scoreFn?: ScoreFn, critical?: (id: string, j: JudgeId) => string[]): void {
  for (const j of JUDGE_IDS) writeJson(p.evaluation(round, j), evaluationFile(j, round, ids(p), scoreFn, critical));
}

export function writeDebates(p: RunPaths, build: (judge: JudgeId, targetIds: string[]) => DebateFile["entries"]): void {
  const agenda = readJsonFile(p.debateAgenda) as { targets: { ideaId: string }[] };
  const targets = agenda.targets.map((t) => t.ideaId);
  for (const j of JUDGE_IDS) writeJson(p.debate(j), { judgeId: j, round: 1, entries: build(j, targets) });
}

export function writeRevisions(p: RunPaths): void {
  const m = mapping(p);
  for (const g of GENERATOR_IDS) {
    const file: RevisionFile = {
      generatorId: g,
      revisions: m.entries
        .filter((e) => e.generatorId === g)
        .map((e) => ({
          ideaId: e.ideaId,
          idea: {
            ...idea(`${e.ideaId} 개선판`),
            mvpPlan: [1, 2, 3, 4].map((w) => ({ week: w, goal: `${w}주차 목표`, deliverables: [`${w}주차 산출물`] })),
          },
          changelog: [{ change: "대상 사용자를 좁힘", addresses: "feasibility: 범위가 넓다는 지적" }],
          rejectedFeedback: [{ feedback: "기능을 더 줄여라", reason: "핵심 가치 검증에 두 기능 모두 필요" }],
        })),
    };
    writeJson(p.revision(g), file);
  }
}
