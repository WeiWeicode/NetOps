/**
 * netops-ad-receiver 用的 Redis 存取(AD-1;docs/AD-AGENT-PLAN.md §4.1、§4.2、ARCHITECTURE D49)。鍵只在這裡組(AGENT.md §7.2)。
 *
 *   netops:ad:log:events          Stream,AD 事件(一筆一個條目,欄位 d = JSON);XADD MINID ~ 2 天前(AD7)
 *   netops:ad:heartbeat:{computer} Hash,該台 DC 最新心跳(data = JSON、updatedAt = 伺服器收到時間、received = 累計接受筆數)
 *   netops:ad:computers           Set,回報過的 DC(下線由維運以 redis-cli 清除,計畫 §4.2 L3)
 *   netops:ad:recv:hwm:{computer} Hash,每個「channel:logEpoch」已接受的最大 RecordID(重送去重,M2;AD-1 新增)
 *   netops:ad:agent-events        List,心跳附帶的 Watchdog 事件(最新在前,最多 AGENT_EVENTS_MAX 筆;規則 10 / AD-5 用;AD-1 新增)
 *
 * 重送去重(審查 M2、H4):Agent 依 RecordID 由小到大讀,未收到 200 就重送。接收端以 Lua 原子比對水位,
 * RecordID 不大於水位的事件視為重複、不寫 Stream;所以「重送同一批」或「重送時多了新事件」都只會寫入新的部分,
 * 兩個請求同時到也不會重複寫。ingest 重啟重讀(INSERT 後、XACK 前)另由 ClickHouse 去重 token 處理(writer.ts)。
 * 鍵是 (computer, channel, log_epoch, record_id):Event Log 清除重編號時 Agent 把 log_epoch 加 1,新世代從 0 開始比。
 */
import { Redis } from 'ioredis';

/** Stream 保留 2 天(AD7) */
export const AD_STREAM_RETENTION_MS = 2 * 86_400_000;
/** 水位 Hash 的 TTL:DC 停送超過 30 天就清掉(Agent 只送水位之後的事件,清掉後不會重複) */
export const AD_HWM_TTL_SECONDS = 30 * 86_400;
export const AGENT_EVENTS_MAX = 1000;

export const AD_KEYS = {
  log: 'netops:ad:log:events',
  heartbeat: (computer: string) => `netops:ad:heartbeat:${computer}`,
  computers: 'netops:ad:computers',
  hwm: (computer: string) => `netops:ad:recv:hwm:${computer}`,
  agentEvents: 'netops:ad:agent-events',
};

/** 接收端已驗證的一筆事件(Stream 的 JSON 由呼叫端組好) */
export interface AdStreamEvent {
  channel: string;
  logEpoch: number;
  /** 正整數,≤ 2^53 − 1(Lua 數字精度) */
  recordId: number;
  json: string;
}

export interface AcceptResult {
  accepted: number;
  duplicates: number;
}

export interface AdReceiverRedis {
  /** 依水位去重後寫 Stream;events 要先依 (channel, logEpoch, recordId) 排序 */
  acceptEvents(computer: string, events: readonly AdStreamEvent[], now?: number): Promise<AcceptResult>;
  /** 寫最新心跳(整個換新,保留 received 計數)、加進 computers,Watchdog 事件推進清單 */
  writeHeartbeat(computer: string, fields: Record<string, string>, agentEvents: readonly string[]): Promise<void>;
  /** 每個 channel 目前最大的 log_epoch 與該世代的水位(心跳回應帶回,AD-2 bookmarks 遺失時可參考) */
  watermarks(computer: string): Promise<Record<string, { logEpoch: number; lastRecordId: number }>>;
  ping(): Promise<void>;
  quit(): Promise<void>;
}

/**
 * KEYS: 1 Stream、2 水位 Hash、3 心跳 Hash、4 computers Set
 * ARGV: 1 MINID、2 水位 TTL 秒、3 computer,之後每 3 個一組:水位欄位(channel:epoch)、RecordID、JSON
 */
const ACCEPT_LUA = `
local accepted, dup = 0, 0
for i = 4, #ARGV, 3 do
  local f = ARGV[i]
  local rid = tonumber(ARGV[i + 1])
  local cur = tonumber(redis.call('HGET', KEYS[2], f) or '0')
  if rid > cur then
    redis.call('XADD', KEYS[1], 'MINID', '~', ARGV[1], '*', 'd', ARGV[i + 2])
    redis.call('HSET', KEYS[2], f, ARGV[i + 1])
    accepted = accepted + 1
  else
    dup = dup + 1
  end
end
if accepted > 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  redis.call('HINCRBY', KEYS[3], 'received', accepted)
  redis.call('SADD', KEYS[4], ARGV[3])
end
return {accepted, dup}
`;

type Client = Redis & { adAccept(numKeys: number, ...args: (string | number)[]): Promise<[number, number]> };

export function createAdReceiverRedis(redis: Redis): AdReceiverRedis {
  const r = redis as Client;
  if (typeof r.adAccept !== 'function') r.defineCommand('adAccept', { lua: ACCEPT_LUA });
  return {
    async acceptEvents(computer, events, now = Date.now()) {
      if (!events.length) return { accepted: 0, duplicates: 0 };
      const args: (string | number)[] = [String(now - AD_STREAM_RETENTION_MS), AD_HWM_TTL_SECONDS, computer];
      for (const e of events) args.push(`${e.channel}:${e.logEpoch}`, String(e.recordId), e.json);
      const [accepted, duplicates] = await r.adAccept(4, AD_KEYS.log, AD_KEYS.hwm(computer), AD_KEYS.heartbeat(computer), AD_KEYS.computers, ...args);
      return { accepted: Number(accepted), duplicates: Number(duplicates) };
    },

    async writeHeartbeat(computer, fields, agentEvents) {
      const key = AD_KEYS.heartbeat(computer);
      // 心跳欄位每次都完整寫入,直接 HSET(不 DEL):事件的 HINCRBY received 不會被蓋掉(code review M2)
      const m = r.multi().hset(key, fields).sadd(AD_KEYS.computers, computer);
      if (agentEvents.length) m.lpush(AD_KEYS.agentEvents, ...agentEvents).ltrim(AD_KEYS.agentEvents, 0, AGENT_EVENTS_MAX - 1);
      const res = await m.exec();
      const err = res?.find(([e]) => e)?.[0];
      if (err) throw err;
    },

    async watermarks(computer) {
      const all = await r.hgetall(AD_KEYS.hwm(computer));
      const out: Record<string, { logEpoch: number; lastRecordId: number }> = {};
      for (const [f, v] of Object.entries(all)) {
        const i = f.lastIndexOf(':');
        const channel = f.slice(0, i);
        const logEpoch = Number(f.slice(i + 1));
        const lastRecordId = Number(v);
        if (!channel || !Number.isSafeInteger(logEpoch) || !Number.isSafeInteger(lastRecordId)) continue;
        const cur = out[channel];
        if (!cur || logEpoch > cur.logEpoch) out[channel] = { logEpoch, lastRecordId };
      }
      return out;
    },

    async ping() {
      await r.ping();
    },

    async quit() {
      await r.quit().catch(() => undefined);
    },
  };
}

/** Redis 斷線時請求要快速失敗(回 503 讓 Agent 退避重送),不在記憶體排隊 */
export function connectAdReceiverRedis(url: string, onError: (e: Error) => void): AdReceiverRedis {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5_000, enableOfflineQueue: false });
  redis.on('error', onError);
  return createAdReceiverRedis(redis);
}
