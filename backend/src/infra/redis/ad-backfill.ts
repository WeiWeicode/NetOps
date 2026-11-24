/**
 * AD FTP 補漏工作(AD-3;docs/AD-AGENT-PLAN.md §4.2、§5):netops-api 建立(對帳自動送,或手動 POST /v1/ad/backfills,權限 netops.ftp.write)、
 * netops-ingest 執行。鍵只在這裡組(AGENT.md §7.2),兩邊共用:
 *   netops:ad:backfill:queue     List,待執行的工作 id(LPUSH 進、RPOP 出;一次做一個)
 *   netops:ad:backfill:job:{id}  Hash,工作內容與狀態;TTL 7 天
 *   netops:ad:backfill:running   Set,執行中的工作 id(netops-ingest 重啟時標失敗)
 * 工作內容只有日期、FTP 檔案路徑與要補的 (DC, 記錄);狀態只寫筆數與分類過的錯誤訊息,不寫事件內容。
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

export const AD_BACKFILL_KEYS = {
  queue: 'netops:ad:backfill:queue',
  job: (id: string) => `netops:ad:backfill:job:${id}`,
  running: 'netops:ad:backfill:running',
};
export const AD_BACKFILL_TTL_SEC = 7 * 86400;
/** 佇列裡最多幾個工作(超過回 409) */
export const AD_BACKFILL_QUEUE_MAX = 10;

export type AdBackfillState = 'queued' | 'running' | 'done' | 'failed';

/** 要補的範圍:DC(dcKey:大寫、不含網域)與記錄 */
export interface AdBackfillScope {
  computer: string;
  channel: string;
}

export interface AdBackfillCounts {
  /** CSV 讀到、屬於這一天與範圍的列數 */
  read: number;
  /** 已在 ClickHouse(同 computer、channel、log_epoch、record_id)而略過 */
  skipped: number;
  /** 補寫進 ClickHouse(source = 'ftp') */
  inserted: number;
  /** RecordID 大於 Agent 水位:Agent 之後還會送,這次不補(隔天對帳再看;D1、D5) */
  waitingAgent: number;
  /** 判斷不出 Event Log 世代(清除重編號、又沒有對得上的 Agent 列):不寫入,要人工確認(D1) */
  ambiguous: number;
  /** 沒有 RecordID 或時間不正確,無法去重而略過 */
  invalid: number;
}

export interface AdBackfillJob extends AdBackfillCounts {
  id: string;
  /** 'yyyy/MM/dd' */
  day: string;
  files: string[];
  scope: AdBackfillScope[];
  state: AdBackfillState;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export type AdBackfillClient = Pick<Redis, 'lpush' | 'rpop' | 'llen' | 'hset' | 'hgetall' | 'expire' | 'sadd' | 'srem' | 'smembers' | 'quit'>;

const ID = /^[0-9a-f-]{36}$/;
const COUNT_KEYS = ['read', 'skipped', 'inserted', 'waitingAgent', 'ambiguous', 'invalid'] as const;

function json<T>(s: string | undefined, fallback: T): T {
  try {
    const v = JSON.parse(s ?? '');
    return Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function parse(id: string, h: Record<string, string>): AdBackfillJob | null {
  if (!h.state) return null;
  const n = (k: string) => Number(h[k] ?? 0) || 0;
  return {
    id,
    day: h.day ?? '',
    files: json<string[]>(h.files, []),
    scope: json<AdBackfillScope[]>(h.scope, []),
    state: h.state as AdBackfillState,
    createdBy: h.createdBy ?? '',
    createdAt: h.createdAt ?? '',
    startedAt: h.startedAt || null,
    finishedAt: h.finishedAt || null,
    read: n('read'),
    skipped: n('skipped'),
    inserted: n('inserted'),
    waitingAgent: n('waitingAgent'),
    ambiguous: n('ambiguous'),
    invalid: n('invalid'),
    error: h.error || null,
  };
}

export interface AdBackfillQueue {
  /** 建立工作並排入佇列;佇列滿回 null */
  enqueue(day: string, files: string[], scope: AdBackfillScope[], createdBy: string): Promise<AdBackfillJob | null>;
  get(id: string): Promise<AdBackfillJob | null>;
  /** 取出下一個工作並標成 running(netops-ingest) */
  take(): Promise<AdBackfillJob | null>;
  update(id: string, fields: Partial<AdBackfillCounts & Pick<AdBackfillJob, 'state' | 'error' | 'finishedAt'>>): Promise<void>;
  finish(id: string): Promise<void>;
  /** netops-ingest 啟動時:上次執行中的工作標失敗 */
  failInterrupted(message: string): Promise<string[]>;
  close(): Promise<void>;
}

export function createAdBackfillQueue(client: AdBackfillClient): AdBackfillQueue {
  const set = async (id: string, f: Record<string, string>) => {
    await client.hset(AD_BACKFILL_KEYS.job(id), f);
    await client.expire(AD_BACKFILL_KEYS.job(id), AD_BACKFILL_TTL_SEC);
  };
  return {
    async enqueue(day, files, scope, createdBy) {
      if ((await client.llen(AD_BACKFILL_KEYS.queue)) >= AD_BACKFILL_QUEUE_MAX) return null;
      const id = randomUUID();
      const zero = Object.fromEntries(COUNT_KEYS.map((k) => [k, '0']));
      await set(id, { day, files: JSON.stringify(files), scope: JSON.stringify(scope), state: 'queued', createdBy: createdBy.slice(0, 80), createdAt: new Date().toISOString(), ...zero });
      await client.lpush(AD_BACKFILL_KEYS.queue, id);
      return parse(id, await client.hgetall(AD_BACKFILL_KEYS.job(id)));
    },
    async get(id) {
      if (!ID.test(id)) return null;
      return parse(id, await client.hgetall(AD_BACKFILL_KEYS.job(id)));
    },
    async take() {
      const id = await client.rpop(AD_BACKFILL_KEYS.queue);
      if (!id || !ID.test(id)) return null;
      await client.sadd(AD_BACKFILL_KEYS.running, id);
      const job = parse(id, await client.hgetall(AD_BACKFILL_KEYS.job(id)));
      if (!job) {
        await client.srem(AD_BACKFILL_KEYS.running, id);
        return null;
      }
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
      await client.srem(AD_BACKFILL_KEYS.running, id);
    },
    async failInterrupted(message) {
      const ids = (await client.smembers(AD_BACKFILL_KEYS.running)).filter((x) => ID.test(x));
      for (const id of ids) {
        await set(id, { state: 'failed', error: message.slice(0, 200), finishedAt: new Date().toISOString() });
        await client.srem(AD_BACKFILL_KEYS.running, id);
      }
      return ids;
    },
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

export function connectAdBackfillQueue(url: string): AdBackfillQueue {
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, retryStrategy: (t) => Math.min(t * 500, 5000) });
  client.on('error', () => undefined);
  return createAdBackfillQueue(client);
}
