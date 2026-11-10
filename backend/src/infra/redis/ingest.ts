/**
 * netops-ingest 用的 Redis 存取(C2;手冊 docs/PA-LOG-CLICKHOUSE-GUIDE.md §6.4、§6.6;PA-LIVE-PLAN §4)。
 * 鍵只在這裡組(AGENT.md §7.2);log Stream 的鍵格式與 index.ts、pa-collector/netops_pa/keys.py 相同。
 *
 *   netops:pa:log:{type}        既有 Stream(netops-pa 寫);新增 consumer group ch-writer(本服務讀 + ACK)
 *   netops:ingest:heartbeat     Hash,本服務狀態(整個換新,不設 TTL;停止時 updatedAt 停在最後時間)
 *   netops:ingest:gaps          List,偵測到的缺口(JSON,最新在前,最多 GAPS_MAX 筆),給 C3 的 FTP 補漏與對帳
 *
 * 寫入只有上面三項(ch-writer 的讀取位置與 ACK、心跳、缺口清單);不寫 netops-pa 的其他鍵。
 */
import { Redis } from 'ioredis';

/** 寫進 ClickHouse 的類型(ARCHITECTURE D27):decryption、globalprotect、userid 不進 ClickHouse */
export const INGEST_TYPES = ['traffic', 'threat', 'url', 'data', 'wildfire'] as const;
export type IngestType = (typeof INGEST_TYPES)[number];

export const GROUP = 'ch-writer';
/** 單一容器、單一 consumer(同 D9 的理由:待處理清單與去重 token 才穩定) */
export const CONSUMER = 'ingest-1';
export const GAPS_MAX = 200;

export const INGEST_KEYS = {
  log: (t: IngestType) => `netops:pa:log:${t}`,
  heartbeat: 'netops:ingest:heartbeat',
  gaps: 'netops:ingest:gaps',
};

/** Stream 一筆。data 為 null:待處理條目已被 XTRIM 修剪(只會在讀待處理清單時出現) */
export interface RawEntry {
  id: string;
  data: string | null;
}

export interface Gap {
  type: IngestType;
  /** 最後送達(或最舊的待處理)Stream ID;這之後、to 之前的條目已被修剪,沒寫進 ClickHouse */
  from: string;
  /** 目前 Stream 第一筆的 ID */
  to: string;
  /** 遺失筆數(可算出時;Redis 算不出時為 null) */
  missed: number | null;
}

export interface IngestRedis {
  /** 建立 consumer group(已存在不動),從 0 開始:第一次部署把 Stream 裡現有的 log 一起寫進去。回傳是否新建 */
  ensureGroup(t: IngestType): Promise<boolean>;
  /** 這個 consumer 的待處理條目(已送達、未 ACK),從 after 之後開始;不阻塞 */
  readPending(t: IngestType, after: string, count: number): Promise<RawEntry[]>;
  /** 新條目(>);多個 Stream 一次讀,最多阻塞 blockMs */
  readNew(types: readonly IngestType[], count: number, blockMs: number): Promise<Partial<Record<IngestType, RawEntry[]>>>;
  ack(t: IngestType, ids: readonly string[]): Promise<void>;
  /** 缺口偵測(啟動時與每次心跳);沒有缺口回 null */
  detectGap(t: IngestType): Promise<Gap | null>;
  pushGap(g: Gap & { detectedAt: string }): Promise<void>;
  writeHeartbeat(fields: Record<string, string>): Promise<void>;
  quit(): Promise<void>;
}

/** 本模組用到的 Redis 指令(測試以真 Redis 或假實作替換) */
export type IngestRedisClient = Pick<Redis, 'xgroup' | 'xreadgroup' | 'xack' | 'xinfo' | 'xpending' | 'lpush' | 'ltrim' | 'multi' | 'quit'>;

/** Stream ID 比較(毫秒-序號;用 BigInt,不受 2^53 限制) */
export function compareId(a: string, b: string): number {
  const [am = 0n, as = 0n] = a.split('-').map((x) => BigInt(x));
  const [bm = 0n, bs = 0n] = b.split('-').map((x) => BigInt(x));
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}

const toObject = (arr: unknown[]): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  for (let i = 0; i + 1 < arr.length; i += 2) o[String(arr[i])] = arr[i + 1];
  return o;
};

const message = (e: unknown) => String((e as Error)?.message ?? e);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

type XReadReply = [string, [string, string[] | null][]][] | null;

function parseEntries(rows: [string, string[] | null][]): RawEntry[] {
  return rows.map(([id, f]) => {
    if (!f) return { id, data: null };
    const i = f.indexOf('d');
    // 沒有 d 欄位:不是 netops-pa 寫的格式,交給呼叫端計為畸形
    return { id, data: i >= 0 ? (f[i + 1] ?? '') : '' };
  });
}

/**
 * 缺口判斷(純函式,方便測試):
 * ① 待處理(已送達未 ACK)的最小 ID 比 Stream 第一筆還舊 → 那些條目被修剪了,沒寫進 ClickHouse;
 * ② group 最後送達的 ID 比第一筆還舊,而且「總共加入 − 已送達 − 目前長度」> 0 → 還沒送達就被修剪。
 *    只看 ID 會誤判:類型很久沒有新 log 時,最後一筆被修剪、之後新加的第一筆本來就比較新,中間其實沒有漏。
 *    Redis 算不出計數(entries-read 為 null)時保守視為缺口。
 */
export function gapFrom(
  t: IngestType,
  stream: { firstId: string | null; length: number; entriesAdded: number | null },
  group: { lastDelivered: string; entriesRead: number | null },
  pending: { count: number; minId: string | null },
): Gap | null {
  const first = stream.firstId;
  if (!first) return null;
  if (pending.count > 0 && pending.minId && compareId(pending.minId, first) < 0) return { type: t, from: pending.minId, to: first, missed: null };
  const last = group.lastDelivered;
  if (last === '0-0' || compareId(last, first) >= 0) return null;
  if (stream.entriesAdded === null || group.entriesRead === null) return { type: t, from: last, to: first, missed: null };
  const missed = stream.entriesAdded - group.entriesRead - stream.length;
  return missed > 0 ? { type: t, from: last, to: first, missed } : null;
}

export function createIngestRedis(client: IngestRedisClient, reader: IngestRedisClient = client): IngestRedis {
  async function ensureGroup(t: IngestType): Promise<boolean> {
    try {
      // MKSTREAM:類型還沒有 log 時先建空 Stream(netops-pa 之後 XADD 會設 EXPIRE)
      await client.xgroup('CREATE', INGEST_KEYS.log(t), GROUP, '0', 'MKSTREAM');
      return true;
    } catch (e) {
      if (/BUSYGROUP/.test(message(e))) return false;
      throw e;
    }
  }

  /** Stream 過期後被 netops-pa 重建時 group 會跟著消失:重建 group(從 0,新 Stream 全部都沒讀過)再試一次 */
  async function withGroup<T>(types: readonly IngestType[], fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!/NOGROUP/.test(message(e))) throw e;
      for (const t of types) await ensureGroup(t);
      return fn();
    }
  }

  return {
    ensureGroup,

    async readPending(t, after, count) {
      const res = (await withGroup([t], () =>
        reader.xreadgroup('GROUP', GROUP, CONSUMER, 'COUNT', count, 'STREAMS', INGEST_KEYS.log(t), after),
      )) as XReadReply;
      return parseEntries(res?.[0]?.[1] ?? []);
    },

    async readNew(types, count, blockMs) {
      if (!types.length) return {};
      const res = (await withGroup(types, () =>
        reader.xreadgroup(
          'GROUP', GROUP, CONSUMER, 'COUNT', count, 'BLOCK', blockMs,
          'STREAMS', ...types.map((t) => INGEST_KEYS.log(t)), ...types.map(() => '>'),
        ),
      )) as XReadReply;
      const out: Partial<Record<IngestType, RawEntry[]>> = {};
      for (const [key, rows] of res ?? []) {
        const t = types.find((x) => INGEST_KEYS.log(x) === key);
        if (t) out[t] = parseEntries(rows);
      }
      return out;
    },

    async ack(t, ids) {
      if (ids.length) await client.xack(INGEST_KEYS.log(t), GROUP, ...ids);
    },

    async detectGap(t) {
      let info: Record<string, unknown>;
      try {
        info = toObject((await client.xinfo('STREAM', INGEST_KEYS.log(t))) as unknown[]);
      } catch (e) {
        if (/no such key/i.test(message(e))) return null;
        throw e;
      }
      const groups = ((await client.xinfo('GROUPS', INGEST_KEYS.log(t))) as unknown[][]).map(toObject);
      const g = groups.find((x) => x.name === GROUP);
      if (!g) return null;
      const p = (await client.xpending(INGEST_KEYS.log(t), GROUP)) as [number, string | null, string | null, unknown];
      return gapFrom(
        t,
        { firstId: (info['first-entry'] as [string, unknown] | null | undefined)?.[0] ?? null, length: Number(info.length ?? 0), entriesAdded: num(info['entries-added']) },
        { lastDelivered: String(g['last-delivered-id'] ?? '0-0'), entriesRead: num(g['entries-read']) },
        { count: Number(p[0] ?? 0), minId: p[1] ?? null },
      );
    },

    async pushGap(g) {
      await client.lpush(INGEST_KEYS.gaps, JSON.stringify(g));
      await client.ltrim(INGEST_KEYS.gaps, 0, GAPS_MAX - 1);
    },

    async writeHeartbeat(fields) {
      // 整個換新(清掉已恢復的錯誤欄位),同 netops-pa 心跳做法
      const res = await client.multi().del(INGEST_KEYS.heartbeat).hset(INGEST_KEYS.heartbeat, fields).exec();
      const err = res?.find(([e]) => e)?.[0];
      if (err) throw err;
    },

    async quit() {
      await client.quit().catch(() => undefined);
      if (reader !== client) await reader.quit().catch(() => undefined);
    },
  };
}

/** 兩條連線:XREADGROUP BLOCK 會佔住連線,ACK 與心跳走另一條 */
export function connectIngestRedis(url: string, onError: (e: Error) => void): IngestRedis {
  const opts = { maxRetriesPerRequest: 2, connectTimeout: 5_000 };
  const client = new Redis(url, opts);
  const reader = new Redis(url, opts);
  client.on('error', onError);
  reader.on('error', onError);
  return createIngestRedis(client, reader);
}
