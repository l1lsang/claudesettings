import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * 비밀번호 한 개로 여는 접근 제어.
 *  - 비밀번호는 환경 변수 APP_PASSWORD에만 둔다(코드·저장소에 넣지 않는다).
 *  - 로그인하면 만료 시각에 HMAC 서명을 붙인 HttpOnly 쿠키를 준다. 서명 키가 비밀번호라서
 *    비밀번호를 바꾸면 기존 세션이 모두 무효가 된다.
 */

export const SESSION_COOKIE = "arena_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function checkPassword(input: unknown, password: string | undefined): boolean {
  if (!password || typeof input !== "string") return false;
  return timingSafeEqual(digest(input), digest(password));
}

function sign(exp: number, password: string): string {
  return createHmac("sha256", password).update(`idea-arena-session:${exp}`).digest("base64url");
}

export function createSessionToken(password: string, nowMs: number, ttlMs = SESSION_TTL_MS): string {
  const exp = nowMs + ttlMs;
  return `${exp}.${sign(exp, password)}`;
}

export function verifySessionToken(token: string | undefined, password: string | undefined, nowMs: number): boolean {
  if (!token || !password) return false;
  const m = /^(\d{1,16})\.([\w-]{43})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp <= nowMs) return false;
  const expected = Buffer.from(sign(exp, password));
  const given = Buffer.from(m[2] ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
