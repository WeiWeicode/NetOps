/**
 * FTP 補漏工作(C3;ARCHITECTURE D33、手冊 §11.3):netops-api 建立(手動,權限 netops.ftp.write)、netops-ingest 執行。
 * 鍵只在這裡組(AGENT.md §7.2),兩邊共用同一份程式:
 *   netops:backfill:queue       List,待執行的工作 id(LPUSH 進、RPOP 出;netops-ingest 一次做一個)
 *   netops:backfill:job:{id}    Hash,工作內容與狀態;TTL 7 天
 *   netops:backfill:running     Set,執行中的工作 id(netops-ingest 重啟時把裡面的工作標失敗,不會一直卡在 running)
 * 工作內容只有小時與 FTP 檔案路徑(FTP 路徑不是機密);狀態欄位只寫筆數與分類過的錯誤訊息,不寫 log 內容。
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

export const BACKFILL_KEYS = {
  queue: 'netops:backfill:queue',
  job: (id: string) => `netops:backfill:job:${id}`,
  running: 'netops:backfill:running',
};
export const BACKFILL_TTL_SEC = 7 * 86400;
/** 佇列裡最多幾個工作(超過回 409) */
export const BACKFILL_QUEUE_MAX = 10;

export type BackfillState = 'queued' | 'running' | 'done' | 'failed';

export interface BackfillHour {
  /** 小時開始(UTC 毫秒) */
  hour: number;
  /** 涵蓋這一小時的 FTP 檔案(netops-api 依分析結果挑出) */
  files: string[];
}

export interface BackfillJob {
  id: string;
  day: string;
  hours: BackfillHour[];
  state: BackfillState;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** FTP 讀到、屬於這些小時的列數 */
  read: number;
  /** 已在 ClickHouse(seqno 相同)而略過的列數 */
  skipped: number;
  /** 補寫進 ClickHouse 的列數 */
  inserted: number;
  /** 沒有 seqno、無法去重而略過的列數 */
  noSeqno: number;
  error: string | null;
}

export type BackfillClient = Pick<Redis, 'lpush' | 'rpop' | 'llen' | 'hset' | 'hgetall' | 'expire' | 'sadd' | 'srem' | 'smembers' | 'quit'>;

const ID = /^[0-9a-f-]{36}$/;

function parse(id: string, h: Record<string, string>): BackfillJob | null {
  if (!h.state) return null;
  let hours: BackfillHour[] = [];
  try {
    hours = JSON.parse(h.hours ?? '[]');
  } catch {
    /* 損壞的工作:hours 空白,執行時直接失敗 */
  }
  const n = (k: string) => Number(h[k] ?? 0) || 0;
  return {
    id,
    day: h.day ?? '',
    hours,
    state: h.state as BackfillState,
    createdBy: h.createdBy ?? '',
    createdAt: h.createdAt ?? '',
    startedAt: h.startedAt || null,
    finishedAt: h.finishedAt || null,
    read: n('read'),
    skipped: n('skipped'),
    inserted: n('inserted'),
    noSeqno: n('noSeqno'),
    error: h.error || null,
  };
}

export interface BackfillQueue {
  /** 建立工作並排入佇列;佇列滿回 null */
  enqueue(day: string, hours: BackfillHour[], createdBy: string): Promise<BackfillJob | null>;
  get(id: string): Promise<BackfillJob | null>;
  /** 取出下一個工作並標成 running(netops-ingest) */
  take(): Promise<BackfillJob | null>;
  update(id: string, fields: Partial<Pick<BackfillJob, 'state' | 'read' | 'skipped' | 'inserted' | 'noSeqno' | 'error' | 'finishedAt'>>): Promise<void>;
  /** 工作結束(完成或失敗):移出執行中清單 */
  finish(id: string): Promise<void>;
  /** netops-ingest 啟動時:上次執行中(被中斷)的工作標失敗,回傳 id */
  failInterrupted(message: string): Promise<string[]>;
  close(): Promise<void>;
}

export function createBackfillQueue(client: BackfillClient): BackfillQueue {
  const set = async (id: string, f: Record<string, string>) => {
    await client.hset(BACKFILL_KEYS.job(id), f);
    await client.expire(BACKFILL_KEYS.job(id), BACKFILL_TTL_SEC);
  };
  return {
    async enqueue(day, hours, createdBy) {
      if ((await client.llen(BACKFILL_KEYS.queue)) >= BACKFILL_QUEUE_MAX) return null;
      const id = randomUUID();
      const now = new Date().toISOString();
      await set(id, { day, hours: JSON.stringify(hours), state: 'queued', createdBy: createdBy.slice(0, 80), createdAt: now, read: '0', skipped: '0', inserted: '0', noSeqno: '0' });
      await client.lpush(BACKFILL_KEYS.queue, id);
      return parse(id, await client.hgetall(BACKFILL_KEYS.job(id)));
    },
    async get(id) {
      if (!ID.test(id)) return null;
      return parse(id, await client.hgetall(BACKFILL_KEYS.job(id)));
    },
    async take() {
      const id = await client.rpop(BACKFILL_KEYS.queue);
      if (!id || !ID.test(id)) return null;
      await client.sadd(BACKFILL_KEYS.running, id);
      const job = parse(id, await client.hgetall(BACKFILL_KEYS.job(id)));
      if (!job) return null;
      const startedAt = new Date().toISOString();
      await set(id, { state: 'running', startedAt });
      return { ...job, state: 'running', startedAt };
    },
    async update(id, f) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) if (v !== undefined) out[k] = v === null ? '' : String(v).slice(0, 200);
      await set(id, out);
    },
    async finish(id) {
      await client.srem(BACKFILL_KEYS.running, id);
    },
    async failInterrupted(message) {
      const ids = (await client.smembers(BACKFILL_KEYS.running)).filter((x) => ID.test(x));
      for (const id of ids) {
        await set(id, { state: 'failed', error: message.slice(0, 200), finishedAt: new Date().toISOString() });
        await client.srem(BACKFILL_KEYS.running, id);
      }
      return ids;
    },
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

export function connectBackfillQueue(url: string): BackfillQueue {
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, retryStrategy: (t) => Math.min(t * 500, 5000) });
  client.on('error', () => undefined);
  return createBackfillQueue(client);
}
