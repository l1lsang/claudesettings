import type { AddressInfo } from "node:net";
import { request } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArenaRunner } from "../src/orchestration/runner";
import { createDashboardServer } from "../src/web/server";
import { tempRunsDir, writeEvaluations, writeGenerations, writeRevisions } from "./fixtures";

let cleanup: () => void;
let runner: ArenaRunner;
let server: Server;
let base: string;

beforeEach(async () => {
  const t = tempRunsDir();
  cleanup = t.cleanup;
  runner = new ArenaRunner({ runsDir: t.dir });
  server = createDashboardServer(runner);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  cleanup();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
};

describe("dashboard server", () => {
  it("정적 파일과 메타 정보를 제공한다", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("/app.js");
    expect((await get("/app.js")).type).toContain("javascript");
    const meta = JSON.parse((await get("/api/meta")).body);
    expect(meta.criteria).toHaveLength(5);
    expect(meta.phases).not.toContain("FAILED");
  });

  it("진행 중에는 작성자를 숨기고, 완료 후에만 공개한다", async () => {
    const run = runner.create("주제", ["4주"]);
    const p = runner.paths(run.runId);
    runner.advance(run.runId);
    writeGenerations(p);
    runner.advance(run.runId);

    const list = JSON.parse((await get("/api/runs")).body);
    expect(list).toEqual([expect.objectContaining({ runId: run.runId, phase: "SCORING" })]);

    const mid = await get(`/api/runs/${run.runId}`);
    const b1 = JSON.parse(mid.body);
    expect(b1.authorsRevealed).toBe(false);
    expect(b1.authors).toBeNull();
    expect(b1.ideas.v1).toHaveLength(6);
    expect(mid.body).not.toMatch(/"generatorId"/);
    expect(b1.expected.map((f: { owner: string }) => f.owner)).toEqual(["feasibility", "innovation"]);

    writeEvaluations(p, 1);
    runner.advance(run.runId);
    writeRevisions(p);
    runner.advance(run.runId);
    writeEvaluations(p, 2);
    runner.advance(run.runId);

    const b2 = JSON.parse((await get(`/api/runs/${run.runId}`)).body);
    expect(b2.state.phase).toBe("COMPLETED");
    expect(b2.authorsRevealed).toBe(true);
    expect(Object.keys(b2.authors)).toHaveLength(6);
    expect(b2.ranking.top).toHaveLength(3);

    const report = await get(`/api/runs/${run.runId}/report`);
    expect(report.status).toBe(200);
    expect(report.body).toContain("## 최종 순위");
  });

  it("없는 실행·잘못된 ID는 404, 쓰기 요청은 405", async () => {
    expect((await get("/api/runs/nope")).status).toBe(404);
    expect((await get("/api/runs/..%2F..%2Fetc")).status).toBe(404);
    expect((await fetch(base + "/api/runs", { method: "POST" })).status).toBe(405);
  });

  it("로컬이 아닌 Host 헤더는 거부한다", async () => {
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/runs", headers: { Host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
