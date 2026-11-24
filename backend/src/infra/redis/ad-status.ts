/**
 * netops-api 讀 DC Agent 心跳(AD-3;GET /v1/ad/agents,docs/AD-AGENT-PLAN.md §4.2)。只讀;鍵沿用 ad-receiver.ts 的 AD_KEYS(AGENT.md §7.2)。
 * 內容是 DC 送來的資料(接收端只驗過格式與大小),由 modules/ad/agents.ts 白名單整理後才回給畫面。
 */
import { Redis } from 'ioredis';
import { AD_KEYS } from './ad-receiver.js';

/** 最多列幾台 DC(防止 Set 被灌大時一次讀太多) */
export const AD_STATUS_MAX_COMPUTERS = 200;
/** Watchdog 事件最多讀最新幾筆(清單上限 AGENT_EVENTS_MAX = 1000) */
export const AD_STATUS_EVENTS = 300;

export interface AdHeartbeatRaw {
  computer: string;
  /** 心跳 Hash 的欄位(data、updatedAt、domain、agentVersion、reportedAt、received) */
  fields: Record<string, string>;
}

export interface AdStatusRedis {
  /** 回報過的 DC 與各自最新心跳(沒有心跳 Hash 的 fields 為空物件) */
  heartbeats(): Promise<AdHeartbeatRaw[]>;
  /** 最新的 Watchdog 事件 JSON(新的在前) */
  agentEvents(): Promise<string[]>;
  /** 接收端每台 DC 的去重水位(channel:logEpoch → 最大 RecordID) */
  watermarks(computer: string): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export type AdStatusClient = Pick<Redis, 'smembers' | 'hgetall' | 'lrange' | 'quit'>;

export function createAdStatusRedis(client: AdStatusClient): AdStatusRedis {
  return {
    async heartbeats() {
      const names = (await client.smembers(AD_KEYS.computers)).filter((c) => /^[\w.-]{1,64}$/.test(c)).sort().slice(0, AD_STATUS_MAX_COMPUTERS);
      const out: AdHeartbeatRaw[] = [];
      for (const computer of names) out.push({ computer, fields: await client.hgetall(AD_KEYS.heartbeat(computer)) });
      return out;
    },
    agentEvents: () => client.lrange(AD_KEYS.agentEvents, 0, AD_STATUS_EVENTS - 1),
    watermarks: (computer) => client.hgetall(AD_KEYS.hwm(computer)),
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

/** Redis 斷線時快速失敗(呼叫端回 424),不在記憶體排隊 */
export function connectAdStatusRedis(url: string): AdStatusRedis {
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, retryStrategy: (t) => Math.min(t * 500, 5000) });
  client.on('error', () => undefined);
  return createAdStatusRedis(client);
}
