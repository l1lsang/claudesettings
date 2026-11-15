import type { IncomingMessage, ServerResponse } from "node:http";
import { llmFromEnv } from "../engine/llm";
import { handleApi, type ApiDeps } from "./api";

/** node:http 요청을 handleApi로 연결한다. 로컬 서버와 Vercel 함수가 같이 쓴다. */

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(data));
}

export async function handleNodeApi(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  let body: unknown;
  if (req.method === "POST") {
    if (!(req.headers["content-type"] ?? "").includes("application/json")) {
      return sendJson(res, 415, { error: "Content-Type은 application/json이어야 합니다" });
    }
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      return err instanceof TooLarge ? sendJson(res, 413, { error: "요청이 너무 큽니다" }) : sendJson(res, 400, { error: "JSON 형식 오류" });
    }
  }
  const out = await handleApi({ method: req.method ?? "GET", cookieHeader: req.headers.cookie, query: url.searchParams, body }, deps);
  sendJson(res, out.status, out.json, out.setCookie ? { "Set-Cookie": out.setCookie } : {});
}

/** 환경 변수로 API 의존성을 만든다. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ApiDeps> = {}): ApiDeps {
  const { client, models } = llmFromEnv(env);
  return {
    password: env.APP_PASSWORD || undefined,
    llm: client,
    models,
    secureCookies: Boolean(env.VERCEL),
    ...overrides,
  };
}
