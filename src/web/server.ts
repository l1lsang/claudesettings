import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { ApiDeps } from "./api";
import { SECURITY_HEADERS, handleNodeApi, sendJson } from "./http";

/**
 * 로컬 개발 서버 — Vercel 배포와 같은 화면(public/)과 같은 /api를 제공한다.
 *  - 127.0.0.1에만 바인딩하고 Host 헤더도 로컬 이름만 허용(DNS 리바인딩 방지).
 *  - 실행 데이터는 브라우저에 저장된다. 이 서버는 runs/를 읽거나 쓰지 않는다.
 */

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function handle(deps: ApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!ALLOWED_HOSTS.has(hostname)) return sendJson(res, 403, { error: "로컬 주소로만 접속할 수 있습니다" });
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/api") return handleNodeApi(req, res, deps);

  const asset = STATIC[pathname];
  if (asset && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type });
    res.end(req.method === "HEAD" ? undefined : readFileSync(PUBLIC_DIR + asset.file));
    return;
  }
  return sendJson(res, 404, { error: "없는 경로입니다" });
}

export function createAppServer(deps: ApiDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
    });
  });
}
