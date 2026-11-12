/**
 * 儀表板快取(C3;ARCHITECTURE D32、手冊 §6.4、§6.7、§12 CQ11):netops:cache:{名稱}:{參數雜湊},TTL 30–60 秒
 * (V-a 熱力圖已結束的期間可到 1 小時,呼叫端明確指定 longTtl;docs/VIZ-RULES-DESIGN.md §4.2)。
 * 鍵只在這裡組(AGENT.md §7.2)。Redis 異常時直接計算、不讓快取拖垮查詢;寫不進去只是少了快取。
 */
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface CacheOptions<T> {
  /** TTL 上限改為 1 小時(預設 60 秒) */
  longTtl?: boolean;
  /** 回 false 的結果不存快取 */
  keep?: (v: T) => boolean;
}

export interface DashboardCache {
  /**
   * 有快取回快取,否則 load() 後存 ttlSec 秒;name 只能是程式內的常數名稱。
   * TTL 上限預設 60 秒(CQ11);longTtl 時上限 1 小時(V-a 已結束期間的熱力圖,docs/VIZ-RULES-DESIGN.md §4.2)
   * keep 回 false 的結果不存快取(C3:排行還沒建好的總覽)
   */
  cached<T>(name: string, params: object, ttlSec: number, load: () => Promise<T>, opts?: CacheOptions<T>): Promise<T>;
  close(): Promise<void>;
}

/** 名稱只允許英數與 -(鍵不吃外部字串) */
const NAME = /^[a-z0-9-]{1,40}$/;

export const cacheKey = (name: string, params: object): string => {
  if (!NAME.test(name)) throw new Error(`不合法的快取名稱:${name}`);
  return `netops:cache:${name}:${createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 24)}`;
};

export function createDashboardCache(client: CacheClient | null): DashboardCache {
  /** 同一個鍵正在計算時共用同一個 Promise(冷快取時同時多個請求只算一次;資安審查 M2) */
  const inflight = new Map<string, Promise<unknown>>();

  async function compute(key: string, ttlSec: number, load: () => Promise<unknown>, maxSec: number, keep?: (v: never) => boolean): Promise<unknown> {
    if (client) {
        try {
          const hit = await client.get(key);
          if (hit) return JSON.parse(hit);
        } catch {
          /* Redis 異常:直接計算 */
        }
      }
      const value = await load();
      if (client && (!keep || keep(value as never))) {
        try {
          await client.set(key, JSON.stringify(value), 'EX', Math.min(Math.max(ttlSec, 1), maxSec));
        } catch {
          /* 寫不進去只是少了快取 */
        }
      }
      return value;
  }

  return {
    async cached<T>(name: string, params: object, ttlSec: number, load: () => Promise<T>, opts: CacheOptions<T> = {}): Promise<T> {
      const key = cacheKey(name, params);
      const running = inflight.get(key);
      if (running) return running as Promise<T>;
      const p = compute(key, ttlSec, load, opts.longTtl ? 3600 : 60, opts.keep as ((v: never) => boolean) | undefined);
      inflight.set(key, p);
      try {
        return (await p) as T;
      } finally {
        inflight.delete(key);
      }
    },
    close: async () => {
      await client?.quit().catch(() => undefined);
    },
  };
}

/** 連線 netops-redis(同 connectPaLiveRedis:不排隊、逾時短,Redis 停止時直接計算) */
export function connectDashboardCache(url: string): DashboardCache {
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 2000, retryStrategy: (t) => Math.min(t * 500, 5000) });
  client.on('error', () => undefined);
  return createDashboardCache(client as unknown as CacheClient);
}
