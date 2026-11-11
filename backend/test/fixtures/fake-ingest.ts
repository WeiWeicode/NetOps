/**
 * netops-ingest 測試用的假 Redis Stream(consumer group 語意)與假 ClickHouse(去重 token、失敗注入)。
 * 只實作 IngestRedis / ClickHouseWriter 介面;真 Redis / ClickHouse 的行為在 test/integration/ 驗證。
 */
import { ClickHouseError, type ClickHouseWriter, type TableKey } from '../../src/infra/clickhouse/index.js';
import { compareId, gapFrom, INGEST_TYPES, type Gap, type IngestRedis, type IngestType, type RawEntry } from '../../src/infra/redis/ingest.js';

interface Stream {
  entries: { id: string; data: string }[];
  added: number;
  maxDeleted: string;
  group: { lastDelivered: string; read: number; pending: Set<string> } | null;
}

export class FakeIngestRedis implements IngestRedis {
  streams = new Map<IngestType, Stream>(INGEST_TYPES.map((t) => [t, { entries: [], added: 0, maxDeleted: '0-0', group: null }]));
  gaps: (Gap & { detectedAt: string })[] = [];
  gapBase: Partial<Record<IngestType, number>> = {};
  heartbeat: Record<string, string> = {};
  acked: Partial<Record<IngestType, string[]>> = {};
  /** 下一次 readNew / ack 拋錯(模擬 Redis 斷線) */
  failRead = 0;
  failAck = 0;
  private seq = 0;
  /** readNew 沒有資料時呼叫(測試用來推進時間或中止) */
  onIdle: (() => void) | null = null;

  add(t: IngestType, rec: Record<string, unknown> | string, ms = 1_762_740_000_000): string {
    const s = this.streams.get(t)!;
    const id = `${ms}-${this.seq++}`;
    s.entries.push({ id, data: typeof rec === 'string' ? rec : JSON.stringify(rec) });
    s.added++;
    return id;
  }
  /** 模擬 XTRIM MINID:刪掉 ID 小於 minId 的條目(不管 group 讀過沒有) */
  trim(t: IngestType, minId: string) {
    const s = this.streams.get(t)!;
    for (const e of s.entries) if (compareId(e.id, minId) < 0 && compareId(e.id, s.maxDeleted) > 0) s.maxDeleted = e.id;
    s.entries = s.entries.filter((e) => compareId(e.id, minId) >= 0);
  }

  async ensureGroup(t: IngestType) {
    const s = this.streams.get(t)!;
    if (s.group) return false;
    s.group = { lastDelivered: '0-0', read: 0, pending: new Set() };
    return true;
  }
  async readPending(t: IngestType, after: string, count: number): Promise<RawEntry[]> {
    const s = this.streams.get(t)!;
    const ids = [...s.group!.pending].filter((id) => compareId(id, after) > 0).sort(compareId).slice(0, count);
    return ids.map((id) => ({ id, data: s.entries.find((e) => e.id === id)?.data ?? null }));
  }
  async readNew(types: readonly IngestType[], count: number): Promise<Partial<Record<IngestType, RawEntry[]>>> {
    if (this.failRead > 0) {
      this.failRead--;
      throw new Error('connect ECONNREFUSED');
    }
    const out: Partial<Record<IngestType, RawEntry[]>> = {};
    for (const t of types) {
      const s = this.streams.get(t)!;
      const g = s.group!;
      const rows = s.entries.filter((e) => compareId(e.id, g.lastDelivered) > 0).slice(0, count);
      if (!rows.length) continue;
      for (const r of rows) g.pending.add(r.id);
      g.lastDelivered = rows.at(-1)!.id;
      g.read += rows.length;
      out[t] = rows.map((r) => ({ id: r.id, data: r.data }));
    }
    if (!Object.keys(out).length) this.onIdle?.();
    return out;
  }
  async ack(t: IngestType, ids: readonly string[]) {
    if (this.failAck > 0) {
      this.failAck--;
      throw new Error('connect ECONNREFUSED');
    }
    const g = this.streams.get(t)!.group!;
    for (const id of ids) g.pending.delete(id);
    (this.acked[t] ??= []).push(...ids);
  }
  async detectGap(t: IngestType) {
    const s = this.streams.get(t)!;
    if (!s.group) return null;
    const pend = [...s.group.pending].sort(compareId);
    const r = gapFrom(
      t,
      { firstId: s.entries[0]?.id ?? null, length: s.entries.length, entriesAdded: s.added },
      { lastDelivered: s.group.lastDelivered, entriesRead: s.group.read },
      { count: pend.length, minId: pend[0] ?? null },
      this.gapBase[t] ?? 0,
    );
    if (r.newBase !== null) this.gapBase[t] = r.newBase;
    return r.gap;
  }
  async pushGap(g: Gap & { detectedAt: string }) {
    this.gaps.unshift(g);
  }
  async writeHeartbeat(f: Record<string, string>) {
    this.heartbeat = { ...f };
  }
  async quit() {}
}

export class FakeClickHouse implements ClickHouseWriter {
  tables: Record<TableKey, Record<string, unknown>[]> = { traffic: [], threat: [] };
  tokens = new Set<string>();
  calls: { table: TableKey; rows: number; token: string }[] = [];
  /** 接下來幾次 insert 拋暫時性錯誤 */
  failTransient = 0;
  /** 這些 src 值的列會讓 insert 拋資料錯誤(模擬型別錯誤) */
  badSrc = new Set<string>();
  /** 每次 insert 都拋這個錯誤(模擬結構性錯誤、未知 400) */
  failWith: ClickHouseError | null = null;

  async insert(table: TableKey, rows: readonly Record<string, unknown>[], token: string) {
    this.calls.push({ table, rows: rows.length, token });
    if (this.failTransient > 0) {
      this.failTransient--;
      throw new ClickHouseError('ClickHouse 連線失敗:ECONNREFUSED', undefined, undefined);
    }
    if (this.failWith) throw this.failWith;
    if (rows.some((r) => this.badSrc.has(String(r.src)))) throw new ClickHouseError('Code: 27. Cannot parse input', 27, 400);
    // 同一個 token 重送:略過(non_replicated_deduplication_window)
    if (this.tokens.has(`${table}|${token}`)) return;
    this.tokens.add(`${table}|${token}`);
    this.tables[table].push(...rows);
  }
  async insertJson(table: TableKey, lines: readonly string[], token: string) {
    await this.insert(table, lines.map((l) => JSON.parse(l) as Record<string, unknown>), token);
  }
  async ping() {}
  /** FTP 補漏(C3):已寫入的 TRAFFIC seqno(event_time 是台灣時間字串) */
  async trafficSeqnos(fromMs: number, toMs: number) {
    const ms = (t: string) => Date.parse(`${t.replace(' ', 'T')}+08:00`);
    return new Set(this.tables.traffic.filter((r) => ms(String(r.event_time)) >= fromMs && ms(String(r.event_time)) < toMs && String(r.seqno) !== '0').map((r) => String(r.seqno)));
  }
}
