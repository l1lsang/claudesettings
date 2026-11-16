/**
 * OpenAI 호환 Chat Completions 클라이언트 (Letsur 게이트웨이 기본).
 * SDK 없이 fetch만 쓴다. API 키는 오류 메시지·로그에 절대 넣지 않는다.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface JsonCompletionRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** 이 요청에 쓸 수 있는 최대 시간(ms) */
  timeoutMs?: number;
}

export interface JsonCompletion {
  text: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  completeJson(req: JsonCompletionRequest): Promise<JsonCompletion>;
}

export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const DEFAULT_BASE_URL = "https://gw.letsur.ai/v1";
export const DEFAULT_MODEL = "gpt-6.1-sol";

export interface ModelConfig {
  generator: string;
  judge: string;
}

export interface OpenAiCompatibleOptions {
  apiKey: string;
  baseUrl?: string;
  /** 429·5xx 재시도 횟수 */
  retries?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function createOpenAiCompatibleClient(opts: OpenAiCompatibleOptions): LlmClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async completeJson(req) {
      const body = JSON.stringify({
        model: req.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        response_format: { type: "json_object" },
        max_completion_tokens: req.maxTokens ?? 16000,
      });

      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(req.timeoutMs ?? 240_000),
          });
        } catch (err) {
          const e = err as Error;
          if (e.name === "TimeoutError" || e.name === "AbortError") throw new LlmError(`모델 응답 시간 초과 (${req.model})`);
          if (attempt < retries) {
            await delay(1000 * 2 ** attempt);
            continue;
          }
          throw new LlmError(`모델 서버에 연결하지 못했습니다: ${e.message}`);
        }

        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
            await delay(1500 * 2 ** attempt);
            continue;
          }
          const hint = res.status === 401 || res.status === 403 ? " — API 키를 확인하세요" : "";
          throw new LlmError(`모델 호출 실패 (HTTP ${res.status}${hint}): ${detail}`, res.status);
        }

        const data = (await res.json()) as {
          model?: string;
          choices?: { message?: { content?: string | null }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? "";
        if (!text.trim()) {
          const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : "";
          throw new LlmError(`모델이 빈 응답을 반환했습니다${reason}`);
        }
        if (choice?.finish_reason === "length") throw new LlmError("모델 응답이 최대 길이에서 잘렸습니다");
        return {
          text,
          model: data.model ?? req.model,
          usage: data.usage
            ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
            : undefined,
        };
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 환경 변수에서 LLM 설정을 읽는다. 키가 없으면 client는 undefined. */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): { client: LlmClient | undefined; models: ModelConfig } {
  const apiKey = env.LETSUR_API_KEY?.trim();
  const fallback = env.ARENA_MODEL?.trim() || DEFAULT_MODEL;
  return {
    client: apiKey ? createOpenAiCompatibleClient({ apiKey, baseUrl: env.LETSUR_BASE_URL?.trim() || undefined }) : undefined,
    models: {
      generator: env.ARENA_GENERATOR_MODEL?.trim() || fallback,
      judge: env.ARENA_JUDGE_MODEL?.trim() || fallback,
    },
  };
}
