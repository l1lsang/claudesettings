import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ArenaRunSchema, type ArenaRun } from "../domain/schemas";
import type { RunPaths } from "./paths";

/**
 * 파일 영속화.
 *  - state.json은 state.json.tmp에 먼저 쓰고 rename으로 교체한다(원자적 교체).
 *  - 단계 산출물은 "한 번만 쓰기": 같은 내용이면 무시, 다른 내용이면 ImmutableArtifactError.
 *    → 완료된 단계의 원본이 덮어써지지 않고, 재시도는 멱등이 된다.
 */

export class ImmutableArtifactError extends Error {
  constructor(public readonly path: string) {
    super(`이미 존재하는 산출물과 내용이 다릅니다(덮어쓰기 금지): ${path}`);
    this.name = "ImmutableArtifactError";
  }
}

export class RunLockedError extends Error {
  constructor(path: string) {
    super(`다른 arena 명령이 이 실행을 처리 중입니다. 잠시 후 다시 시도하세요 (잠금 파일: ${path})`);
    this.name = "RunLockedError";
  }
}

const RETRYABLE_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows/OneDrive에서 백신·동기화 프로그램이 잠깐 파일을 잡는 경우를 대비해 rename을 재시도한다. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_FS_CODES.has(code) || attempt >= 6) throw err;
      sleepSync(50 * 2 ** attempt);
    }
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameWithRetry(tmp, path);
}

export function toJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

export function writeTextOnce(path: string, content: string): "created" | "unchanged" {
  if (existsSync(path)) {
    if (normalizeNewlines(readFileSync(path, "utf8")) === normalizeNewlines(content)) return "unchanged";
    throw new ImmutableArtifactError(path);
  }
  writeFileAtomic(path, content);
  return "created";
}

export function writeJsonOnce(path: string, data: unknown): "created" | "unchanged" {
  return writeTextOnce(path, toJson(data));
}

export function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, ""); // PowerShell이 붙이는 BOM 제거
  return JSON.parse(raw);
}

// ─── 상태 / 이벤트 ────────────────────────────────────────────────

export function saveState(paths: RunPaths, run: ArenaRun): void {
  const parsed = ArenaRunSchema.parse(run); // 잘못된 상태는 저장 전에 거부
  writeFileAtomic(paths.state, toJson(parsed));
}

export function loadState(paths: RunPaths): ArenaRun {
  if (!existsSync(paths.state)) throw new Error(`state.json이 없습니다: ${paths.state}`);
  const result = ArenaRunSchema.safeParse(readJsonFile(paths.state));
  if (!result.success) {
    throw new Error(`state.json이 손상되었습니다: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}

export interface ArenaEvent {
  ts: string;
  type:
    | "RUN_CREATED"
    | "PHASE_TRANSITION"
    | "ADVANCE_BLOCKED"
    | "PHASE_FAILED"
    | "RUN_RECOVERED"
    | "ARTIFACT_WRITTEN"
    | "WARNING";
  phase?: string;
  from?: string;
  to?: string;
  message?: string;
  details?: unknown;
}

export function appendEvent(paths: RunPaths, event: ArenaEvent): void {
  ensureDir(dirname(paths.events));
  appendFileSync(paths.events, `${JSON.stringify(event)}\n`, "utf8");
}

export function readEvents(paths: RunPaths): ArenaEvent[] {
  if (!existsSync(paths.events)) return [];
  return readFileSync(paths.events, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ArenaEvent);
}

// ─── 잠금 ────────────────────────────────────────────────────────

const STALE_LOCK_MS = 10 * 60 * 1000;

/** 상태 파일을 동시에 고치지 못하도록 실행 단위 잠금을 건다. 반환된 함수로 해제한다. */
export function acquireLock(paths: RunPaths): () => void {
  ensureDir(dirname(paths.lock));
  const tryOpen = () => closeSync(openSync(paths.lock, "wx"));
  try {
    tryOpen();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const age = Date.now() - statSync(paths.lock).mtimeMs;
    if (age < STALE_LOCK_MS) throw new RunLockedError(paths.lock);
    unlinkSync(paths.lock); // 비정상 종료로 남은 오래된 잠금
    tryOpen();
  }
  return () => {
    try {
      unlinkSync(paths.lock);
    } catch {
      /* 이미 해제됨 */
    }
  };
}
