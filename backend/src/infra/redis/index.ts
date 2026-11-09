/**
 * netops-redis 讀取(R1,PA-LIVE-PLAN §3.3、§4;AGENT.md §7.2):只讀,寫入由 netops-pa(pa-collector/)負責。
 * 鍵格式只在這裡組;與 pa-collector/netops_pa/keys.py 同一份規則,兩邊要一起改(改之前先回報需求方)。
 * 模組只呼叫這裡的具名函式,API 回應不暴露 Redis 鍵。分鐘桶為 UTC yyyyMMddHHmm(收集器收到 log 的時間)。
 */
import { Redis } from 'ioredis';

const PREFIX = 'netops:pa';

/** log 類型(PA-LIVE-PLAN §4);traffic 經 Syslog,其他經 HTTP */
export const LOG_TYPES = ['traffic', 'threat', 'url', 'wildfire', 'data', 'decryption', 'globalprotect', 'userid'] as const;
export type LogType = (typeof LOG_TYPES)[number];
export const METRICS = ['session', 'cpu', 'throughput', 'interfaces'] as const;
export type Metric = (typeof METRICS)[number];

/** 保留時間(秒,D21):TRAFFIC 明細 1 小時、統計 1 天;其他類型 2 天(同 keys.py) */
export const LOG_RETENTION_SEC = (t: LogType) => (t === 'traffic' ? 3600 : 2 * 86400);
export const AGG_RETENTION_SEC = (t: LogType) => (t === 'traffic' ? 86400 : 2 * 86400);

/** 每種類型的排行維度(同 pa-collector/netops_pa/records.py 的 tops / byte_tops) */
export const TOP_DIMS: Record<LogType, readonly string[]> = {
  traffic: ['src', 'dst', 'app', 'rule', 'port', 'srcBytes', 'dstBytes', 'appBytes'],
  threat: ['name', 'src', 'dst', 'app', 'rule'],
  url: ['host', 'category', 'src', 'user', 'app'],
  data: ['name', 'src', 'app', 'filetype', 'user'],
  wildfire: ['src', 'dst', 'filetype', 'app'],
  decryption: ['error', 'src', 'dst', 'sni', 'app'],
  globalprotect: ['user', 'publicIp', 'region'],
  userid: ['user', 'ip'],
};

const keys = {
  snap: (m: Metric) => `${PREFIX}:snap:${m}`,
  series: (m: Metric) => `${PREFIX}:series:${m}`,
  log: (t: LogType) => `${PREFIX}:log:${t}`,
  agg: (t: LogType, bucket: string) => `${PREFIX}:agg:${t}:${bucket}`,
  top: (t: LogType, dim: string, bucket: string) => `${PREFIX}:top:${t}:${dim}:${bucket}`,
  heartbeat: `${PREFIX}:heartbeat`,
};

/** Unix 毫秒 → UTC yyyyMMddHHmm */
export function minuteBucket(ms: number): string {
  return new Date(ms).toISOString().replace(/[-T:]/g, '').slice(0, 12);
}

/** 本模組用到的 Redis 指令(測試以假實作替換) */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  xrange(key: string, start: string, end: string, count: 'COUNT', n: number): Promise<[string, string[]][]>;
  xrevrange(key: string, end: string, start: string, count: 'COUNT', n: number): Promise<[string, string[]][]>;
  zrevrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>;
  quit(): Promise<unknown>;
}

/** Redis 連不上、逾時(即時監控標示 unavailable;其他功能不受影響) */
export class RedisUnavailableError extends Error {}
/** Redis 回錯誤(參數或指令錯誤,例如 WRONGTYPE):是程式或資料問題,不是連線問題 */
export class RedisReplyError extends Error {}

/** Stream 一筆:id 為 Stream ID(毫秒-序號),data 為 netops-pa 寫入的 JSON */
export interface StreamEntry {
  id: string;
  ms: number;
  data: Record<string, unknown>;
}

const STREAM_ID = /^\d{1,15}-\d{1,10}$/;
export const isStreamId = (s: string) => STREAM_ID.test(s);

function parseEntries(rows: [string, string[]][]): StreamEntry[] {
  const out: StreamEntry[] = [];
  for (const [id, fields] of rows) {
    const i = fields.indexOf('d');
    if (i < 0) continue;
    try {
      const data = JSON.parse(fields[i + 1] ?? '') as unknown;
      if (data && typeof data === 'object' && !Array.isArray(data)) out.push({ id, ms: Number(id.split('-')[0]), data: data as Record<string, unknown> });
    } catch {
      // 格式錯誤的一筆略過(寫入端只寫 JSON;不讓一筆壞資料讓整個查詢失敗)
    }
  }
  return out;
}

const parseJson = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export interface PaLiveRedis {
  /** 收集器心跳(沒有 = 收集器從未啟動或 Redis 資料遺失) */
  heartbeat(): Promise<Record<string, string> | null>;
  /** 最新設備快照(60 秒過期;過期回 null = 停止更新) */
  snapshot(metric: Metric): Promise<Record<string, unknown> | null>;
  /** 趨勢:sinceMs 之後的快照,依時間由舊到新,最多 limit 筆 */
  series(metric: Metric, sinceMs: number, limit: number): Promise<StreamEntry[]>;
  /** 最新 log(由新到舊),beforeId 之前(不含),最多 count 筆 */
  recentLogs(type: LogType, count: number, beforeId?: string): Promise<StreamEntry[]>;
  /** afterId 之後(不含)的新 log,由舊到新,最多 count 筆 */
  logsAfter(type: LogType, afterId: string, count: number): Promise<StreamEntry[]>;
  /** Stream 最早一筆的時間(毫秒;沒有資料為 null) */
  earliestLog(type: LogType): Promise<number | null>;
  /** 最新一筆的 Stream ID(串流起點;沒有資料為 0-0) */
  latestLogId(type: LogType): Promise<string>;
  /** 某一分鐘的統計 Hash */
  minuteAgg(type: LogType, bucket: string): Promise<Record<string, string>>;
  /** 某一分鐘某維度的排行(前 limit 名) */
  minuteTop(type: LogType, dim: string, bucket: string, limit: number): Promise<[string, number][]>;
  close(): Promise<void>;
}

/** 每個指令包一層:Redis 回的錯誤(ReplyError)→ RedisReplyError;其他(連線、逾時)→ RedisUnavailableError。原因只寫日誌 */
export function createPaLiveRedis(client: RedisClient): PaLiveRedis {
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if ((err as Error)?.name === 'ReplyError') throw new RedisReplyError('Redis 回應錯誤', { cause: err });
      throw new RedisUnavailableError('Redis 讀取失敗', { cause: err });
    }
  };
  return {
    heartbeat: () =>
      call(async () => {
        const h = await client.hgetall(keys.heartbeat);
        return Object.keys(h).length ? h : null;
      }),
    snapshot: (m) => call(async () => parseJson(await client.get(keys.snap(m)))),
    series: (m, sinceMs, limit) => call(async () => parseEntries(await client.xrange(keys.series(m), String(Math.max(0, Math.floor(sinceMs))), '+', 'COUNT', limit))),
    recentLogs: (t, count, beforeId) => call(async () => parseEntries(await client.xrevrange(keys.log(t), beforeId ? `(${beforeId}` : '+', '-', 'COUNT', count))),
    logsAfter: (t, afterId, count) => call(async () => parseEntries(await client.xrange(keys.log(t), `(${afterId}`, '+', 'COUNT', count))),
    earliestLog: (t) =>
      call(async () => {
        const rows = await client.xrange(keys.log(t), '-', '+', 'COUNT', 1);
        return rows[0] ? Number(rows[0][0].split('-')[0]) : null;
      }),
    latestLogId: (t) =>
      call(async () => {
        const rows = await client.xrevrange(keys.log(t), '+', '-', 'COUNT', 1);
        return rows[0]?.[0] ?? '0-0';
      }),
    minuteAgg: (t, bucket) => call(() => client.hgetall(keys.agg(t, bucket))),
    minuteTop: (t, dim, bucket, limit) =>
      call(async () => {
        const flat = await client.zrevrange(keys.top(t, dim, bucket), 0, limit - 1, 'WITHSCORES');
        const out: [string, number][] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, Number(flat[i + 1])]);
        return out;
      }),
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

/** 連線 netops-redis:不排隊、逾時短(Redis 停止時立即回報 unavailable,不卡住請求);連線錯誤每分鐘最多記一筆 warn(只記錯誤代碼) */
export function connectPaLiveRedis(url: string, log?: { warn: (obj: object, msg: string) => void }): PaLiveRedis {
  const client = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
    // 斷線後持續重連(最多每 5 秒一次)
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  // 錯誤由各查詢回報;這裡避免 ioredis 的未處理 error 事件,並限頻記錄(不記 URL)
  let lastWarn = 0;
  client.on('error', (err: NodeJS.ErrnoException) => {
    if (Date.now() - lastWarn < 60_000) return;
    lastWarn = Date.now();
    log?.warn({ code: err.code ?? err.name }, 'netops-redis 連線錯誤');
  });
  return createPaLiveRedis(client as unknown as RedisClient);
}
