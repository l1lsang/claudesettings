import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATOR_IDS } from "../src/domain/constants";
import { anonymizeGenerations, detectAuthorLeaks, seededShuffle } from "../src/orchestration/anonymizer";
import { runPaths } from "../src/orchestration/paths";
import { ImmutableArtifactError, acquireLock, RunLockedError, writeFileAtomic, writeJsonOnce } from "../src/orchestration/persistence";
import { generation, tempRunsDir } from "./fixtures";

describe("anonymizer", () => {
  const gens = GENERATOR_IDS.map(generation);

  it("같은 시드면 같은 매핑, 다른 시드면 다른 순서", () => {
    const a = anonymizeGenerations(gens, "seed-1");
    const b = anonymizeGenerations(gens, "seed-1");
    expect(a).toEqual(b);
    const orders = new Set(["s1", "s2", "s3", "s4", "s5"].map((s) => seededShuffle([1, 2, 3, 4, 5, 6], s).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("IDEA-001~006을 부여하고 작성자 정보를 제거한다", () => {
    const withNotes = gens.map((g) => ({ ...g, ideas: g.ideas.map((i) => ({ ...i, authorNotes: "비공개 메모" })) }));
    const { blindIdeas, mapping } = anonymizeGenerations(withNotes, "seed");
    expect(blindIdeas.map((i) => i.ideaId)).toEqual(["IDEA-001", "IDEA-002", "IDEA-003", "IDEA-004", "IDEA-005", "IDEA-006"]);
    for (const idea of blindIdeas) {
      expect(idea).not.toHaveProperty("authorNotes");
      expect(idea).not.toHaveProperty("generatorId");
      expect(JSON.stringify(idea)).not.toContain("비공개 메모");
    }
    expect(mapping.entries).toHaveLength(6);
    expect(new Set(mapping.entries.map((e) => `${e.generatorId}:${e.index}`)).size).toBe(6);
  });

  it("본문에 에이전트 이름이 있으면 탐지한다", () => {
    expect(detectAuthorLeaks({ title: "Creative Agent의 제안" })).toEqual(["Creative Agent"]);
    expect(detectAuthorLeaks({ title: "평범한 제목" })).toEqual([]);
  });
});

describe("persistence", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("write-once: 같은 내용은 허용, 다른 내용은 거부", () => {
    const t = tempRunsDir();
    cleanup = t.cleanup;
    const path = join(t.dir, "a", "b.json");
    expect(writeJsonOnce(path, { x: 1 })).toBe("created");
    expect(writeJsonOnce(path, { x: 1 })).toBe("unchanged");
    expect(() => writeJsonOnce(path, { x: 2 })).toThrow(ImmutableArtifactError);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ x: 1 });
  });

  it("원자적 쓰기 후 임시 파일이 남지 않는다", () => {
    const t = tempRunsDir();
    cleanup = t.cleanup;
    const path = join(t.dir, "state.json");
    writeFileAtomic(path, "1");
    writeFileAtomic(path, "2");
    expect(readFileSync(path, "utf8")).toBe("2");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("잠금은 동시에 두 번 잡을 수 없다", () => {
    const t = tempRunsDir();
    cleanup = t.cleanup;
    const paths = runPaths(t.dir);
    const release = acquireLock(paths);
    expect(() => acquireLock(paths)).toThrow(RunLockedError);
    release();
    acquireLock(paths)();
  });
});
