import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../orchestration/persistence";
import { ArenaRunner } from "../orchestration/runner";

/**
 * 웹 앱의 실행 데이터는 브라우저가 보관한다(서버에 DB 없음).
 * 요청마다 브라우저가 보낸 실행 파일 묶음을 임시 디렉터리에 그대로 펼치고, 기존 오케스트레이터를
 * 디스크 모드 그대로 실행한 뒤, 바뀐 디렉터리를 다시 묶어서 돌려준다. 임시 디렉터리는 즉시 지운다.
 * 그래서 CLI와 웹이 같은 검증·write-once·이벤트 기록 코드를 쓴다.
 */

/** 실행 디렉터리 기준 상대 경로 → 파일 내용(UTF-8) */
export type RunFiles = Record<string, string>;

export class PayloadError extends Error {
  override name = "PayloadError";
}

const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export function assertRunFiles(value: unknown): RunFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PayloadError("files는 {경로: 내용} 객체여야 합니다");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FILES) throw new PayloadError(`파일이 너무 많습니다 (최대 ${MAX_FILES}개)`);
  let total = 0;
  for (const [path, content] of entries) {
    const segments = path.split("/");
    if (!segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) throw new PayloadError(`허용되지 않는 파일 경로: ${path}`);
    if (typeof content !== "string") throw new PayloadError(`${path}: 내용은 문자열이어야 합니다`);
    total += Buffer.byteLength(content, "utf8");
  }
  if (total > MAX_TOTAL_BYTES) throw new PayloadError("실행 데이터가 너무 큽니다");
  if (!("state.json" in (value as object))) throw new PayloadError("state.json이 없습니다");
  return value as RunFiles;
}

function collect(dir: string, prefix = ""): RunFiles {
  const out: RunFiles = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, collect(join(dir, entry.name), relPath));
    else if (entry.isFile() && entry.name !== ".lock" && !entry.name.endsWith(".tmp")) {
      out[relPath] = readFileSync(join(dir, entry.name), "utf8");
    }
  }
  return out;
}

/**
 * 임시 실행 디렉터리에서 fn을 실행한다.
 * runId·files가 있으면 그 실행을 펼쳐 두고, fn이 runId를 돌려주면(생성) 그 실행을 묶어 반환한다.
 */
export async function withWorkspace<T>(
  seed: { runId: string; files: RunFiles } | null,
  fn: (runner: ArenaRunner) => Promise<{ runId: string; value: T }>,
): Promise<{ value: T; runId: string; files: RunFiles }> {
  const root = mkdtempSync(join(tmpdir(), "idea-arena-ws-"));
  try {
    const runner = new ArenaRunner({ runsDir: root });
    if (seed) {
      if (!/^[\w-][\w.-]*$/.test(seed.runId) || seed.runId.includes("..")) throw new PayloadError(`잘못된 실행 ID: ${seed.runId}`);
      for (const [path, content] of Object.entries(seed.files)) writeFileAtomic(join(root, seed.runId, ...path.split("/")), content);
    }
    const { runId, value } = await fn(runner);
    return { value, runId, files: collect(join(root, runId)) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
