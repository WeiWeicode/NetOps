/**
 * 冷查詢鎖(V-a / V3;docs/VIZ-RULES-DESIGN.md §4.3.2、ARCHITECTURE D35):全系統同時只有 1 個冷查詢(讀 NAS Parquet)。
 *   netops:cold:lock   值 = 工作 id,PX 120000(工作異常結束時自動釋放);工作結束時只刪自己的鎖
 * C4 的冷 Log 明細查詢與每天的歸檔匯出共用同一把鎖。鍵只在這裡組(AGENT.md §7.2)。
 * 冷資料要等 C4:現在 app.ts 不建立連線(冷路由回 409 NETOPS_COLD_ARCHIVE_DISABLED);C4 接上冷查詢時一併以 ioredis 建立
 */
export const COLD_LOCK_KEY = 'netops:cold:lock';
/** 鎖的存活時間:冷工作執行上限 120 秒 */
export const COLD_LOCK_TTL_MS = 120_000;

export interface ColdLockClient {
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface ColdLock {
  /** 拿到鎖回 true;已有冷查詢回 false。Redis 異常時丟錯(呼叫端當成忙碌,不回 5xx) */
  acquire(owner: string): Promise<boolean>;
  /** 只釋放自己的鎖(值相同才刪);失敗不丟錯(鎖會在 TTL 後過期) */
  release(owner: string): Promise<void>;
  close(): Promise<void>;
}

/** 值相同才刪(避免刪到逾時後別人拿到的鎖) */
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function createColdLock(client: ColdLockClient): ColdLock {
  return {
    async acquire(owner) {
      return (await client.set(COLD_LOCK_KEY, owner, 'PX', COLD_LOCK_TTL_MS, 'NX')) === 'OK';
    },
    async release(owner) {
      try {
        await client.eval(RELEASE, 1, COLD_LOCK_KEY, owner);
      } catch {
        /* 過期後自動釋放 */
      }
    },
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}
