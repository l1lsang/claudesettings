import type { IncomingMessage, ServerResponse } from "node:http";
import { depsFromEnv, handleNodeApi, sendJson } from "./http";

/**
 * Vercel 함수 진입점(/api). scripts/build-vercel.mjs가 이 파일을 번들해 .vercel/output에 넣는다.
 * 함수 최대 실행 시간은 300초 — 에이전트 작업은 285초 안에 끝내고, 남은 시간이 90초 미만이면 재시도하지 않는다.
 */
const deps = depsFromEnv(process.env, { taskTimeBudgetMs: 285_000 });

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await handleNodeApi(req, res, deps);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
  }
}
