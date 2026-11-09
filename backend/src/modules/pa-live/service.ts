/**
 * PA 即時監控核心(R1,PA-LIVE-PLAN §3.3、§8):讀 netops-redis(infra/redis),不依賴 Fastify。
 * 失敗要明確(AGENT.md §5):
 *   - 收集器心跳超過 STALE_SEC 沒更新 → state "stopped";快照過期(60 秒 TTL)→ 該指標為 null,畫面顯示「停止更新」,不顯示舊快照
 *   - 收集器兩個開關都關 → state "disabled"(測試區預設,畫面顯示「未啟用」)
 *   - Redis 連不上 → status / snapshot 回 state "unavailable"(200);其他查詢回 424 NETOPS_REDIS_UNAVAILABLE。
 *     不用 5xx:BFF 斷路器把上游 5xx 計為失敗,頁面輪詢會讓整個 netops-api 被短路(S0 報告 §3.6 第 4 條同理)。
 *   - 收集器寫在心跳的錯誤原文可能含內部位址,回給畫面前只留分類(summarizeError),原文看收集器日誌
 */
import { AppError } from '../../errors.js';
import {
  AGG_RETENTION_SEC,
  LOG_RETENTION_SEC,
  LOG_TYPES,
  METRICS,
  minuteBucket,
  RedisReplyError,
  RedisUnavailableError,
  TOP_DIMS,
  type LogType,
  type Metric,
  type PaLiveRedis,
  type StreamEntry,
} from '../../infra/redis/index.js';

/** 心跳每 5 秒寫一次;超過 30 秒沒更新視為收集器停止 */
export const STALE_SEC = 30;
/** 排行與統計可查的期間(分鐘) */
export const TOP_MINUTES = [5, 15, 60] as const;
/** 明細查詢一次最多掃描幾筆(由新到舊),避免篩選條件很少命中時掃完整個 Stream */
export const LOG_SCAN_MAX = 5000;
const LOG_SCAN_CHUNK = 500;

export type CollectorState = 'ok' | 'degraded' | 'disabled' | 'stopped' | 'not-running' | 'unavailable';

export interface CollectorStatus {
  state: CollectorState;
  /** 給畫面的中文說明 */
  message: string;
  updatedAt: string | null;
  version: string | null;
  poll: { enabled: boolean; lastOkAt: string | null; error: string | null; errorAt: string | null };
  receive: { enabled: boolean; tls: boolean; httpLastAt: string | null; syslogLastAt: string | null };
  redis: { error: string | null; errorAt: string | null };
  counters: Record<'received' | 'dropped' | 'rejected' | 'malformed' | 'redisFailed', number>;
}

const MESSAGES: Record<CollectorState, string> = {
  ok: '收集器運作中',
  degraded: '收集器運作中,但有錯誤(見錯誤訊息);相關資料可能停止更新',
  disabled: '收集器未啟用(輪詢與接收都關閉;測試區只在測試時開啟)',
  stopped: '收集器停止更新:資料不是即時的',
  'not-running': '收集器沒有啟動過(Redis 沒有心跳)',
  unavailable: '無法連線即時資料庫(Redis):資料停止更新',
};

const s = (v: string | undefined) => (v ? v : null);

/** 錯誤原文 → 分類(不含主機、IP、網址);收集器格式為「項目: 訊息; 項目: 訊息」 */
const ERROR_RULES: [RegExp, string][] = [
  [/invalid credential|403|unauthori[sz]ed|api key/i, 'API Key 無效或權限不足'],
  [/timed? ?out|timeout/i, '連線逾時'],
  [/certificate|ssl|tls/i, '憑證驗證失敗'],
  [/refused|unreachable|no route|errno|urlerror|name or service|getaddrinfo|connection/i, '連不到主機'],
  [/oom|maxmemory|memory/i, 'Redis 記憶體已滿'],
  [/invalid syntax|not supported|unknown command/i, '設備不支援此查詢(PAN-OS 版本差異)'],
];
export function summarizeError(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw
    .split(/;\s*/)
    .filter(Boolean)
    .slice(0, 8)
    .map((p) => {
      const m = /^([a-z]{2,20}):\s*(.*)$/i.exec(p);
      const msg = m ? m[2]! : p;
      return `${m ? `${m[1]}:` : ''}${ERROR_RULES.find(([re]) => re.test(msg))?.[1] ?? '查詢失敗(詳見收集器日誌)'}`;
    })
    .join(';');
}
const n = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : 0);

/** 心跳 Hash → 狀態(純函式) */
export function deriveStatus(hb: Record<string, string> | null, nowMs: number): CollectorStatus {
  const base = (state: CollectorState): CollectorStatus => ({
    state,
    message: MESSAGES[state],
    updatedAt: s(hb?.updatedAt),
    version: s(hb?.version),
    poll: { enabled: hb?.pollEnabled === '1', lastOkAt: s(hb?.pollOkAt), error: summarizeError(hb?.pollError), errorAt: s(hb?.pollErrorAt) },
    receive: { enabled: hb?.receiveEnabled === '1', tls: hb?.receiveTls === '1', httpLastAt: s(hb?.httpOkAt), syslogLastAt: s(hb?.syslogOkAt) },
    redis: { error: summarizeError(hb?.redisError), errorAt: s(hb?.redisErrorAt) },
    counters: { received: n(hb?.received), dropped: n(hb?.dropped), rejected: n(hb?.rejected), malformed: n(hb?.malformed), redisFailed: n(hb?.redisFailed) },
  });
  if (!hb) return base('not-running');
  const updated = Date.parse(hb.updatedAt ?? '');
  if (!Number.isFinite(updated) || nowMs - updated > STALE_SEC * 1000) return base('stopped');
  const st = base('ok');
  if (!st.poll.enabled && !st.receive.enabled) return base('disabled');
  if ((st.poll.enabled && st.poll.error) || st.redis.error) return { ...st, state: 'degraded', message: MESSAGES.degraded };
  return st;
}

const withCause = (e: AppError, cause: unknown) => {
  (e as { cause?: unknown }).cause = cause;
  return e;
};

/** Redis 連不上 → 424(不是 5xx,見檔頭);Redis 回錯誤 → 500(程式或資料問題,要修);原因由錯誤處理寫日誌 */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RedisUnavailableError)
      throw withCause(new AppError(424, 'NETOPS_REDIS_UNAVAILABLE', '無法讀取即時資料(Redis),請稍後再試;歷史資料請用 Log 明細查詢'), err);
    if (err instanceof RedisReplyError) throw withCause(new AppError(500, 'INTERNAL_ERROR', '系統發生錯誤'), err);
    throw err;
  }
}

export interface LogFilter {
  ip?: string;
  port?: number;
  action?: string;
}

const IP_FIELDS = ['src', 'dst', 'natSrc', 'natDst', 'ip', 'publicIp', 'privateIp'] as const;

/** log 篩選(純函式):IP 比對所有 IP 欄位、Port 比對目的或來源 Port、Action 完全相同 */
export function matchLog(d: Record<string, unknown>, f: LogFilter): boolean {
  if (f.ip && !IP_FIELDS.some((k) => d[k] === f.ip)) return false;
  if (f.port !== undefined && d.dport !== f.port && d.sport !== f.port) return false;
  if (f.action && d.action !== f.action) return false;
  return true;
}

export interface LogItem {
  id: string;
  type: LogType;
  /** 收集器收到的時間(Stream ID) */
  receivedAt: string;
  [field: string]: unknown;
}

export const toLogItem = (type: LogType, e: StreamEntry): LogItem => ({ ...e.data, id: e.id, type, receivedAt: new Date(e.ms).toISOString() });

/** 最近 minutes 分鐘(含目前這一分鐘)的分鐘桶 */
export function bucketsOf(minutes: number, nowMs: number): string[] {
  return Array.from({ length: minutes }, (_, i) => minuteBucket(nowMs - i * 60_000));
}

type Log = { warn: (obj: object, msg: string) => void };

export function createPaLiveService(redis: PaLiveRedis | null, opts: { now?: () => number; log?: Log } = {}) {
  const now = opts.now ?? Date.now;
  const r = () => {
    if (!redis) throw new AppError(424, 'NETOPS_PA_LIVE_DISABLED', '即時監控未設定(REDIS_URL)');
    return redis;
  };
  // Redis 由可用變成不可用(或恢復)時記一筆 warn:畫面回 200 unavailable,API 監控看不到,所以要寫日誌
  let lastUnavailable = false;
  const markUnavailable = (down: boolean, cause?: unknown) => {
    if (down !== lastUnavailable) opts.log?.warn({ err: down ? cause : undefined }, down ? '即時監控:無法讀取 netops-redis' : '即時監控:netops-redis 已恢復');
    lastUnavailable = down;
  };
  const unavailableStatus = (): CollectorStatus => ({ ...deriveStatus(null, now()), state: 'unavailable', message: MESSAGES.unavailable });
  const isRedisError = (err: unknown) => err instanceof RedisUnavailableError || err instanceof RedisReplyError;

  async function status(): Promise<CollectorStatus> {
    if (!redis) return { ...deriveStatus(null, now()), state: 'unavailable', message: '即時監控未設定(REDIS_URL)' };
    try {
      const st = deriveStatus(await redis.heartbeat(), now());
      markUnavailable(false);
      return st;
    } catch (err) {
      if (!isRedisError(err)) throw err;
      markUnavailable(true, err);
      return unavailableStatus();
    }
  }

  /** 收集器狀態 + 各指標最新快照(過期為 null)。Redis 連不上時 metrics 全為 null、state 為 unavailable */
  async function snapshot() {
    const collector = await status();
    const metrics = Object.fromEntries(METRICS.map((m) => [m, null])) as Record<Metric, Record<string, unknown> | null>;
    if (collector.state !== 'unavailable') {
      try {
        const values = await Promise.all(METRICS.map((m) => redis!.snapshot(m)));
        METRICS.forEach((m, i) => (metrics[m] = values[i] ?? null));
      } catch (err) {
        if (!isRedisError(err)) throw err;
        markUnavailable(true, err);
        return { collector: unavailableStatus(), metrics };
      }
    }
    // 收集器停止時快照可能還沒過期(最多 60 秒):不當成即時資料
    if (collector.state === 'stopped') for (const m of METRICS) metrics[m] = null;
    return { collector, metrics };
  }

  /** 趨勢:最近 minutes 分鐘,點數超過 maxPoints 時平均抽樣 */
  async function series(metric: Metric, minutes: number, maxPoints = 360) {
    // 收集器最快每 10 秒一筆:上限取分鐘 × 6 的兩倍
    const entries = await guard(() => r().series(metric, now() - minutes * 60_000, minutes * 12 + 10));
    const step = Math.max(1, Math.ceil(entries.length / maxPoints));
    const points = entries.filter((_, i) => i % step === 0 || i === entries.length - 1).map((e) => e.data);
    return { metric, minutes, points };
  }

  /** 排行與統計:合併最近 minutes 分鐘的每分鐘資料 */
  async function top(type: LogType, minutes: number, limit: number, dims?: string[]) {
    const unknown = (dims ?? []).filter((d) => !TOP_DIMS[type].includes(d));
    if (unknown.length) throw new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field: 'dims', message: `${type} 沒有這些維度:${unknown.join('、')}` }]);
    const use = dims?.length ? dims : [...TOP_DIMS[type]];
    const buckets = bucketsOf(minutes, now());
    return guard(async () => {
      const aggs = await Promise.all(buckets.map((b) => r().minuteAgg(type, b)));
      // 值來自 log 內容:用沒有原型的物件,避免 __proto__ 等鍵
      const totals: Record<string, number> = Object.create(null);
      const kpis: Record<string, Record<string, number>> = Object.create(null);
      for (const h of aggs)
        for (const [f, v] of Object.entries(h)) {
          const num = Number(v) || 0;
          const i = f.indexOf(':');
          if (i < 0) totals[f] = (totals[f] ?? 0) + num;
          else {
            const k = f.slice(0, i);
            const kv = (kpis[k] ??= Object.create(null) as Record<string, number>);
            kv[f.slice(i + 1)] = (kv[f.slice(i + 1)] ?? 0) + num;
          }
        }
      const tops: Record<string, { key: string; value: number }[]> = {};
      // 每分鐘最多留前 200 名(收集器修剪),合併後是近似排行;各維度同時查詢
      const all = await Promise.all(use.map((dim) => Promise.all(buckets.map((b) => r().minuteTop(type, dim, b, 200)))));
      for (const [i, dim] of use.entries()) {
        const lists = all[i]!;
        const sum = new Map<string, number>();
        for (const list of lists) for (const [m, v] of list) sum.set(m, (sum.get(m) ?? 0) + v);
        tops[dim] = [...sum.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, limit)
          .map(([key, value]) => ({ key, value }));
      }
      const minuteCounts = aggs.map((h, i) => ({ minute: bucketTime(buckets[i]!), count: Number(h.count) || 0 })).reverse();
      return { type, minutes, totals, kpis, tops, perMinute: minuteCounts, retentionSec: AGG_RETENTION_SEC(type) };
    });
  }

  /** 最新 log(由新到舊);篩選時最多掃描 LOG_SCAN_MAX 筆 */
  async function logs(type: LogType, limit: number, filter: LogFilter, before?: string) {
    return guard(async () => {
      const items: LogItem[] = [];
      let cursor = before;
      let scanned = 0;
      let exhausted = false;
      while (items.length < limit && scanned < LOG_SCAN_MAX) {
        const chunk = await r().recentLogs(type, Math.min(LOG_SCAN_CHUNK, LOG_SCAN_MAX - scanned), cursor);
        if (!chunk.length) {
          exhausted = true;
          break;
        }
        for (const e of chunk) {
          scanned++;
          cursor = e.id;
          if (matchLog(e.data, filter)) {
            items.push(toLogItem(type, e));
            if (items.length >= limit) break;
          }
        }
      }
      const earliest = await r().earliestLog(type);
      return {
        type,
        items,
        // 下一頁從這裡往前查;沒有更早的資料為 null
        nextBefore: exhausted ? null : (cursor ?? null),
        scanned,
        // 掃到上限仍未湊滿:結果不完整,要更早的請用 Log 明細查詢(FTP)
        truncated: !exhausted && items.length < limit,
        earliest: earliest ? new Date(earliest).toISOString() : null,
        retentionSec: LOG_RETENTION_SEC(type),
      };
    });
  }

  return { status, snapshot, series, top, logs, redis, log: opts.log };
}

export type PaLiveService = ReturnType<typeof createPaLiveService>;

/** yyyyMMddHHmm(UTC)→ ISO */
function bucketTime(b: string): string {
  return `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}T${b.slice(8, 10)}:${b.slice(10, 12)}:00.000Z`;
}

export { LOG_TYPES, METRICS };
