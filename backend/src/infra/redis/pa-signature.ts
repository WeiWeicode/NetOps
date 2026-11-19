/**
 * PA 威脅特徵碼的 Redis 存取(TS-2;docs/THREAT-SIGNATURE-PLAN.md §4.1、§5.4)。鍵格式同 pa-collector/netops_pa/keys.py(兩邊一起改):
 *   netops:pa:sig:meta                 String(JSON) 內容版本、發布時間、筆數、雜湊(netops-pa 寫)
 *   netops:pa:sig:items:vulnerability  String(JSON) 弱點特徵正規化清單(netops-pa 寫)
 *   netops:pa:sig:items:spyware        String(JSON) 間諜軟體特徵正規化清單(netops-pa 寫)
 *   netops:pa:sig:profiles             String(JSON) vsys1 Profile Group 與 VP / AS profile 名稱(netops-pa 寫)
 *   netops:pa:sig:status               Hash         收集狀態(netops-pa 寫)
 *   netops:pa:sig:refresh              String       手動重新整理請求(這裡 SET,netops-pa GETDEL)
 *   netops:pa:sig:cool                 String       手動重新整理冷卻(這裡 SET NX EX 300)
 *   netops:pa:sig:lookup:jobs          List         抽屜按需單筆查詢工作 id(這裡 LPUSH,netops-pa RPOP)
 *   netops:pa:sig:lookup:job:{id}      Hash         單筆查詢工作狀態與結果(TTL 10 分鐘)
 *   netops:pa:sig:lookup:cache:{tid}   String(JSON) 單筆查詢結果快取(TTL 1 天)
 *   netops:pa:sig:lookup:cool          String       單筆查詢全系統限流(netops-pa SET NX EX 10)
 * 也讀心跳 netops:pa:heartbeat 的 signatureEnabled。
 * 鍵只在這裡組(AGENT.md §7.2);API 回應不暴露鍵。
 */
import { Redis } from 'ioredis';

const P = 'netops:pa:sig';
export const PA_SIGNATURE_KEYS = {
  meta: `${P}:meta`,
  itemsVulnerability: `${P}:items:vulnerability`,
  itemsSpyware: `${P}:items:spyware`,
  profiles: `${P}:profiles`,
  status: `${P}:status`,
  refresh: `${P}:refresh`,
  cool: `${P}:cool`,
  lookupJobs: `${P}:lookup:jobs`,
  lookupJob: (id: string) => `${P}:lookup:job:${id}`,
  lookupCache: (threatId: string) => `${P}:lookup:cache:${threatId}`,
  lookupCool: `${P}:lookup:cool`,
  heartbeat: 'netops:pa:heartbeat',
};

/** 手動重新整理冷卻(5 分鐘,計畫 §7) */
export const PA_SIG_COOL_SEC = 300;
/** 手動請求本身的保留時間:收集器停止時不一直留著 */
export const PA_SIG_REFRESH_TTL_SEC = 3600;
/** 單筆按需查詢工作保留時間(10 分鐘,同 keys.py) */
export const PA_SIG_LOOKUP_JOB_TTL_SEC = 600;

const THREAT_ID_RE = /^\d{1,10}$/;
const LOOKUP_ID_RE = /^[0-9a-f-]{16,64}$/i;
const OWNER_RE = /^[\w:.-]{1,80}$/;

export interface PaSignatureClient {
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  set(key: string, value: string, ex: 'EX', sec: number, nx?: 'NX'): Promise<'OK' | null>;
  ttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  multi(commands: (string | number)[][]): { exec(): Promise<[Error | null, unknown][] | null> };
  quit(): Promise<unknown>;
}

export type SignatureRefreshResult = { ok: true; requestedAt: string } | { ok: false; retryAfter: number };
export type SignatureLookupSubmitResult = { ok: true } | { ok: false; retryAfter: number };

export interface PaSignatureRedis {
  meta(): Promise<Record<string, unknown> | null>;
  items(kind: 'vulnerability' | 'spyware'): Promise<unknown[] | null>;
  profiles(): Promise<Record<string, unknown> | null>;
  status(): Promise<Record<string, string>>;
  /** 心跳的 signatureEnabled(收集器沒開或沒有心跳為 false) */
  collectorEnabled(): Promise<boolean>;
  coolSec(): Promise<number>;
  lookupCoolSec(): Promise<number>;
  requestRefresh(by: string, now?: Date): Promise<SignatureRefreshResult>;
  lookupCache(threatId: string): Promise<Record<string, unknown> | null>;
  submitLookup(owner: string, lookupId: string, threatId: string, now?: Date): Promise<SignatureLookupSubmitResult>;
  lookupJob(lookupId: string): Promise<Record<string, string> | null>;
  close(): Promise<void>;
}

const parseObj = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const parseArr = (s: string | null): unknown[] | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

export function createPaSignatureRedis(client: PaSignatureClient): PaSignatureRedis {
  return {
    meta: async () => parseObj(await client.get(PA_SIGNATURE_KEYS.meta)),
    items: async (kind) =>
      parseArr(await client.get(kind === 'vulnerability' ? PA_SIGNATURE_KEYS.itemsVulnerability : PA_SIGNATURE_KEYS.itemsSpyware)),
    profiles: async () => parseObj(await client.get(PA_SIGNATURE_KEYS.profiles)),
    status: () => client.hgetall(PA_SIGNATURE_KEYS.status),
    collectorEnabled: async () => (await client.hgetall(PA_SIGNATURE_KEYS.heartbeat)).signatureEnabled === '1',
    coolSec: async () => Math.max(0, await client.ttl(PA_SIGNATURE_KEYS.cool)),
    lookupCoolSec: async () => Math.max(0, await client.ttl(PA_SIGNATURE_KEYS.lookupCool)),
    async requestRefresh(by, now = new Date()) {
      if ((await client.set(PA_SIGNATURE_KEYS.cool, '1', 'EX', PA_SIG_COOL_SEC, 'NX')) !== 'OK')
        return { ok: false, retryAfter: Math.max(1, await client.ttl(PA_SIGNATURE_KEYS.cool)) };
      const requestedAt = now.toISOString();
      try {
        await client.set(PA_SIGNATURE_KEYS.refresh, JSON.stringify({ requestedAt, emp: by.slice(0, 80) }), 'EX', PA_SIG_REFRESH_TTL_SEC);
      } catch (err) {
        await client.del(PA_SIGNATURE_KEYS.cool).catch(() => undefined);
        throw err;
      }
      return { ok: true, requestedAt };
    },
    async lookupCache(threatId) {
      if (!THREAT_ID_RE.test(threatId)) return null;
      return parseObj(await client.get(PA_SIGNATURE_KEYS.lookupCache(threatId)));
    },
    async submitLookup(owner, lookupId, threatId, now = new Date()) {
      if (!OWNER_RE.test(owner) || !LOOKUP_ID_RE.test(lookupId) || !THREAT_ID_RE.test(threatId))
        throw new Error('單筆特徵查詢參數格式不符,不能組鍵');
      const cool = await client.ttl(PA_SIGNATURE_KEYS.lookupCool);
      if (cool > 0) return { ok: false, retryAfter: cool };
      const jk = PA_SIGNATURE_KEYS.lookupJob(lookupId);
      const res = await client
        .multi([
          ['hset', jk, 'status', 'queued', 'threatId', threatId, 'emp', owner, 'createdAt', now.toISOString()],
          ['expire', jk, PA_SIG_LOOKUP_JOB_TTL_SEC],
          ['lpush', PA_SIGNATURE_KEYS.lookupJobs, lookupId],
        ])
        .exec();
      if (!res || res.some(([err]) => err)) throw new Error('建立單筆特徵查詢工作失敗');
      return { ok: true };
    },
    async lookupJob(lookupId) {
      if (!LOOKUP_ID_RE.test(lookupId)) return null;
      const h = await client.hgetall(PA_SIGNATURE_KEYS.lookupJob(lookupId));
      return Object.keys(h).length ? h : null;
    },
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

/** 連線 netops-redis:items:vulnerability 約 6–10 MB,commandTimeout 給 5 秒 */
export function connectPaSignatureRedis(url: string): PaSignatureRedis {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 5000,
    retryStrategy: (t) => Math.min(t * 500, 5000),
  });
  client.on('error', () => undefined);
  return createPaSignatureRedis(client as unknown as PaSignatureClient);
}
