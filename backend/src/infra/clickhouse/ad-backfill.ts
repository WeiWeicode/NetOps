/**
 * AD FTP 補漏用的 ClickHouse 查詢(AD-3;netops-ingest,帳號 netops_writer)。寫入沿用 index.ts 的 insertJson(去重 token)。
 * 表名只用常數;條件一律 query_params。時間參數與回傳都是 Unix 秒。
 */
import { ClickHouseError, clickHouseBase, connectError, responseError, TABLES, type ClickHouseConfig } from './index.js';

const T = TABLES.ad;

export interface AdKeyRow {
  epoch: number;
  rid: number;
  /** Unix 秒 */
  t: number;
  eventId: number;
  source: string;
}

export interface AdBackfillCh {
  /** Agent 寫入過的 DC 與網域(Agent 的寫法為準) */
  agentComputers(): Promise<{ computer: string; domain: string }[]>;
  /** RecordID 在 [minRid, maxRid] 的列(所有來源、所有時間;已存在判斷與錨點) */
  keysInRange(computer: string, channel: string, minRid: number, maxRid: number): Promise<AdKeyRow[]>;
  /** Agent 列每個世代的最大 RecordID */
  agentEpochs(computer: string, channel: string): Promise<{ epoch: number; maxRid: number }[]>;
  /** t(含)之前最近一筆 Agent 列 */
  agentBefore(computer: string, channel: string, t: number): Promise<{ epoch: number; rid: number } | null>;
  /** t(含)之後最早一筆 Agent 列 */
  agentAfter(computer: string, channel: string, t: number): Promise<{ epoch: number; rid: number } | null>;
}

type Fetch = typeof fetch;

export function createAdBackfillCh(cfg: ClickHouseConfig, fetchImpl: Fetch = fetch): AdBackfillCh {
  const base = clickHouseBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const headers = { 'X-ClickHouse-User': cfg.user, 'X-ClickHouse-Key': cfg.password, 'Content-Type': 'text/plain; charset=utf-8' };

  async function rows<R>(sql: string, params: Record<string, string>): Promise<R[]> {
    const u = new URL(base);
    u.pathname = '/';
    for (const [k, v] of Object.entries(params)) u.searchParams.set(`param_${k}`, v);
    u.searchParams.set('output_format_json_quote_64bit_integers', '0');
    let text: string;
    try {
      const res = await fetchImpl(u, { method: 'POST', headers, body: `${sql} FORMAT JSONEachRow`, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
      if (!res.ok) throw responseError(res, text);
    } catch (e) {
      if (e instanceof ClickHouseError) throw e;
      throw connectError(e, timeoutMs);
    }
    try {
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as R);
    } catch {
      throw new ClickHouseError('ClickHouse 查詢中斷', Number(/Code: (\d+)/.exec(text)?.[1]) || undefined, 200);
    }
  }
  const dc = (computer: string, channel: string) => ({ c: computer, ch: channel });
  const one = async (sql: string, params: Record<string, string>) => {
    const r = await rows<{ e: number; r: number }>(sql, params);
    return r[0] ? { epoch: Number(r[0].e), rid: Number(r[0].r) } : null;
  };

  return {
    async agentComputers() {
      const r = await rows<{ c: string; d: string }>(`SELECT computer AS c, any(ad_domain) AS d FROM ${T} WHERE source = 'agent' GROUP BY c`, {});
      return r.map((x) => ({ computer: x.c, domain: x.d }));
    },
    async keysInRange(computer, channel, minRid, maxRid) {
      const r = await rows<{ e: number; r: number; t: number; i: number; s: string }>(
        `SELECT log_epoch AS e, record_id AS r, toUnixTimestamp(event_time) AS t, event_id AS i, source AS s FROM ${T}
         WHERE computer = {c:String} AND channel = {ch:String} AND record_id BETWEEN {lo:UInt64} AND {hi:UInt64}`,
        { ...dc(computer, channel), lo: String(minRid), hi: String(maxRid) },
      );
      return r.map((x) => ({ epoch: Number(x.e), rid: Number(x.r), t: Number(x.t), eventId: Number(x.i), source: x.s }));
    },
    async agentEpochs(computer, channel) {
      const r = await rows<{ e: number; m: number }>(
        `SELECT log_epoch AS e, max(record_id) AS m FROM ${T} WHERE computer = {c:String} AND channel = {ch:String} AND source = 'agent' GROUP BY e`,
        dc(computer, channel),
      );
      return r.map((x) => ({ epoch: Number(x.e), maxRid: Number(x.m) }));
    },
    agentBefore: (computer, channel, t) =>
      one(
        `SELECT log_epoch AS e, record_id AS r FROM ${T} WHERE computer = {c:String} AND channel = {ch:String} AND source = 'agent' AND event_time <= toDateTime({t:UInt32})
         ORDER BY event_time DESC, log_epoch DESC, record_id DESC LIMIT 1`,
        { ...dc(computer, channel), t: String(t) },
      ),
    agentAfter: (computer, channel, t) =>
      one(
        `SELECT log_epoch AS e, record_id AS r FROM ${T} WHERE computer = {c:String} AND channel = {ch:String} AND source = 'agent' AND event_time >= toDateTime({t:UInt32})
         ORDER BY event_time ASC, log_epoch ASC, record_id ASC LIMIT 1`,
        { ...dc(computer, channel), t: String(t) },
      ),
  };
}
