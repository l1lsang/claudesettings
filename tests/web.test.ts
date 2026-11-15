import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi, type ApiDeps, type ApiRequest } from "../src/web/api";
import { createSessionToken, verifySessionToken } from "../src/web/auth";
import { createAppServer } from "../src/web/server";
import { fakeLlm } from "./fake-llm";

const PASSWORD = "test-password-!!";
const NOW = Date.parse("2026-11-16T00:00:00.000Z");

function deps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    password: PASSWORD,
    llm: fakeLlm(),
    models: { generator: "g", judge: "j" },
    secureCookies: true,
    now: () => NOW,
    loginFailureDelayMs: 0,
    ...over,
  };
}

const cookie = `arena_session=${createSessionToken(PASSWORD, NOW)}`;
const post = (body: unknown, withCookie = true): ApiRequest => ({
  method: "POST",
  cookieHeader: withCookie ? cookie : undefined,
  query: new URLSearchParams(),
  body,
});
type Files = Record<string, string>;

describe("인증", () => {
  it("세션 토큰은 서명·만료를 검사한다", () => {
    const token = createSessionToken(PASSWORD, NOW, 1000);
    expect(verifySessionToken(token, PASSWORD, NOW + 999)).toBe(true);
    expect(verifySessionToken(token, PASSWORD, NOW + 1001)).toBe(false);
    expect(verifySessionToken(token, "other-password", NOW)).toBe(false);
    expect(verifySessionToken(token.replace(/.$/, "x"), PASSWORD, NOW)).toBe(false);
    expect(verifySessionToken(undefined, PASSWORD, NOW)).toBe(false);
  });

  it("비밀번호가 맞아야 세션 쿠키를 준다", async () => {
    const d = deps();
    expect((await handleApi(post({ action: "login", password: "wrong" }, false), d)).status).toBe(401);
    const ok = await handleApi(post({ action: "login", password: PASSWORD }, false), d);
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/^arena_session=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  });

  it("APP_PASSWORD가 없으면 아무도 로그인할 수 없다", async () => {
    const d = deps({ password: undefined });
    expect((await handleApi(post({ action: "login", password: "" }, false), d)).status).toBe(503);
    expect((await handleApi(post({ action: "create", topic: "x" }), d)).status).toBe(401);
  });

  it("로그인하지 않으면 실행 API를 쓸 수 없다", async () => {
    const res = await handleApi(post({ action: "create", topic: "주제" }, false), deps());
    expect(res.status).toBe(401);
    const session = await handleApi({ method: "GET", cookieHeader: undefined, query: new URLSearchParams("action=session"), body: undefined }, deps());
    expect(session.json).toMatchObject({ authenticated: false, setup: { password: true, llm: true } });
    expect((session.json as { models?: unknown }).models).toBeUndefined();
  });
});

describe("실행 API (브라우저가 파일 묶음을 보관)", () => {
  it("생성 → 에이전트 작업 → advance로 단계가 넘어간다", async () => {
    const d = deps();
    const created = await handleApi(post({ action: "create", topic: "동아리 운영", constraints: ["3명"], preset: "general" }), d);
    expect(created.status).toBe(200);
    const c = created.json as { runId: string; files: Files; bundle: { state: { phase: string; preset: string }; labels: { presetName: string } } };
    expect(c.bundle.state.phase).toBe("GENERATING");
    expect(c.bundle.state.preset).toBe("general");
    expect(c.bundle.labels.presetName).toBe("범용");
    expect(Object.keys(c.files)).toEqual(expect.arrayContaining(["state.json", "input.json", "events.jsonl"]));
    expect(Object.keys(c.files).some((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toBe(false);

    const files: Files = { ...c.files };
    for (const agent of ["creative", "problem", "business"]) {
      const res = await handleApi(post({ action: "agent", runId: c.runId, files, agent }), d);
      expect(res.status).toBe(200);
      const out = res.json as { result: { ok: boolean }; file: { path: string; content: string } };
      expect(out.result.ok).toBe(true);
      expect(out.file.path).toBe(`private/generations/${agent}.json`);
      files[out.file.path] = out.file.content;
    }

    const adv = await handleApi(post({ action: "advance", runId: c.runId, files }), d);
    const a = adv.json as { outcome: { status: string }; files: Files; bundle: { state: { phase: string }; ideas: { v1: unknown[] } } };
    expect(a.outcome.status).toBe("advanced");
    expect(a.bundle.state.phase).toBe("SCORING");
    expect(a.bundle.ideas.v1).toHaveLength(6);
    expect(Object.keys(a.files)).toContain("private/mapping.json");

    const view = await handleApi(post({ action: "view", runId: c.runId, files: a.files }), d);
    expect((view.json as { bundle: { authors: unknown } }).bundle.authors).toBeNull(); // 완료 전에는 작성자 비공개
  });

  it("잘못된 파일 경로·요청은 거부한다", async () => {
    const d = deps();
    const bad = await handleApi(post({ action: "view", runId: "r1", files: { "state.json": "{}", "../escape.json": "{}" } }), d);
    expect(bad.status).toBe(400);
    expect((await handleApi(post({ action: "view", runId: "../x", files: { "state.json": "{}" } }), d)).status).toBe(400);
    expect((await handleApi(post({ action: "create", topic: "x", preset: "nope" }), d)).status).toBe(400);
    expect((await handleApi(post({ action: "agent", runId: "r1", files: { "state.json": "{}" }, agent: "lead" }), d)).status).toBe(400);
    expect((await handleApi(post({ action: "unknown" }), d)).status).toBe(400);
  });

  it("LETSUR_API_KEY가 없으면 에이전트 작업을 거부한다", async () => {
    const res = await handleApi(post({ action: "agent", runId: "r1", files: { "state.json": "{}" }, agent: "creative" }), deps({ llm: undefined }));
    expect(res.status).toBe(503);
  });
});

describe("로컬 서버", () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    server = createAppServer(deps());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it("화면 파일과 세션 정보를 제공한다", async () => {
    const page = await fetch(base + "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("/app.js");
    const session = (await (await fetch(base + "/api?action=session")).json()) as { meta: { presets: unknown[] }; authenticated: boolean };
    expect(session.meta.presets.length).toBeGreaterThanOrEqual(6);
    expect(session.authenticated).toBe(false);
  });

  it("JSON이 아닌 POST는 거부한다", async () => {
    const res = await fetch(base + "/api", { method: "POST", body: "action=login", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(415);
  });

  it("로컬이 아닌 Host 헤더는 거부한다", async () => {
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api?action=session", headers: { Host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
