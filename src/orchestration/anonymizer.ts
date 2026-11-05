import { createHash } from "node:crypto";
import { AUTHOR_LEAK_TERMS, GENERATOR_IDS, type GeneratorId } from "../domain/constants";
import type { BlindIdeaV1, BlindIdeaV2, GenerationFile, RevisionEntry } from "../domain/schemas";

/**
 * 익명화.
 *  - 생성자별 아이디어를 섞은 뒤 IDEA-001부터 번호를 붙인다. (번호 순서로 작성자를 추측할 수 없게)
 *  - 셔플 시드는 runId로 고정 → 재시도해도 같은 매핑이 나와 write-once 원칙과 충돌하지 않는다.
 *  - 평가용 객체는 허용된 필드만 골라 담는다(authorNotes 등은 제외).
 */

export interface MappingEntry {
  ideaId: string;
  generatorId: GeneratorId;
  /** 생성자 파일 안에서의 순서(0부터) */
  index: number;
}

export interface MappingFile {
  seed: string;
  entries: MappingEntry[];
}

function seedToInt(seed: string): number {
  return createHash("sha256").update(seed).digest().readUInt32LE(0);
}

/** mulberry32 — 시드 고정 의사난수 */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const rand = mulberry32(seedToInt(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function formatIdeaId(n: number): string {
  return `IDEA-${String(n).padStart(3, "0")}`;
}

export function anonymizeGenerations(
  generations: GenerationFile[],
  seed: string,
): { blindIdeas: BlindIdeaV1[]; mapping: MappingFile } {
  const ordered = [...generations].sort(
    (a, b) => GENERATOR_IDS.indexOf(a.generatorId) - GENERATOR_IDS.indexOf(b.generatorId),
  );
  const flat = ordered.flatMap((g) => g.ideas.map((idea, index) => ({ generatorId: g.generatorId, index, idea })));
  const shuffled = seededShuffle(flat, seed);

  const blindIdeas: BlindIdeaV1[] = [];
  const entries: MappingEntry[] = [];
  shuffled.forEach((item, i) => {
    const ideaId = formatIdeaId(i + 1);
    const { idea } = item;
    blindIdeas.push({
      ideaId,
      version: 1,
      title: idea.title,
      problem: idea.problem,
      targetUsers: idea.targetUsers,
      solution: idea.solution,
      differentiation: idea.differentiation,
      mvp: [...idea.mvp],
      assumptions: [...idea.assumptions],
    });
    entries.push({ ideaId, generatorId: item.generatorId, index: item.index });
  });

  return { blindIdeas, mapping: { seed, entries } };
}

export function blindRevision(entry: RevisionEntry): BlindIdeaV2 {
  const { idea } = entry;
  return {
    ideaId: entry.ideaId,
    version: 2,
    title: idea.title,
    problem: idea.problem,
    targetUsers: idea.targetUsers,
    solution: idea.solution,
    differentiation: idea.differentiation,
    mvp: [...idea.mvp],
    assumptions: [...idea.assumptions],
    mvpPlan: idea.mvpPlan.map((s) => ({ week: s.week, goal: s.goal, deliverables: [...s.deliverables] })),
    changelog: entry.changelog.map((c) => ({ change: c.change, addresses: c.addresses })),
    rejectedFeedback: entry.rejectedFeedback.map((r) => ({ feedback: r.feedback, reason: r.reason })),
  };
}

/** 익명 패키지 안에 생성자 이름이 들어갔는지 검사한다(경고용 — 본문에 이름이 들어가면 익명성이 깨진다). */
export function detectAuthorLeaks(value: unknown, terms: readonly string[] = AUTHOR_LEAK_TERMS): string[] {
  const haystack = JSON.stringify(value).toLowerCase();
  return terms.filter((t) => haystack.includes(t.toLowerCase()));
}
