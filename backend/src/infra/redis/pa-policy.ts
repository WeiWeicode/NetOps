/**
 * PA 安全規則的 Redis 存取(PR-2;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3)。鍵格式同 pa-collector/netops_pa/keys.py(兩邊一起改):
 *   netops:pa:policy:snapshot  String(JSON) 最新規則快照(netops-pa 寫;fetchedAt、hash、vsys、rules、objects)
 *   netops:pa:policy:hits      String(JSON) 命中數(netops-pa 寫;fetchedAt、items{規則名稱: …})
 *   netops:pa:policy:status    Hash         收集狀態(netops-pa 寫)
 *   netops:pa:policy:refresh   String       手動重新整理請求(這裡 SET,netops-pa GETDEL)
 *   netops:pa:policy:cool      String       手動重新整理冷卻(這裡 SET NX EX 300)
 * 也讀心跳 netops:pa:heartbeat 的 policyEnabled(收集器有沒有開安全規則收集)。
 * 鍵只在這裡組(AGENT.md §7.2);API 回應不暴露鍵。
 */
import { Redis } from 'ioredis';

const P = 'netops:pa:policy';
export const PA_POLICY_KEYS = {
  snapshot: `${P}:snapshot`,
  hits: `${P}:hits`,
  status: `${P}:status`,
  refresh: `${P}:refresh`,
  cool: `${P}:cool`,
  heartbeat: 'netops:pa:heartbeat',
};
/** 手動重新整理冷卻(§3.2 ③:5 分鐘) */
export const PA_POLICY_COOL_SEC = 300;
/** 請求本身的保留時間:收集器停止時不一直留著 */
export const PA_POLICY_REFRESH_TTL_SEC = 3600;

export interface PaPolicyClient {
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(key: string, value: string, ex: 'EX', sec: number, nx?: 'NX'): Promise<'OK' | null>;
  ttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<unknown>;
}

export type RefreshResult = { ok: true; requestedAt: string } | { ok: false; retryAfter: number };

export interface PaPolicyRedis {
  /** 最新快照原始 JSON 物件(沒有或格式錯誤回 null) */
  snapshot(): Promise<Record<string, unknown> | null>;
  hits(): Promise<Record<string, unknown> | null>;
  status(): Promise<Record<string, string>>;
  /** 心跳的 policyEnabled(收集器沒開或沒有心跳為 false) */
  collectorEnabled(): Promise<boolean>;
  /** 冷卻剩餘秒數(0 = 可以重新整理) */
  coolSec(): Promise<number>;
  /** 送出手動重新整理:冷卻中回 retryAfter;成功時寫冷卻與請求 */
  requestRefresh(by: string, now?: Date): Promise<RefreshResult>;
  close(): Promise<void>;
}

const parse = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export function createPaPolicyRedis(client: PaPolicyClient): PaPolicyRedis {
  return {
    snapshot: async () => parse(await client.get(PA_POLICY_KEYS.snapshot)),
    hits: async () => parse(await client.get(PA_POLICY_KEYS.hits)),
    status: () => client.hgetall(PA_POLICY_KEYS.status),
    collectorEnabled: async () => (await client.hgetall(PA_POLICY_KEYS.heartbeat)).policyEnabled === '1',
    coolSec: async () => Math.max(0, await client.ttl(PA_POLICY_KEYS.cool)),
    async requestRefresh(by, now = new Date()) {
      if ((await client.set(PA_POLICY_KEYS.cool, '1', 'EX', PA_POLICY_COOL_SEC, 'NX')) !== 'OK')
        return { ok: false, retryAfter: Math.max(1, await client.ttl(PA_POLICY_KEYS.cool)) };
      const requestedAt = now.toISOString();
      try {
        await client.set(PA_POLICY_KEYS.refresh, JSON.stringify({ requestedAt, emp: by.slice(0, 80) }), 'EX', PA_POLICY_REFRESH_TTL_SEC);
      } catch (err) {
        // 請求沒寫進去就把冷卻還回去,讓使用者可以重試
        await client.del(PA_POLICY_KEYS.cool).catch(() => undefined);
        throw err;
      }
      return { ok: true, requestedAt };
    },
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

/** 連線 netops-redis(同 connectPaQueryStore:不排隊、逾時短) */
export function connectPaPolicyRedis(url: string): PaPolicyRedis {
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, retryStrategy: (t) => Math.min(t * 500, 5000) });
  client.on('error', () => undefined);
  return createPaPolicyRedis(client as unknown as PaPolicyClient);
}
