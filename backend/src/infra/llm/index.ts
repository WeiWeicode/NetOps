/**
 * 模型用戶端(由舊版 server/lib/llm.js 搬移,IMPL-PLAN A1、ARCHITECTURE D23):公司 AI 主機的 vLLM(OpenAI 相容 API)
 *   主機位址只從設定讀(LLM_URL、LLM_MODEL;AGENT.md §7.4),不寫死。請求內容(溫度、max_tokens、思考模式)與舊版相同。
 *   串流回答時思考內容不往外送,只回報字數(同舊版)。
 * 與舊版不同:不直接寫 HTTP 回應(舊版 streamChat 收 express res),改成 async generator,由路由轉成 SSE;
 *   上游錯誤訊息只寫日誌,不回傳給前端(可能含主機位址)。
 */
export interface LlmConfig {
  /** 例如 http://10.10.130.46:8080/v1(結尾不帶 /) */
  url: string;
  /** 空字串 = 取 /models 的第一個(同舊版) */
  model: string;
  /** 沒有就不帶 Authorization(LLM_API_KEY_FILE) */
  apiKey: string;
  /** 單次回答最多等多久(毫秒),深入思考會比較久 */
  timeoutMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type StreamEvent = { type: 'thinking'; chars: number } | { type: 'content'; text: string } | { type: 'done'; finish: string };

/** 模型服務的錯誤:message 是給使用者看的分類訊息,原文放 cause(只寫日誌) */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'timeout' | 'bad-response',
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type Llm = ReturnType<typeof createLlm>;

/** 串流中一行的長度上限(vLLM 每個 data: 是一小段回答) */
const MAX_LINE = 1024 * 1024;

export function createLlm(cfg: LlmConfig, fetchImpl: typeof fetch = fetch) {
  let modelCache = { at: 0, id: '' };
  const authHeader = (): Record<string, string> => (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});

  /** timeout:逾時用的 signal(與呼叫端中斷分開判斷);user:使用者關閉連線 */
  async function post(path: string, body: unknown, timeout: AbortSignal, user?: AbortSignal) {
    const signal = user ? AbortSignal.any([user, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, signal, body: JSON.stringify(body) });
    } catch (err) {
      if (user?.aborted) throw err;
      if (timeout.aborted) throw new LlmError('AI 服務回應逾時', 'timeout', { cause: err });
      throw new LlmError('無法連線 AI 服務', 'unavailable', { cause: err });
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new LlmError(`AI 服務回應 ${res.status}`, 'bad-response', { cause: new Error(text) });
    }
    return res;
  }

  /** 查詢中的 /models(同時呼叫時只查一次) */
  let pending: Promise<string> | null = null;

  /** 模型名稱(沒設定時取 /models 第一個,快取 10 分鐘) */
  async function model(): Promise<string> {
    if (cfg.model) return cfg.model;
    if (modelCache.id && Date.now() - modelCache.at < 600000) return modelCache.id;
    pending ??= fetchModel().finally(() => (pending = null));
    return pending;
  }

  async function fetchModel(): Promise<string> {
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.url}/models`, { headers: authHeader(), signal: AbortSignal.timeout(8000) });
    } catch (err) {
      throw new LlmError('無法連線 AI 服務', 'unavailable', { cause: err });
    }
    if (!res.ok) throw new LlmError(`AI 服務回應 ${res.status}`, 'bad-response');
    const body = (await res.json()) as { data?: { id?: string }[] };
    const id = body.data?.[0]?.id;
    if (!id) throw new LlmError('AI 服務沒有可用的模型', 'bad-response');
    modelCache = { at: Date.now(), id };
    return id;
  }

  /** 一次取得完整回答(不串流、不思考),例如外部 IP 學習整理筆記;timeoutMs 預設同舊版(LLM_TIMEOUT_MS,最多 180 秒) */
  async function chatOnce({ messages, maxTokens = 3000, temperature = 0.2, signal, timeoutMs }: { messages: ChatMessage[]; maxTokens?: number; temperature?: number; signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    const m = await model();
    const timeout = AbortSignal.timeout(timeoutMs ?? Math.min(cfg.timeoutMs, 180000));
    const res = await post(
      '/chat/completions',
      { model: m, temperature, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false }, messages },
      timeout,
      signal,
    );
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? '';
  }

  /**
   * 串流回答:thinking(思考字數,每 200 字一次)、content(回答片段)、done(finish_reason)
   * signal:使用者關閉連線時中斷;超過 LLM_TIMEOUT_MS 丟出 LlmError('timeout')
   */
  async function* stream({ messages, think = false, signal }: { messages: ChatMessage[]; think?: boolean; signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    const m = await model();
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const upstream = await post(
      '/chat/completions',
      { model: m, stream: true, temperature: 0.3, max_tokens: think ? 12000 : 4000, chat_template_kwargs: { enable_thinking: think }, messages },
      timeout,
      signal,
    );
    if (!upstream.body) throw new LlmError('AI 服務沒有回應內容', 'bad-response');

    // 解析 vLLM 的 SSE:data: {"choices":[{"delta":{"content":"...","reasoning":"..."}}]}
    const decoder = new TextDecoder();
    let buffer = '';
    let thinkingChars = 0;
    let lastThinkingSent = 0;
    let finish = '';
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        // 上游一直不送換行時不無限累積(審查修正)
        if (buffer.length > MAX_LINE) throw new LlmError('AI 服務回應格式錯誤', 'bad-response');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let json: { choices?: { delta?: { content?: string; reasoning?: string; reasoning_content?: string }; finish_reason?: string | null }[] };
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = json.choices?.[0];
          const delta = choice?.delta ?? {};
          const reasoning = delta.reasoning ?? delta.reasoning_content;
          if (reasoning) {
            thinkingChars += reasoning.length;
            // 思考內容不顯示,只回報進度(每 200 字一次)
            if (thinkingChars - lastThinkingSent >= 200) {
              lastThinkingSent = thinkingChars;
              yield { type: 'thinking', chars: thinkingChars };
            }
          }
          if (delta.content) yield { type: 'content', text: delta.content };
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (timeout.aborted) throw new LlmError(`AI 分析逾時(超過 ${Math.round(cfg.timeoutMs / 1000)} 秒)`, 'timeout', { cause: err });
      if (signal?.aborted) throw err;
      throw new LlmError('AI 服務連線中斷', 'unavailable', { cause: err });
    }
    yield { type: 'done', finish };
  }

  return { model, chatOnce, stream, url: cfg.url };
}
