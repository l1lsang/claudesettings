import { DEFAULT_PRESET, isPresetId } from "../domain/presets";
import { LlmError, type LlmClient, type ModelConfig } from "../engine/llm";
import { AgentTaskError, isAgentId, runAgentTask } from "../orchestration/agent-tasks";
import { RunLockedError } from "../orchestration/persistence";
import { RunNotFoundError, type ArenaRunner } from "../orchestration/runner";
import { SESSION_COOKIE, checkPassword, clearSessionCookie, createSessionToken, parseCookies, sessionCookie, verifySessionToken } from "./auth";
import { loadRunBundle } from "./data";
import { META } from "./meta";
import { PayloadError, assertRunFiles, withWorkspace, type RunFiles } from "./workspace";

/**
 * 웹 API (프레임워크 무관). 로컬 서버(server.ts)와 Vercel 함수(vercel.ts)가 같이 쓴다.
 *
 *   GET  /api?action=session            로그인 여부·서버 설정 상태·표시용 상수
 *   POST /api {action:"login", password} 비밀번호 확인 → 세션 쿠키
 *   POST /api {action:"logout"}
 *   ── 아래는 로그인 필요 ──
 *   POST /api {action:"create", topic, constraints, preset} 새 실행 → GENERATING까지
 *   POST /api {action:"agent", runId, files, agent, hint?} 에이전트 1명의 현재 단계 작업(GPT 호출)
 *   POST /api {action:"advance"|"retry", runId, files}     검증·전이
 *   POST /api {action:"view", runId, files}                화면용 데이터 묶음
 *
 * 실행 데이터는 브라우저가 보관하고 매 요청에 files로 보낸다(workspace.ts).
 */

export interface ApiDeps {
  password: string | undefined;
  llm: LlmClient | undefined;
  models: ModelConfig;
  secureCookies: boolean;
  now?: () => number;
  /** 에이전트 작업 하나의 전체 시간 제한(ms) — 함수 시간 제한 대비 */
  taskTimeBudgetMs?: number;
  /** 로그인 실패 시 지연(ms) — 무차별 대입을 늦춘다 */
  loginFailureDelayMs?: number;
}

export interface ApiRequest {
  method: string;
  cookieHeader: string | undefined;
  query: URLSearchParams;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  json: unknown;
  setCookie?: string;
}

class BadRequest extends Error {}

const res = (status: number, json: unknown, setCookie?: string): ApiResponse => ({ status, json, setCookie });
const fail = (status: number, error: string) => res(status, { error });

function str(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new BadRequest(`${name}이(가) 필요합니다`);
  if (v.length > max) throw new BadRequest(`${name}이(가) 너무 깁니다 (최대 ${max}자)`);
  return v.trim();
}

function strList(v: unknown, name: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === "string" && x.length <= maxLen)) {
    throw new BadRequest(`${name}은(는) 문자열 배열이어야 합니다 (최대 ${maxItems}개, 각 ${maxLen}자)`);
  }
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
}

function seedOf(body: Record<string, unknown>): { runId: string; files: RunFiles } {
  return { runId: str(body.runId, "runId", 100), files: assertRunFiles(body.files) };
}

export async function handleApi(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const now = deps.now ?? Date.now;
  const authenticated = verifySessionToken(parseCookies(req.cookieHeader)[SESSION_COOKIE], deps.password, now());

  try {
    if (req.method === "GET") {
      if (req.query.get("action") !== "session") return fail(404, "없는 요청입니다");
      return res(200, {
        authenticated,
        setup: { password: Boolean(deps.password), llm: Boolean(deps.llm) },
        models: authenticated ? deps.models : undefined,
        meta: META,
      });
    }
    if (req.method !== "POST") return fail(405, "GET 또는 POST만 허용합니다");

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) throw new BadRequest("JSON 객체를 보내야 합니다");

    switch (body.action) {
      case "login": {
        if (!deps.password) return fail(503, "서버에 APP_PASSWORD 환경 변수가 설정되지 않았습니다");
        if (!checkPassword(body.password, deps.password)) {
          await new Promise((r) => setTimeout(r, deps.loginFailureDelayMs ?? 800));
          return fail(401, "비밀번호가 맞지 않습니다");
        }
        return res(200, { authenticated: true }, sessionCookie(createSessionToken(deps.password, now()), deps.secureCookies));
      }
      case "logout":
        return res(200, { authenticated: false }, clearSessionCookie(deps.secureCookies));
    }

    if (!authenticated) return fail(401, "로그인이 필요합니다");

    switch (body.action) {
      case "create": {
        const topic = str(body.topic, "주제", 4000);
        const constraints = strList(body.constraints, "제약", 20, 500);
        if (body.preset !== undefined && !isPresetId(body.preset)) throw new BadRequest("preset이 올바르지 않습니다");
        const preset = body.preset ?? DEFAULT_PRESET;
        const out = await withWorkspace(null, async (runner) => {
          const run = runner.create(topic, constraints, preset);
          const outcome = runner.advance(run.runId);
          return { runId: run.runId, value: { outcome, bundle: loadRunBundle(runner, run.runId) } };
        });
        return res(200, { runId: out.runId, files: out.files, ...out.value });
      }

      case "agent": {
        if (!deps.llm) return fail(503, "서버에 LETSUR_API_KEY 환경 변수가 설정되지 않았습니다");
        const llm = deps.llm;
        const seed = seedOf(body);
        if (!isAgentId(body.agent)) throw new BadRequest("agent가 올바르지 않습니다");
        const agent = body.agent;
        const hint = strList(body.hint, "hint", 50, 2000);
        const out = await withWorkspace(seed, async (runner) => ({
          runId: seed.runId,
          value: await runAgentTask(runner, seed.runId, agent, {
            llm,
            models: deps.models,
            hint,
            timeBudgetMs: deps.taskTimeBudgetMs,
          }),
        }));
        const content = out.files[out.value.path];
        return res(200, { result: out.value, file: content === undefined ? null : { path: out.value.path, content } });
      }

      case "advance":
      case "retry":
      case "view": {
        const action = body.action;
        const seed = seedOf(body);
        const out = await withWorkspace(seed, async (runner: ArenaRunner) => {
          const outcome =
            action === "advance" ? runner.advance(seed.runId) : action === "retry" ? runner.retry(seed.runId, { force: body.force === true }) : null;
          return { runId: seed.runId, value: { outcome, bundle: loadRunBundle(runner, seed.runId) } };
        });
        return res(200, action === "view" ? { bundle: out.value.bundle } : { files: out.files, ...out.value });
      }

      default:
        throw new BadRequest("알 수 없는 action입니다");
    }
  } catch (err) {
    if (err instanceof BadRequest || err instanceof PayloadError) return fail(400, err.message);
    if (err instanceof RunNotFoundError) return fail(404, err.message);
    if (err instanceof AgentTaskError || err instanceof RunLockedError) return fail(409, err.message);
    if (err instanceof LlmError) return fail(502, err.message);
    return fail(500, err instanceof Error ? err.message : String(err));
  }
}
