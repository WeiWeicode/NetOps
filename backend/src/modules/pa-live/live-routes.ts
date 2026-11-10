/**
 * PA 即時監控 API(R1,docs/API.md §3.2;PA-LIVE-PLAN §8):/v1/pa-live/*,權限 netops.pa-realtime.read。
 * 只做驗證、權限宣告與格式轉換;讀取與研判在 service.ts。
 * SSE 照 S0 的寫法(docs/test-reports/2026-11-05-s0-sse.md §3.6、routes.ts 的 stream-test):
 *   x-timeout-ms 60000、立即送第一個事件、心跳 15 秒、X-Accel-Buffering: no、名額滿回 429、preClose 結束串流;
 *   單一連線最長 5 分鐘(需求方 2026-11-05 決定;重連時 BFF 重新檢查權限),即時 log 是原始明細 → x-audit-level: meta。
 */
import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import { isStreamId, LOG_TYPES, METRICS, type LogType, type Metric } from '../../infra/redis/index.js';
import { looseObject } from '../../shared/schemas.js';
import { matchLog, TOP_MINUTES, toLogItem, type LogFilter, type PaLiveService } from './service.js';

export interface LiveStreamOptions {
  /** 心跳間隔(預設 15 秒,必須小於 60 秒) */
  heartbeatMs?: number;
  /** 檢查新 log 的間隔(預設 2 秒) */
  pollMs?: number;
  /** 送設備快照的間隔(預設 10 秒,同收集器輪詢) */
  snapshotMs?: number;
  /** 單一連線最長時間(預設 5 分鐘) */
  maxMs?: number;
  maxStreams?: number;
  maxPerUser?: number;
}

const PERMISSION = 'netops.pa-realtime.read';
/** 測試區手動開關(寫入;只給 netops-admin,deploy/gateway-rbac.yaml netops.pa-live.manage) */
const WRITE_PERMISSION = 'netops.pa-realtime.write';
const ROUTE_TIMEOUT_MS = 60_000;
const RETRY_MS = 5_000;
const MAX_PENDING_BYTES = 256 * 1024;
/** 每次檢查每種類型最多讀幾筆;超過表示跟不上(例如 TRAFFIC 尖峰),直接跳到最新並標示 skipped */
const READ_PER_TICK = 500;
/** 每個 logs 事件最多送幾筆(篩選後) */
const SEND_PER_TICK = 200;
/** Last-Event-ID 比現在早超過這個時間就不接續(從最新開始,在 open 標示 gap):重連只補斷線期間,不用來撈舊明細 */
const RESUME_MAX_MS = 5 * 60_000;

const ipPattern = '^[0-9A-Fa-f:.]{2,45}$';
const typeSchema = { type: 'string', enum: [...LOG_TYPES], description: 'log 類型' } as const;
const filterProps = {
  ip: { type: 'string', pattern: ipPattern, description: '比對來源、目的、NAT 與 GlobalProtect / User-ID 的 IP 欄位(完全相同)' },
  port: { type: 'integer', minimum: 0, maximum: 65535, description: '比對目的或來源 Port' },
  action: { type: 'string', pattern: '^[a-z-]{1,30}$', description: 'Action(allow、deny、drop、reset-both…)' },
} as const;

/** Last-Event-ID / 游標:type:streamId,以逗號分隔(例 traffic:1762300000000-0,threat:1762299999000-3) */
const CURSOR = new RegExp(`^(?:(?:${LOG_TYPES.join('|')}):\\d{1,15}-\\d{1,10})(?:,(?:${LOG_TYPES.join('|')}):\\d{1,15}-\\d{1,10}){0,${LOG_TYPES.length - 1}}$`);

export function parseCursor(raw: unknown): Partial<Record<LogType, string>> | null {
  if (typeof raw !== 'string' || raw.length > 400 || !CURSOR.test(raw)) return null;
  const out: Partial<Record<LogType, string>> = {};
  for (const part of raw.split(',')) {
    const i = part.indexOf(':');
    out[part.slice(0, i) as LogType] = part.slice(i + 1);
  }
  return out;
}

const formatCursor = (c: Partial<Record<LogType, string>>) =>
  Object.entries(c)
    .map(([t, id]) => `${t}:${id}`)
    .join(',');

const paLiveLiveRoutes: FastifyPluginAsync<{ live: PaLiveService; stream?: LiveStreamOptions }> = async (app, { live, stream: opts = {} }) => {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const pollMs = opts.pollMs ?? 2_000;
  const snapshotMs = opts.snapshotMs ?? 10_000;
  const maxMs = opts.maxMs ?? 5 * 60_000;
  const maxStreams = opts.maxStreams ?? 20;
  const maxPerUser = opts.maxPerUser ?? 2;
  const active = new Map<PassThrough, { owner: string; stop: () => void }>();
  const countOf = (owner: string) => [...active.values()].filter((a) => a.owner === owner).length;
  app.addHook('preClose', async () => {
    for (const a of [...active.values()]) a.stop();
  });

  app.get(
    '/v1/pa-live/snapshot',
    {
      schema: {
        operationId: 'netops.pa-live.snapshot',
        summary: '即時監控:收集器狀態與設備快照',
        description:
          '收集器狀態 collector(state:ok、degraded、disabled、stopped、not-running、unavailable;message 為中文說明)與各指標最新快照 metrics(session、cpu、throughput、interfaces)。' +
          '快照 60 秒沒更新就過期為 null;收集器停止(心跳超過 30 秒)時全部為 null,不把舊資料當即時。Redis 連不上時仍回 200,state 為 unavailable。',
        tags: ['PA 即時監控'],
        'x-permission': PERMISSION,
        'x-gherkin': [
          '場景: 收集器運作中時回傳設備快照',
          '  假如 收集器心跳在 30 秒內更新且 Session 快照存在',
          '  當 呼叫 GET /api/netops/pa-live/snapshot',
          '  那麼 回應 200',
          '  而且 collector.state 為 "ok"、metrics.session.active 為數字',
          '',
          '場景: 收集器停止時不顯示舊快照',
          '  假如 收集器心跳超過 30 秒沒有更新',
          '  當 呼叫 GET /api/netops/pa-live/snapshot',
          '  那麼 collector.state 為 "stopped"',
          '  而且 metrics 的每個指標都是 null',
          '',
          '場景: 收集器未啟用',
          '  假如 收集器的輪詢與接收都關閉',
          '  當 呼叫 GET /api/netops/pa-live/snapshot',
          '  那麼 collector.state 為 "disabled"',
          '',
          '場景: Redis 連不上',
          '  假如 netops-redis 停止',
          '  當 呼叫 GET /api/netops/pa-live/snapshot',
          '  那麼 回應 200 且 collector.state 為 "unavailable"',
        ].join('\n'),
        response: { 200: looseObject('{ collector, metrics }(docs/API.md §3.2)') },
      },
    },
    async () => live.snapshot(),
  );

  app.put<{ Body: { pollPaused?: boolean; receivePaused?: boolean } }>(
    '/v1/pa-live/collector-control',
    {
      schema: {
        operationId: 'netops.pa-live.collector-control',
        summary: '即時監控:測試區暫停 / 繼續收集器',
        description:
          '測試區手動開關(2026-11-09 需求方決定):pollPaused 暫停 / 繼續 SDK 輪詢 PA-560,receivePaused 暫停 / 繼續 HTTP 與 Syslog 接收(暫停期間收到的 log 丟棄並計數 paused)。至少給一個欄位;只寫要求的狀態,' +
          '收集器在下一次輪詢前(輪詢)或 5 秒內(接收)套用,實際狀態看 snapshot 的 collector.poll.paused / receive.paused。主機設定的總開關(PA_POLL_ENABLED / PA_RECEIVE_ENABLED)關閉時,寫入照樣成功但不會生效(畫面停用該按鈕)。' +
          '只有測試區可用,正式區回 403 NETOPS_PA_CONTROL_DISABLED。回應為 control(要求的狀態、最後操作人與時間)。',
        tags: ['PA 即時監控'],
        'x-permission': WRITE_PERMISSION,
        // 稽核記錄操作人與要求內容(本文只有兩個布林值)
        'x-audit-level': 'body',
        'x-gherkin': [
          '場景: 測試區暫停輪詢',
          '  假如 部署區為測試區且使用者擁有 netops.pa-realtime.write',
          '  當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"pollPaused": true}',
          '  那麼 回應 200',
          '  而且 control.pollPaused 為 true、control.updatedBy 為操作人',
          '  而且 收集器在下一次輪詢前停止查詢 PA-560,心跳 collector.poll.paused 變為 true',
          '',
          '場景: 繼續接收',
          '  假如 接收已暫停',
          '  當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"receivePaused": false}',
          '  那麼 回應 200 且 control.receivePaused 為 false',
          '',
          '場景: 沒有給任何欄位',
          '  當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {}',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: 正式區不能切換',
          '  假如 部署區為正式區',
          '  當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"pollPaused": true}',
          '  那麼 回應 403 且 code 為 "NETOPS_PA_CONTROL_DISABLED"',
          '',
          '場景: 檢視者不能切換',
          '  假如 使用者只有 netops.pa-realtime.read',
          '  當 呼叫 PUT /api/netops/pa-live/collector-control',
          '  那麼 回應 403',
          '',
          '場景: Redis 連不上',
          '  假如 netops-redis 停止',
          '  當 呼叫 PUT /api/netops/pa-live/collector-control,內容 {"pollPaused": true}',
          '  那麼 回應 424 NETOPS_REDIS_UNAVAILABLE',
        ].join('\n'),
        body: {
          type: 'object',
          additionalProperties: false,
          // 至少一個欄位(Fastify 會先移除未知欄位,所以不用 minProperties)
          anyOf: [{ required: ['pollPaused'] }, { required: ['receivePaused'] }],
          properties: {
            pollPaused: { type: 'boolean', description: 'true 暫停 SDK 輪詢、false 繼續' },
            receivePaused: { type: 'boolean', description: 'true 暫停 HTTP / Syslog 接收、false 繼續' },
          },
        },
        response: { 200: looseObject('control:{ available, pollPaused, receivePaused, updatedAt, updatedBy }') },
      },
    },
    async (req) => {
      const emp = req.identity?.emp || req.identity?.sub || 'unknown';
      const name = req.identity?.name;
      const control = await live.setControl(req.body, name ? `${name}(${emp})` : emp);
      // 操作紀錄(BFF 另有稽核);只記工號與要求的狀態
      req.log.info({ emp, change: req.body }, '測試區收集器開關已切換');
      return control;
    },
  );

  app.get<{ Querystring: { metric: Metric; minutes?: number } }>(
    '/v1/pa-live/series',
    {
      schema: {
        operationId: 'netops.pa-live.series',
        summary: '即時監控:設備指標趨勢',
        description: '最近 minutes 分鐘(1–120,預設 60)的快照歷史(由舊到新,最多約 360 點,超過時平均抽樣)。保留 2 天。',
        tags: ['PA 即時監控'],
        'x-permission': PERMISSION,
        'x-gherkin': [
          '場景: 查詢最近 1 小時 CPU 趨勢',
          '  當 呼叫 GET /api/netops/pa-live/series?metric=cpu&minutes=60',
          '  那麼 回應 200',
          '  而且 points 依時間由舊到新',
        ].join('\n'),
        querystring: {
          type: 'object',
          required: ['metric'],
          additionalProperties: false,
          properties: { metric: { type: 'string', enum: [...METRICS] }, minutes: { type: 'integer', minimum: 1, maximum: 120, default: 60 } },
        },
        response: { 200: looseObject('{ metric, minutes, points }') },
      },
    },
    async (req) => live.series(req.query.metric, req.query.minutes ?? 60),
  );

  app.get<{ Querystring: { type: LogType; minutes: number; limit?: number; dims?: string } }>(
    '/v1/pa-live/top',
    {
      schema: {
        operationId: 'netops.pa-live.top',
        summary: '即時監控:排行與統計',
        description:
          '合併最近 5 / 15 / 60 分鐘的每分鐘統計:totals(次數 count;TRAFFIC 另有 bytes、packets)、kpis(動作、嚴重度等分布)、tops(各維度前 limit 名;每分鐘只保留前 200 名,合併後為近似值)、perMinute(每分鐘次數)。' +
          '次數已乘上 Repeat Count(TRAFFIC 除外)。Redis 連不上回 424 NETOPS_REDIS_UNAVAILABLE(不用 5xx,避免累積 BFF 斷路器失敗)。',
        tags: ['PA 即時監控'],
        'x-permission': PERMISSION,
        'x-gherkin': [
          '場景: 查詢最近 15 分鐘 TRAFFIC 排行',
          '  當 呼叫 GET /api/netops/pa-live/top?type=traffic&minutes=15',
          '  那麼 回應 200',
          '  而且 tops.src 依次數由大到小',
          '',
          '場景: 不支援的期間',
          '  當 呼叫 GET /api/netops/pa-live/top?type=traffic&minutes=30',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        querystring: {
          type: 'object',
          required: ['type', 'minutes'],
          additionalProperties: false,
          properties: {
            type: typeSchema,
            minutes: { type: 'integer', enum: [...TOP_MINUTES] },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            dims: { type: 'string', pattern: '^[A-Za-z]{1,20}(,[A-Za-z]{1,20}){0,9}$', description: '只回這些維度(逗號分隔);省略為該類型全部' },
          },
        },
        response: { 200: looseObject('{ type, minutes, totals, kpis, tops, perMinute, retentionSec }') },
      },
    },
    async (req) => live.top(req.query.type, req.query.minutes, req.query.limit ?? 20, req.query.dims?.split(',')),
  );

  app.get<{ Querystring: { type: LogType; limit?: number; before?: string } & LogFilter }>(
    '/v1/pa-live/logs',
    {
      schema: {
        operationId: 'netops.pa-live.logs',
        summary: '即時監控:最新 log',
        description:
          '某類型最新的 log 明細(由新到舊),可依 IP、Port、Action 篩選;before 為上一頁的 nextBefore。篩選時一次最多掃描 5000 筆,沒湊滿時 truncated 為 true。' +
          'earliest 為 Redis 內最早一筆的時間(TRAFFIC 只保留 1 小時、其他 2 天),更早的請用 Log 明細查詢(FTP)。原始明細,稽核記錄查詢條件。',
        tags: ['PA 即時監控'],
        'x-permission': PERMISSION,
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 查詢最新 TRAFFIC log',
          '  當 呼叫 GET /api/netops/pa-live/logs?type=traffic&limit=50',
          '  那麼 回應 200',
          '  而且 items 依時間由新到舊、最多 50 筆',
          '  而且 earliest 為 Redis 內最早一筆的時間',
          '',
          '場景: 依 IP 篩選',
          '  當 呼叫 GET /api/netops/pa-live/logs?type=threat&ip=10.1.2.3',
          '  那麼 items 的來源或目的 IP 都是 10.1.2.3',
          '',
          '場景: Redis 連不上時明確失敗',
          '  假如 netops-redis 停止',
          '  當 呼叫 GET /api/netops/pa-live/logs?type=traffic',
          '  那麼 回應 424 NETOPS_REDIS_UNAVAILABLE',
        ].join('\n'),
        querystring: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: typeSchema,
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
            // 毫秒部分不可為 0:XREVRANGE 的 (0-0 是無效區間(Redis 回錯誤)
            before: { type: 'string', pattern: '^[1-9]\\d{0,14}-\\d{1,10}$', description: '上一頁回應的 nextBefore' },
            ...filterProps,
          },
        },
        response: { 200: looseObject('{ type, items, nextBefore, scanned, truncated, earliest, retentionSec }') },
      },
    },
    async (req) => {
      const { type, limit, before, ...filter } = req.query;
      return live.logs(type, limit ?? 100, filter, before);
    },
  );

  app.get<{ Querystring: { types?: string } & LogFilter }>(
    '/v1/pa-live/stream',
    {
      schema: {
        operationId: 'netops.pa-live.stream',
        summary: '即時監控串流(SSE)',
        description:
          'Server-Sent Events:連線後立即送 open;每 10 秒 snapshot(同 GET /snapshot);有新 log 時送 logs(types 指定的類型,預設 traffic,threat;可依 ip、port、action 篩選;每次最多 200 筆,跟不上時跳到最新並帶 skipped);每 15 秒 heartbeat。' +
          'logs 事件的 id 為各類型的游標,斷線後瀏覽器以 Last-Event-ID 重連時接續(超過保留時間的已不存在)。單一連線最長 5 分鐘後由伺服器結束,瀏覽器 5 秒後自動重連(BFF 重新檢查登入與權限)。' +
          '每人同時 2 條、全系統 20 條,超過回 429 NETOPS_STREAM_BUSY。原始明細,稽核記錄查詢條件。',
        tags: ['PA 即時監控'],
        'x-permission': PERMISSION,
        'x-audit-level': 'meta',
        'x-timeout-ms': ROUTE_TIMEOUT_MS,
        'x-gherkin': [
          '場景: 連線後立即收到 open 與 snapshot',
          '  假如 使用者已登入且擁有 netops.pa-realtime.read',
          '  當 以 EventSource 連線 GET /api/netops/pa-live/stream',
          '  那麼 回應 200 且 Content-Type 為 text/event-stream',
          '  而且 立即收到 open 與 snapshot 事件',
          '',
          '場景: 有新 log 時收到 logs 事件',
          '  假如 已連線 GET /api/netops/pa-live/stream?types=traffic',
          '  當 收集器寫入新的 TRAFFIC log',
          '  那麼 收到 event 為 "logs" 的事件,id 為游標',
          '',
          '場景: 斷線後以 Last-Event-ID 接續',
          '  假如 上一次連線最後收到的 id 為 traffic 的游標',
          '  當 以 Last-Event-ID 重新連線',
          '  那麼 只收到游標之後的 log',
          '',
          '場景: 連線數超過上限',
          '  假如 同一使用者已有 2 條串流',
          '  當 再連線 GET /api/netops/pa-live/stream',
          '  那麼 回應 429 NETOPS_STREAM_BUSY',
        ].join('\n'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            types: { type: 'string', pattern: `^(${LOG_TYPES.join('|')})(,(${LOG_TYPES.join('|')})){0,7}$`, default: 'traffic,threat' },
            ...filterProps,
          },
        },
        response: {
          200: { description: 'SSE 串流(text/event-stream):open、snapshot、logs、heartbeat', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        },
      },
    },
    async (req, reply) => {
      const owner = req.identity?.emp || req.identity?.sub;
      // 正常經 Gateway 一定有身分;沒有時不放行(不讓無身分的請求共用名額)
      if (!owner) throw new AppError(403, 'NETOPS_STREAM_OWNER_UNKNOWN', '身分沒有工號也沒有 sub,不能建立串流');
      if (active.size >= maxStreams || countOf(owner) >= maxPerUser)
        throw new AppError(429, 'NETOPS_STREAM_BUSY', '串流連線數已達上限,請關閉其他分頁或稍後再試');
      if (req.raw.destroyed || reply.raw.destroyed) {
        reply.hijack();
        return reply;
      }
      const { types: rawTypes, ...filter } = req.query;
      const types = [...new Set((rawTypes ?? 'traffic,threat').split(','))] as LogType[];
      const redis = live.redis;
      const resumed = parseCursor(req.headers['last-event-id']);

      // 游標:每種類型最後送出的 Stream ID;沒有 Last-Event-ID 時從目前最新開始(只送連線之後的 log)
      const cursor: Partial<Record<LogType, string>> = {};
      const stream = new PassThrough();
      const send = (event: string, data: unknown, id?: string) => {
        if (stream.writableEnded || stream.destroyed) return;
        stream.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // 用戶端讀不動:中斷連線(連同底層回應),不在記憶體累積
        if (stream.writableLength > MAX_PENDING_BYTES) {
          stream.destroy(new Error('slow consumer'));
          reply.raw.destroy();
        }
      };

      let busy = false;
      /** 連續讀取失敗的次數;第一次失敗與恢復時各通知畫面一次 */
      let failures = 0;
      const pollLogs = async () => {
        if (busy || !redis) return;
        busy = true;
        try {
          const items = [];
          const skipped: LogType[] = [];
          const failed: LogType[] = [];
          for (const t of types) {
            try {
              const from = cursor[t];
              if (!from) {
                // 起點還沒取得(連線時 Redis 失敗):這次只取最新的 ID,不送舊資料
                cursor[t] = await redis.latestLogId(t);
                continue;
              }
              const rows = await redis.logsAfter(t, from, READ_PER_TICK);
              if (!rows.length) continue;
              if (rows.length >= READ_PER_TICK) {
                // 跟不上:跳到最新,告訴畫面中間有略過
                skipped.push(t);
                cursor[t] = await redis.latestLogId(t);
              } else cursor[t] = rows[rows.length - 1]!.id;
              for (const e of rows) if (matchLog(e.data, filter)) items.push(toLogItem(t, e));
            } catch (err) {
              // 這個類型的游標不推進,下次重讀;其他類型照常送出
              failed.push(t);
              if (failures === 0) req.log.warn({ err, type: t }, '即時串流讀取 log 失敗');
            }
          }
          if (failed.length) {
            if (failures++ === 0) send('degraded', { types: failed, message: '即時 log 暫停更新(無法讀取 Redis),恢復後自動補上' });
          } else if (failures) {
            failures = 0;
            send('degraded', { types: [], message: '' });
          }
          if (items.length || skipped.length) {
            items.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1));
            send('logs', { items: items.slice(-SEND_PER_TICK), dropped: Math.max(0, items.length - SEND_PER_TICK), skipped }, formatCursor(cursor));
          }
        } finally {
          busy = false;
        }
      };
      const pushSnapshot = async () => {
        try {
          send('snapshot', await live.snapshot());
        } catch (err) {
          // 非預期錯誤(Redis 錯誤已在 snapshot 轉成 unavailable):記錄並略過這次
          req.log.warn({ err }, '即時串流 snapshot 失敗');
        }
      };

      const timers: NodeJS.Timeout[] = [];
      const cleanup = () => {
        for (const t of timers) clearInterval(t);
        clearTimeout(limit);
        active.delete(stream);
      };
      const stop = () => {
        cleanup();
        stream.end();
      };
      const limit = setTimeout(stop, maxMs);
      active.set(stream, { owner, stop });
      stream.on('close', cleanup);
      reply.raw.on('close', () => {
        cleanup();
        stream.destroy();
      });

      // 第一個資料塊立即送出(S0 規則 2)
      stream.write(`retry: ${RETRY_MS}\n`);
      // 起點:Last-Event-ID 有該類型且在 5 分鐘內就接續;否則從最新開始(太舊的列在 gap)
      const gap: LogType[] = [];
      for (const t of types) {
        const id = resumed?.[t];
        if (id && isStreamId(id) && Number(id.split('-')[0]) >= Date.now() - RESUME_MAX_MS) cursor[t] = id;
        else if (id) gap.push(t);
      }
      send('open', { types, filter, heartbeatSec: heartbeatMs / 1000, maxSec: Math.round(maxMs / 1000), resumed: !!resumed, gap });

      void (async () => {
        // 沒有游標的類型取最新的 ID;失敗的留給 pollLogs 下次再取(不用本機時間猜,避免與收集器主機的時鐘差)
        for (const t of types) {
          if (cursor[t] || !redis) continue;
          try {
            cursor[t] = await redis.latestLogId(t);
          } catch {
            // pollLogs 會重試
          }
        }
        await pushSnapshot();
        timers.push(
          setInterval(() => void pollLogs(), pollMs),
          setInterval(() => void pushSnapshot(), snapshotMs),
          setInterval(() => send('heartbeat', { time: new Date().toISOString() }), heartbeatMs),
        );
        // 已在等待期間結束:清掉剛建立的計時器
        if (stream.destroyed || stream.writableEnded) cleanup();
      })();

      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('x-accel-buffering', 'no')
        .send(stream);
    },
  );
};

export default paLiveLiveRoutes;
