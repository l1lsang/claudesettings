import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  AGENT_LABELS,
  CRITERIA,
  CRITERION_LABELS,
  GENERATOR_IDS,
  JUDGE_IDS,
  SCORE_CHANGE_BASIS_LABELS,
} from "../domain/constants";
import { ArenaPhaseSchema } from "../domain/schemas";
import { RunNotFoundError, type ArenaRunner } from "../orchestration/runner";
import { listRuns, loadRunBundle } from "./data";

/**
 * 로컬 결과 대시보드 서버 (읽기 전용).
 *  - 기본 127.0.0.1에만 바인딩. Host 헤더도 로컬 이름만 허용(DNS 리바인딩 방지).
 *  - GET/HEAD만 허용하고 runs/ 파일을 절대 쓰지 않는다.
 */

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const META = {
  phases: ArenaPhaseSchema.options.filter((p) => p !== "FAILED"),
  criteria: CRITERIA.map((c) => ({ id: c, label: CRITERION_LABELS[c] })),
  agents: AGENT_LABELS,
  generators: GENERATOR_IDS,
  judges: JUDGE_IDS,
  bases: SCORE_CHANGE_BASIS_LABELS,
};

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, head = false): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(head ? undefined : body);
}

const json = (res: ServerResponse, status: number, data: unknown, head = false) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data), head);

function handle(runner: ArenaRunner, req: IncomingMessage, res: ServerResponse): void {
  const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!ALLOWED_HOSTS.has(hostname)) return json(res, 403, { error: "로컬 주소로만 접속할 수 있습니다" });
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "읽기 전용 서버입니다" });
  const head = req.method === "HEAD";
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  const asset = STATIC[pathname];
  if (asset) return send(res, 200, asset.type, readFileSync(PUBLIC_DIR + asset.file), head);

  if (pathname === "/api/meta") return json(res, 200, META, head);
  if (pathname === "/api/runs") return json(res, 200, listRuns(runner), head);

  const report = /^\/api\/runs\/([^/]+)\/report$/.exec(pathname);
  if (report) {
    const paths = runner.paths(decodeURIComponent(report[1] ?? ""));
    try {
      return send(res, 200, "text/plain; charset=utf-8", readFileSync(paths.report, "utf8"), head);
    } catch {
      return json(res, 404, { error: "보고서가 아직 없습니다" }, head);
    }
  }

  const run = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  if (run) return json(res, 200, loadRunBundle(runner, decodeURIComponent(run[1] ?? "")), head);

  return json(res, 404, { error: "없는 경로입니다" }, head);
}

export function createDashboardServer(runner: ArenaRunner): Server {
  return createServer((req, res) => {
    try {
      handle(runner, req, res);
    } catch (err) {
      if (err instanceof RunNotFoundError) return json(res, 404, { error: err.message });
      json(res, 500, { error: (err as Error).message });
    }
  });
}
