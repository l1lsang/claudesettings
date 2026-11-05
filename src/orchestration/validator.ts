import { existsSync } from "node:fs";
import type { z } from "zod";
import { GENERATOR_IDS, JUDGE_IDS } from "../domain/constants";
import {
  DebateFileSchema,
  EvaluationFileSchema,
  GenerationFileSchema,
  RevisionFileSchema,
  RunInputSchema,
  type ArenaConfig,
  type DebateFile,
  type EvaluationFile,
  type GenerationFile,
  type RevisionFile,
  type RunInput,
} from "../domain/schemas";
import { toScoreVector } from "../domain/scoring";
import { detectAuthorLeaks, type MappingFile } from "./anonymizer";
import { rel, type RunPaths } from "./paths";
import { readJsonFile } from "./persistence";

/**
 * 에이전트 산출물 검증. 검증 실패는 실행을 FAILED로 만들지 않고 "전이 중단"으로 처리한다.
 * 에이전트가 파일을 고친 뒤 advance를 다시 실행하면 된다.
 */

export interface ValidationResult<T = undefined> {
  ok: boolean;
  errors: string[];
  warnings: string[];
  data?: T;
}

export class Collector {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  constructor(private readonly paths: RunPaths) {}

  error(msg: string): void {
    this.errors.push(msg);
  }
  warn(msg: string): void {
    this.warnings.push(msg);
  }

  /** 파일을 읽어 스키마로 검증한다. 실패하면 오류를 기록하고 undefined를 반환한다. */
  load<S extends z.ZodType>(path: string, schema: S): z.infer<S> | undefined {
    const name = rel(this.paths, path);
    if (!existsSync(path)) {
      this.error(`누락: ${name}`);
      return undefined;
    }
    let raw: unknown;
    try {
      raw = readJsonFile(path);
    } catch (err) {
      this.error(`${name}: JSON 형식 오류 — ${(err as Error).message}`);
      return undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 20)) {
        this.error(`${name}: ${issue.path.length ? issue.path.join(".") : "(루트)"} — ${issue.message}`);
      }
      return undefined;
    }
    return parsed.data;
  }

  result<T>(data?: T): ValidationResult<T> {
    const ok = this.errors.length === 0;
    return { ok, errors: this.errors, warnings: this.warnings, data: ok ? data : undefined };
  }
}

/** 기대하는 ID 집합과 실제 ID 목록이 정확히 일치하는지 검사 */
function checkIdCoverage(c: Collector, where: string, expected: readonly string[], actual: string[]): void {
  const seen = new Set<string>();
  for (const id of actual) {
    if (seen.has(id)) c.error(`${where}: ${id}가 중복되었습니다`);
    seen.add(id);
    if (!expected.includes(id)) c.error(`${where}: 대상이 아닌 ${id}가 포함되었습니다`);
  }
  for (const id of expected) if (!seen.has(id)) c.error(`${where}: ${id}가 누락되었습니다`);
}

export function validateInput(paths: RunPaths): ValidationResult<RunInput> {
  const c = new Collector(paths);
  return c.result(c.load(paths.input, RunInputSchema));
}

export function validateGenerations(paths: RunPaths, config: ArenaConfig): ValidationResult<GenerationFile[]> {
  const c = new Collector(paths);
  const files: GenerationFile[] = [];
  for (const g of GENERATOR_IDS) {
    const file = c.load(paths.generation(g), GenerationFileSchema);
    if (!file) continue;
    const name = rel(paths, paths.generation(g));
    if (file.generatorId !== g) c.error(`${name}: generatorId가 "${g}"여야 합니다 (현재 "${file.generatorId}")`);
    if (file.ideas.length !== config.ideasPerGenerator) {
      c.error(`${name}: 아이디어가 정확히 ${config.ideasPerGenerator}개여야 합니다 (현재 ${file.ideas.length}개)`);
    }
    const titles = file.ideas.map((i) => i.title);
    if (new Set(titles).size !== titles.length) c.error(`${name}: 같은 제목의 아이디어가 있습니다`);
    files.push(file);
  }
  const total = files.reduce((n, f) => n + f.ideas.length, 0);
  const expected = config.generatorCount * config.ideasPerGenerator;
  if (c.errors.length === 0 && total !== expected) c.error(`전체 아이디어가 ${expected}개여야 합니다 (현재 ${total}개)`);
  return c.result(files);
}

export function validateEvaluations(
  paths: RunPaths,
  round: 1 | 2,
  ideaIds: string[],
): ValidationResult<EvaluationFile[]> {
  const c = new Collector(paths);
  const files: EvaluationFile[] = [];
  for (const j of JUDGE_IDS) {
    const path = paths.evaluation(round, j);
    const file = c.load(path, EvaluationFileSchema);
    if (!file) continue;
    const name = rel(paths, path);
    if (file.judgeId !== j) c.error(`${name}: judgeId가 "${j}"여야 합니다`);
    if (file.round !== round) c.error(`${name}: round가 ${round}여야 합니다`);
    checkIdCoverage(c, name, ideaIds, file.evaluations.map((e) => e.ideaId));
    for (const ev of file.evaluations) {
      if (ev.version !== round) c.error(`${name}: ${ev.ideaId}의 version이 ${round}여야 합니다 (v${round} 아이디어 평가)`);
    }
    files.push(file);
  }
  return c.result(files);
}

export interface DebateAgenda {
  round: 1;
  targets: { ideaId: string; totalGap: number; reasons: unknown[] }[];
}

export function validateDebates(
  paths: RunPaths,
  agenda: DebateAgenda,
  round1: EvaluationFile[],
): ValidationResult<DebateFile[]> {
  const c = new Collector(paths);
  const targetIds = agenda.targets.map((t) => t.ideaId);
  const files: DebateFile[] = [];
  for (const j of JUDGE_IDS) {
    const path = paths.debate(j);
    const file = c.load(path, DebateFileSchema);
    if (!file) continue;
    const name = rel(paths, path);
    if (file.judgeId !== j) c.error(`${name}: judgeId가 "${j}"여야 합니다`);
    checkIdCoverage(c, name, targetIds, file.entries.map((e) => e.ideaId));

    const own = round1.find((f) => f.judgeId === j);
    for (const entry of file.entries) {
      const where = `${name} ${entry.ideaId}`;
      const ev = own?.evaluations.find((e) => e.ideaId === entry.ideaId);
      const original = ev ? toScoreVector(ev.scores) : undefined;
      const seen = new Set<string>();
      for (const sc of entry.scoreChanges) {
        if (seen.has(sc.criterion)) c.error(`${where}: ${sc.criterion} 변경이 중복되었습니다`);
        seen.add(sc.criterion);
        if (sc.from === sc.to) c.error(`${where}: ${sc.criterion} 변경 전후 점수가 같습니다`);
        if (original && original[sc.criterion] !== sc.from) {
          c.error(`${where}: ${sc.criterion}의 from(${sc.from})이 1차 평가 점수(${original[sc.criterion]})와 다릅니다`);
        }
      }
      if (entry.stance === "REVISE" && entry.scoreChanges.length === 0) {
        c.error(`${where}: stance가 REVISE이면 scoreChanges가 필요합니다`);
      }
      if (entry.stance === "MAINTAIN" && entry.scoreChanges.length > 0) {
        c.error(`${where}: 점수를 바꿨다면 stance는 REVISE여야 합니다`);
      }
    }
    files.push(file);
  }

  // 동조 추적: 상대 의견을 수용했다고 하면서 근거가 너무 짧으면 경고
  for (const f of files) {
    for (const e of f.entries) {
      for (const sc of e.scoreChanges) {
        if (sc.basis === "PEER_PERSUASION" && sc.rationale.length < 20) {
          c.warn(`${f.judgeId} ${e.ideaId} ${sc.criterion}: 상대 논거 수용 근거가 너무 짧습니다 — 어떤 논거에 설득됐는지 구체적으로 적어야 합니다`);
        }
      }
    }
  }
  return c.result(files);
}

export function validateRevisions(paths: RunPaths, mapping: MappingFile): ValidationResult<RevisionFile[]> {
  const c = new Collector(paths);
  const files: RevisionFile[] = [];
  for (const g of GENERATOR_IDS) {
    const path = paths.revision(g);
    const file = c.load(path, RevisionFileSchema);
    if (!file) continue;
    const name = rel(paths, path);
    if (file.generatorId !== g) c.error(`${name}: generatorId가 "${g}"여야 합니다`);
    const own = mapping.entries.filter((e) => e.generatorId === g).map((e) => e.ideaId);
    checkIdCoverage(c, name, own, file.revisions.map((r) => r.ideaId));
    for (const r of file.revisions) {
      const leaks = detectAuthorLeaks({ idea: r.idea, changelog: r.changelog, rejectedFeedback: r.rejectedFeedback });
      if (leaks.length) c.warn(`${name} ${r.ideaId}: 익명성 경고 — 본문에 "${leaks.join(", ")}" 포함`);
    }
    files.push(file);
  }
  return c.result(files);
}
