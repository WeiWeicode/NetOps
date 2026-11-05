/**
 * AI 回答串流(SSE;IMPL-PLAN A1)。寫法依 S0 報告 §3.6 與 modules/pa-live/routes.ts:
 *   - OpenAPI 設 x-timeout-ms: 60000(BFF 的逾時是資料塊之間的閒置時間)
 *   - 標頭與第一個事件立即送出;之後每 15 秒送 heartbeat(掃描 FTP、模型思考時可能很久沒有事件)
 *   - 回 X-Accel-Buffering: no、Cache-Control: no-cache, no-transform
 *   - 名額滿回 429 NETOPS_STREAM_BUSY(不回 5xx,BFF 斷路器會把上游 5xx 計為失敗)
 *   - 服務關閉在 preClose 結束全部串流;使用者關頁時 signal 中斷掃描與模型呼叫
 * 問答與分析是一次性的回答(POST,前端用 fetch 讀串流),不重連、不帶 Last-Event-ID。
 */
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../errors.js';
import { LlmError } from '../../infra/llm/index.js';

/** 經 BFF 的路由逾時(BFF 允許的最大值),也是串流的閒置上限 */
export const SSE_TIMEOUT_MS = 60_000;
/** 用戶端讀不動時,待送資料超過此大小就中斷 */
const MAX_PENDING_BYTES = 1024 * 1024;

export interface SseStream {
  /** 送一個事件(串流已結束時不做事) */
  send(event: string, data: unknown): void;
  /** 使用者關頁、BFF 中斷、單一連線最長時間到或服務關閉時中斷 */
  signal: AbortSignal;
  end(): void;
}

export interface SseHubOptions {
  maxStreams: number;
  maxPerUser: number;
  heartbeatMs?: number;
  /** 單一連線最長時間(到時送 error 並結束;預設 15 分鐘:掃描 + 深入思考的上限再加餘裕) */
  maxMs?: number;
}

export type SseHub = ReturnType<typeof createSseHub>;

/** 全部 AI 串流共用的名額(問答、分析、翻譯、整理筆記) */
export function createSseHub(app: FastifyInstance, opts: SseHubOptions) {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxMs = opts.maxMs ?? 15 * 60_000;
  const active = new Map<PassThrough, { owner: string; stop: (reason: string) => void }>();
  const countOf = (owner: string) => [...active.values()].filter((a) => a.owner === owner).length;
  app.addHook('preClose', async () => {
    for (const a of [...active.values()]) a.stop('服務正在重新啟動,請稍後再試');
  });

  /** 先檢查名額(超過丟 429);通過才可開始串流。驗證參數要在這之前做完(錯誤要用 4xx 回應,不是事件) */
  function reserve(req: FastifyRequest) {
    const owner = req.identity?.emp || req.identity?.sub || 'unknown';
    if (active.size >= opts.maxStreams || countOf(owner) >= opts.maxPerUser)
      throw new AppError(429, 'NETOPS_STREAM_BUSY', 'AI 回答進行中的數量已達上限,請等目前的回答完成或關閉其他分頁後再試');
    return owner;
  }

  /**
   * 開始串流:回傳 SseStream,並在背景執行 run(stream);run 結束(或丟錯)後關閉串流。
   * run 丟出的錯誤送 error 事件({ code, message });非預期錯誤只回固定訊息,原文寫日誌。
   */
  function open(req: FastifyRequest, reply: FastifyReply, owner: string, run: (s: SseStream) => Promise<void>) {
    // 解析請求或驗證 Token 期間用戶端已斷線:close 事件已經發過,不開始(否則掃描與模型照跑、名額佔到最長時間)
    if (req.raw.destroyed || reply.raw.destroyed) {
      reply.hijack();
      return reply;
    }
    const stream = new PassThrough();
    const abort = new AbortController();
    let ended = false;
    const send = (event: string, data: unknown) => {
      if (ended || stream.destroyed) return;
      stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (stream.writableLength > MAX_PENDING_BYTES) {
        req.log.warn({ pending: stream.writableLength }, 'AI 串流用戶端讀不動,已中斷');
        stop('');
      }
    };
    const cleanup = () => {
      clearInterval(heartbeat);
      clearTimeout(limit);
      active.delete(stream);
    };
    /** 結束串流;同時中斷還在進行的工作(例如翻譯其中一段失敗時,其餘段落不再等) */
    const end = () => {
      if (ended) return;
      ended = true;
      abort.abort();
      cleanup();
      stream.end();
    };
    /** 中斷:reason 有值時先送 error 事件 */
    const stop = (reason: string) => {
      if (reason) send('error', { code: 'NETOPS_STREAM_CLOSED', message: reason });
      abort.abort();
      end();
    };
    const heartbeat = setInterval(() => send('heartbeat', { time: new Date().toISOString() }), heartbeatMs);
    const limit = setTimeout(() => stop(`回答超過 ${Math.round(maxMs / 60000)} 分鐘,已中止`), maxMs);
    active.set(stream, { owner, stop });
    reply.raw.on('close', () => {
      abort.abort();
      cleanup();
      ended = true;
      stream.destroy();
    });

    // 立即送出第一個資料塊(標頭與 open 一起到達,也避免 BFF headersTimeout)
    send('open', { requestId: req.id, heartbeatSec: heartbeatMs / 1000 });
    const s: SseStream = { send, signal: abort.signal, end };
    void run(s)
      .catch((err: unknown) => {
        if (abort.signal.aborted || ended) return;
        if (err instanceof AppError) return send('error', { code: err.code, message: err.message });
        // 模型錯誤的訊息是分類過的(不含主機位址),原文在 cause,只寫日誌
        req.log.error({ err, cause: (err as { cause?: unknown }).cause }, 'AI 串流發生錯誤');
        if (err instanceof LlmError) send('error', { code: err.kind === 'timeout' ? 'NETOPS_AI_TIMEOUT' : 'NETOPS_AI_UNAVAILABLE', message: `AI 分析失敗:${err.message}` });
        else send('error', { code: 'NETOPS_AI_FAILED', message: 'AI 回答失敗,請稍後再試' });
      })
      .finally(end);

    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no')
      .send(stream);
  }

  return { reserve, open, activeCount: () => active.size };
}
