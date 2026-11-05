/**
 * 串流驗證(IMPL-PLAN S0、PA-LIVE-PLAN §7):確認 SSE 經 Traefik → Nginx → BFF → netops-api 可以長時間穩定連線,
 * 作為 A1(AI 問答串流)與 R1(即時監控 GET /v1/pa-live/stream)的共同前提。
 * 後端 GET /v1/pa-live/stream-test 對外為 GET /api/netops/pa-live/stream-test。
 *
 * 為什麼可以長連線(不受 AGENT.md §7.3 的 10 秒路由逾時限制):
 *   - BFF 對上游的 headersTimeout / bodyTimeout 都等於路由逾時(x-timeout-ms);undici 的 bodyTimeout 是「兩個資料塊之間」的閒置時間,
 *     不是總時長。這裡先立即送出標頭與第一個事件,之後每 15 秒送 heartbeat,所以只要 x-timeout-ms(60 秒)大於心跳間隔就不會逾時。
 *   - BFF 斷路器計入的是:收到標頭之前的逾時與連線錯誤,以及上游回 5xx。串流已回 200 之後的中斷(使用者關頁、重連)不計入。
 *     所以名額滿時回 429(不是 503),避免有權限的人藉由連線滿額累積斷路器失敗、讓整個 netops-api 被短路。
 *   - Nginx 依回應標頭 X-Accel-Buffering: no 關閉這個回應的緩衝(BFF 原樣轉送這個標頭);proxy_read_timeout 60 秒同樣是閒置時間。
 * 因此不需改 Gateway。心跳間隔不可調到 60 秒以上。
 */
import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';

export interface StreamTestOptions {
  /** 心跳間隔(預設 15 秒;必須小於 x-timeout-ms 與 Nginx proxy_read_timeout 的 60 秒) */
  heartbeatMs?: number;
  /**
   * 單一連線最長時間,到時由伺服器結束、瀏覽器依 retry 自動重連(預設 10 分鐘)。
   * 重連時 BFF 重新檢查登入與權限,所以這也是登出 / 撤權後串流最晚停止的時間
   */
  maxMs?: number;
  /** 全系統同時連線上限(驗證用,預設 20) */
  maxStreams?: number;
  /** 每人(工號,沒有時用 sub)同時連線上限(預設 2),避免一個人佔滿全系統名額 */
  maxPerUser?: number;
}

/** 用戶端讀不動時,待送資料超過此大小就中斷(心跳很小,正常不會累積) */
const MAX_PENDING_BYTES = 64 * 1024;

/** 經 BFF 的路由逾時:BFF 允許的最大值(BACKEND-GUIDE §6.1),作為串流的閒置上限 */
const ROUTE_TIMEOUT_MS = 60_000;
/** 瀏覽器 EventSource 斷線後重連等待時間 */
const RETRY_MS = 5_000;
/** Last-Event-ID 只接受正整數序號(上限避免異常大數字) */
const LAST_ID = /^\d{1,9}$/;

const paLiveRoutes: FastifyPluginAsync<StreamTestOptions> = async (app, opts) => {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const maxStreams = opts.maxStreams ?? 20;
  const maxPerUser = opts.maxPerUser ?? 2;
  /** 進行中的串流 → 擁有者;preClose 用來結束全部串流 */
  const active = new Map<PassThrough, { owner: string; stop: () => void }>();
  const countOf = (owner: string) => [...active.values()].filter((a) => a.owner === owner).length;
  // 服務關閉時結束所有串流:要在 preClose(server.close 之前),onClose 時 server.close 已在等候長連線,會卡到最長時間
  app.addHook('preClose', async () => {
    for (const a of [...active.values()]) a.stop();
  });

  app.get(
    '/v1/pa-live/stream-test',
    {
      schema: {
        operationId: 'netops.pa-live.stream-test',
        summary: 'SSE 串流驗證(S0)',
        description:
          'Server-Sent Events 驗證用:連線後立即送 open 事件,之後每 15 秒送 heartbeat 事件(id 為序號,data 含 seq、伺服器時間 time、本次連線 connectionId 與已連線秒數)。' +
          '斷線後瀏覽器以 Last-Event-ID 重連時,序號接續並在 open 事件帶 resumedFrom。單一連線最長 10 分鐘後由伺服器結束(瀏覽器 5 秒後自動重連,BFF 重新檢查登入與權限);每人同時 2 條、全系統 20 條,超過回 429 NETOPS_STREAM_BUSY。' +
          '用來確認經 Nginx 與 BFF 不被緩衝、不因閒置逾時中斷(IMPL-PLAN S0)。',
        tags: ['連線驗證'],
        'x-permission': 'netops.ping.read',
        // 串流的閒置上限(BFF bodyTimeout 是資料塊之間的時間);心跳 15 秒,遠小於 60 秒
        'x-timeout-ms': ROUTE_TIMEOUT_MS,
        'x-gherkin': [
          '場景: 連線後立即收到 open 事件',
          '  假如 使用者已登入且擁有 netops.ping.read',
          '  當 以 EventSource 連線 GET /api/netops/pa-live/stream-test',
          '  那麼 回應 200 且 Content-Type 為 text/event-stream',
          '  而且 回應標頭 X-Accel-Buffering 為 "no"',
          '  而且 立即收到 event 為 "open" 的事件',
          '',
          '場景: 每 15 秒收到 heartbeat',
          '  假如 已連線 GET /api/netops/pa-live/stream-test',
          '  當 經過 60 秒',
          '  那麼 至少收到 4 個 event 為 "heartbeat" 的事件',
          '  而且 每個事件的 seq 遞增、time 為 ISO 8601',
          '',
          '場景: 斷線後重連序號接續',
          '  假如 上一次連線最後收到的 id 為 "7"',
          '  當 以 Last-Event-ID: 7 重新連線',
          '  那麼 open 事件的 resumedFrom 為 7',
          '  而且 下一個 heartbeat 的 seq 為 8',
          '',
          '場景: 沒有權限時拒絕',
          '  假如 使用者已登入但沒有 netops.ping.read',
          '  當 呼叫 GET /api/netops/pa-live/stream-test',
          '  那麼 回應 403',
        ].join('\n'),
        response: {
          200: { description: 'SSE 串流(text/event-stream):open、heartbeat 事件', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        },
      },
    },
    async (req, reply) => {
      // 429 而不是 5xx:BFF 斷路器會把上游 5xx 算成失敗(見檔頭)
      const owner = req.identity?.emp || req.identity?.sub || 'unknown';
      if (active.size >= maxStreams || countOf(owner) >= maxPerUser)
        throw new AppError(429, 'NETOPS_STREAM_BUSY', '串流連線數已達上限,請關閉其他分頁或稍後再試');
      // 驗證內部 Token 期間用戶端已斷線:close 事件已經發過,不建立串流(否則名額要等 maxMs 才釋放)
      if (req.raw.destroyed || reply.raw.destroyed) {
        reply.hijack();
        return reply;
      }

      const lastIdHeader = req.headers['last-event-id'];
      const resumedFrom = typeof lastIdHeader === 'string' && LAST_ID.test(lastIdHeader) ? Number(lastIdHeader) : null;
      let seq = resumedFrom ?? 0;
      const connectionId = req.id;
      const startedAt = Date.now();
      const stream = new PassThrough();

      /** 送一個事件:id 為目前序號;data 含序號、伺服器時間、連線代號、已連線秒數 */
      const send = (event: string, extra: Record<string, unknown> = {}) => {
        if (stream.writableEnded || stream.destroyed) return;
        const data = { seq, time: new Date().toISOString(), connectionId, elapsedSec: Math.round((Date.now() - startedAt) / 1000), ...extra };
        stream.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // 用戶端讀不動(卡住的連線)就中斷,不在記憶體累積
        if (stream.writableLength > MAX_PENDING_BYTES) stream.destroy();
      };
      const timer = setInterval(() => {
        seq++;
        send('heartbeat');
      }, heartbeatMs);
      const cleanup = () => {
        clearInterval(timer);
        clearTimeout(limit);
        active.delete(stream);
      };
      /** 正常結束(最長時間到、服務關閉):先停計時器再結束,避免對已結束的串流寫入 */
      const stop = () => {
        cleanup();
        stream.end();
      };
      const limit = setTimeout(stop, maxMs);
      active.set(stream, { owner, stop });
      stream.on('close', cleanup);
      stream.on('end', cleanup);
      // 使用者關頁或 BFF 中斷時 Node 會關閉回應,停止計時器
      reply.raw.on('close', () => {
        cleanup();
        stream.destroy();
      });

      // 第一個資料塊立即送出:讓標頭與 open 事件馬上到達(驗證沒有被緩衝),也避免 BFF headersTimeout
      stream.write(`retry: ${RETRY_MS}\n`);
      send('open', { heartbeatSec: heartbeatMs / 1000, maxSec: Math.round(maxMs / 1000), resumedFrom });

      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        // Nginx 依此標頭關閉這個回應的緩衝(PA-LIVE-PLAN §7)
        .header('x-accel-buffering', 'no')
        .send(stream);
    },
  );
};

export default paLiveRoutes;
