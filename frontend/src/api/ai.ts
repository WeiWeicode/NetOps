/**
 * AI 分析、問答、翻譯、整理筆記與知識庫的 AI 功能(docs/API.md §10;IMPL-PLAN A1)
 *   分析 / 問答 / 翻譯 / 整理筆記回 SSE(POST,EventSource 只能 GET):以 fetch 讀串流,帶 Cookie 與 CSRF、不帶 Bearer(同 gateway.ts download)
 *   權限:netops.ai.use(按鈕 netops.pa-ask.use、netops.ad-ask.use、netops.pa-dashboard.ai);整理筆記 netops.kb.write
 * 串流開始前的錯誤(400 / 404 / 409 / 429)丟 ApiError;開始後的錯誤是 error 事件(呼叫端丟出 AiStreamError)。
 */
import { ApiError, readCookie, redirectToLogin, refreshSession } from '@giganexus/web-kit';
import { http, type ApiPath } from './gateway';
import type { KbNote } from './kb';

export interface AiStatus {
  enabled: boolean;
  ok: boolean;
  model: string;
  message: string;
}

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** 串流中的 error 事件 */
export class AiStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * SSE 解析:依空行切事件,支援 \r\n、一個資料塊切在事件中間;data 是 JSON
 * 限制:只取第一行 data(netops-api 每個事件只有一行 data,JSON.stringify 不含換行)
 * 回傳 push(文字) → 這次完整的事件
 */
export function createSseParser() {
  let buffer = '';
  return (chunk: string): SseEvent[] => {
    buffer += chunk.replace(/\r\n/g, '\n');
    const out: SseEvent[] = [];
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: ?(.*)$/m.exec(block)?.[1];
      const data = /^data: ?(.*)$/m.exec(block)?.[1];
      if (!event || data === undefined) continue;
      try {
        out.push({ event, data: JSON.parse(data) });
      } catch {
        // 格式錯誤的事件略過
      }
    }
    return out;
  };
}

/** 串流開始前的錯誤 → ApiError(同 gateway.ts download) */
async function apiError(res: Response): Promise<ApiError> {
  let e: { code?: string; message?: string; requestId?: string; details?: unknown } = {};
  try {
    e = await res.json();
  } catch {
    // 非 JSON 錯誤
  }
  return new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? res.statusText, e.requestId ?? res.headers.get('X-Request-Id'), e.details);
}

/**
 * POST 一支 SSE API,逐一把事件交給 onEvent;收到 error 事件丟 AiStreamError;signal 中斷時丟 AbortError
 * heartbeat、open 不交給 onEvent
 */
export async function streamPost(path: ApiPath, body: unknown, onEvent: (e: SseEvent) => void, signal?: AbortSignal, retried = false): Promise<void> {
  const token = readCookie('gn_csrf');
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(token ? { 'X-CSRF-Token': token } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401 && !retried) {
    if (await refreshSession()) return streamPost(path, body, onEvent, signal, true);
    redirectToLogin();
    throw new ApiError(401, 'UNAUTHENTICATED', '登入已逾時', null);
  }
  if (!res.ok) throw await apiError(res);
  if (!res.body) throw new AiStreamError('NETOPS_AI_FAILED', '伺服器沒有回應內容');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  let finished = false;
  const handle = (events: SseEvent[]) => {
    for (const e of events) {
      if (e.event === 'heartbeat' || e.event === 'open') continue;
      if (e.event === 'error') {
        const d = e.data as { code?: string; message?: string };
        throw new AiStreamError(d.code ?? 'NETOPS_AI_FAILED', d.message ?? 'AI 回答失敗');
      }
      if (e.event === 'done') finished = true;
      onEvent(e);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      handle(parse(decoder.decode(value, { stream: true })));
    }
    // 最後一段沒有結尾空行時也要處理
    handle(parse(`${decoder.decode()}\n\n`));
  } finally {
    // 丟錯或中斷時關閉連線,後端停止產生內容
    void reader.cancel().catch(() => {});
  }
  // 沒收到 done 就結束:連線中途斷掉(代理逾時、服務重啟),已收到的內容不完整(AGENT.md §5)
  if (!finished) throw new AiStreamError('NETOPS_STREAM_INCOMPLETE', '連線中斷,回答可能不完整,請再試一次');
}

/** 一次性的 SSE(翻譯、整理筆記):回傳 done 事件的資料 */
async function streamResult<T>(path: ApiPath, body: unknown, signal?: AbortSignal): Promise<T> {
  let result: T | undefined;
  await streamPost(path, body, (e) => e.event === 'done' && (result = e.data as T), signal);
  if (result === undefined) throw new AiStreamError('NETOPS_AI_FAILED', '連線中斷,沒有收到結果,請再試一次');
  return result;
}

export interface VectorStatus {
  enabled: boolean;
  sync: boolean;
  collection: string;
  ok: boolean | null;
  points: number;
  lastSync: string | null;
  error: string;
  syncing: boolean;
  upserted: number;
  deleted: number;
}

export interface IpLearnStatus {
  enabled: boolean;
  busy: boolean;
  hour: number;
  phase?: string;
  done?: number;
  total?: number;
  log?: string[];
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string;
  learnedIps?: number;
  groups?: number;
  notes?: number;
  lastRun?: { at: string; by: string; range: string; candidates: number; looked: number; cached: number; manualSkip: number; failed: number; groups: number; notes: number } | null;
}

export const TRANSLATE_LANGS = [
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'th', label: 'ภาษาไทย' },
  { value: 'zh', label: '繁體中文' },
] as const;
export type TranslateTarget = (typeof TRANSLATE_LANGS)[number]['value'];

export const ai = {
  status: () => http.get<AiStatus>('/api/netops/ai/status'),
  /** 期間分析:from / to 為 YYYY-MM-DD */
  analyze: (body: { from: string; to: string; think: boolean; question: string }, onEvent: (e: SseEvent) => void, signal?: AbortSignal) =>
    streamPost('/api/netops/ai/analyses', body, onEvent, signal),
  /** 問答:from / to 為 ISO 8601 含時區 */
  ask: (body: { from: string; to: string; question: string; history: HistoryItem[]; think: boolean; source: 'pa' | 'ad' }, onEvent: (e: SseEvent) => void, signal?: AbortSignal) =>
    streamPost('/api/netops/ai/questions', body, onEvent, signal),
  translate: (text: string, target: TranslateTarget, signal?: AbortSignal) => streamResult<{ target: string; text: string; seconds: number }>('/api/netops/ai/translations', { text, target }, signal),
  note: (text: string, history: HistoryItem[], signal?: AbortSignal) => streamResult<{ note: KbNote }>('/api/netops/ai/notes', { text, history }, signal),
  semanticSearch: (q: string) => http.get<{ items: (KbNote & { score: number })[]; vector: VectorStatus }>('/api/netops/kb/semantic-search', { query: { q } }),
  vectorStatus: () => http.get<VectorStatus>('/api/netops/kb/vector-status'),
  vectorSync: () => http.post<VectorStatus>('/api/netops/kb/vector-syncs'),
  ipLearning: () => http.get<IpLearnStatus>('/api/netops/kb/ip-learning'),
  learnIps: (body: { days?: number; max?: number; rewrite?: boolean }) => http.post<IpLearnStatus>('/api/netops/kb/ip-learnings', body),
};
