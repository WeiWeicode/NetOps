/**
 * 假 ClickHouse 唯讀查詢(C3):記憶體中的 TRAFFIC 與威脅類紀錄(核心紀錄格式),實作 infra/clickhouse/reader 的介面
 */
import { ClickHouseError } from '../../src/infra/clickhouse/index.js';
import type { ChEventType, ClickHouseReader, LogRecord } from '../../src/infra/clickhouse/reader.js';
import { buildFilter } from '../../src/modules/pa/core/palog.js';

const ms = (t: string) => Date.parse(`${t.slice(0, 10).replace(/\//g, '-')}T${t.slice(11, 19)}+08:00`);
const HOUR = 3600_000;

export interface FakeReader extends ClickHouseReader {
  traffic: LogRecord[];
  threats: { type: ChEventType; rec: LogRecord }[];
  /** true 時每個查詢都丟 ClickHouseError(連不上) */
  failing: boolean;
  calls: string[];
}

export function trafficRecord(time: string, i: number, extra: Partial<LogRecord> = {}): LogRecord {
  return {
    time, subtype: 'end', src: `10.10.1.${i % 5}`, dst: `8.8.8.${i % 3}`, natSrc: '', natDst: '', rule: 'Allow-Web', srcUser: '', app: i % 2 ? 'ssl' : 'dns-base',
    fromZone: 'LAN', toZone: 'WAN', inIf: '', outIf: '', sport: 40000 + i, dport: i % 2 ? 443 : 53, natDport: 0, proto: i % 2 ? 'tcp' : 'udp',
    action: i % 10 === 0 ? 'deny' : 'allow', bytes: 100 + i, sent: 40, recv: 60 + i, packets: 2, start: time, elapsed: 1, category: 'any',
    srcCountry: '10.0.0.0-10.255.255.255', dstCountry: 'United States', endReason: 'tcp-fin', appRisk: 2, appCategory: '', appSubcat: '', appTech: '', srcHost: '', dstHost: '',
    ...extra,
  };
}

/** 時間(UTC 毫秒)→ 每天(台灣時間 00:00)的小時數與筆數,新的在前 */
function days(times: number[]) {
  const m = new Map<number, { hours: Set<number>; rows: number }>();
  for (const t of times) {
    const day = Math.floor((t + 8 * HOUR) / (24 * HOUR)) * 24 * HOUR - 8 * HOUR;
    const v = m.get(day) ?? { hours: new Set<number>(), rows: 0 };
    v.hours.add(Math.floor(t / HOUR));
    v.rows++;
    m.set(day, v);
  }
  return [...m].sort((a, b) => b[0] - a[0]).map(([day, v]) => ({ day, hours: v.hours.size, rows: v.rows }));
}

export function createFakeReader(traffic: LogRecord[] = [], threats: { type: ChEventType; rec: LogRecord }[] = []): FakeReader {
  const f: FakeReader = {
    traffic,
    threats,
    failing: false,
    calls: [],
    async ping() {
      check('ping');
    },
    async trafficHours(from, to) {
      check('trafficHours');
      const m = new Map<string, { hour: number; action: string; n: number; bytes: number }>();
      for (const r of f.traffic) {
        const t = ms(String(r.time));
        if (t < from || t >= to) continue;
        const hour = Math.floor(t / HOUR) * HOUR;
        const k = `${hour}|${r.action}`;
        const v = m.get(k) ?? { hour, action: String(r.action), n: 0, bytes: 0 };
        v.n++;
        v.bytes += Number(r.bytes);
        m.set(k, v);
      }
      return [...m.values()].sort((a, b) => a.hour - b.hour || a.action.localeCompare(b.action));
    },
    async trafficOptions(from, to) {
      check('trafficOptions');
      const rs = f.traffic.filter((r) => ms(String(r.time)) >= from && ms(String(r.time)) < to);
      const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();
      return { apps: uniq(rs.map((r) => String(r.app))), zones: uniq(rs.flatMap((r) => [String(r.fromZone), String(r.toZone)])), actions: uniq(rs.map((r) => String(r.action))) };
    },
    async trafficDays() {
      check('trafficDays');
      return days(f.traffic.map((r) => ms(String(r.time))));
    },
    async threatDays(type) {
      check('threatDays');
      return days(f.threats.filter((x) => x.type === type).map((x) => ms(String(x.rec.time))));
    },
    async earliestTrafficHour() {
      check('earliestTrafficHour');
      const t = f.traffic.map((r) => ms(String(r.time)));
      return t.length ? Math.floor(Math.min(...t) / HOUR) * HOUR : null;
    },
    async threatHourCounts(from, to) {
      check('threatHourCounts');
      const m = new Map<string, { type: ChEventType; hour: number; n: number }>();
      for (const { type, rec } of f.threats) {
        const t = ms(String(rec.time));
        if (t < from || t >= to) continue;
        const hour = Math.floor(t / HOUR) * HOUR;
        const v = m.get(`${type}|${hour}`) ?? { type, hour, n: 0 };
        v.n++;
        m.set(`${type}|${hour}`, v);
      }
      return [...m.values()];
    },
    async trafficRecords(from, to, onRow) {
      check('trafficRecords');
      let n = 0;
      for (const r of f.traffic) if (ms(String(r.time)) >= from && ms(String(r.time)) < to) (onRow({ ...r }), n++);
      return n;
    },
    async searchTraffic(q, limit) {
      check('searchTraffic');
      // 條件語意用核心 buildFilter(FTP 版);時間另外比
      const { fromMs, toMs, ...rest } = q;
      const filter = buildFilter(rest) as (r: LogRecord, raw: string) => boolean;
      const hit = f.traffic
        .filter((r) => ms(String(r.time)) >= fromMs && ms(String(r.time)) < toMs && filter(r, Object.values(r).join(',')))
        .sort((a, b) => String(a.time).localeCompare(String(b.time)));
      return { rows: hit.slice(0, limit).map((r) => ({ ...r })), more: hit.length > limit, scanned: f.traffic.length };
    },
    async trafficCount(from, to) {
      check('trafficCount');
      const h = (t: number) => Math.floor(t / HOUR) * HOUR;
      return f.traffic.filter((r) => ms(String(r.time)) >= h(from) && ms(String(r.time)) < to).length;
    },
    async threatRecords(type, from, to, onRow) {
      check('threatRecords');
      let n = 0;
      for (const { type: t, rec } of f.threats) if (t === type && ms(String(rec.time)) >= from && ms(String(rec.time)) < to) (onRow({ ...rec }), n++);
      return n;
    },
  };
  function check(name: string) {
    f.calls.push(name);
    if (f.failing) throw new ClickHouseError('ClickHouse 連線失敗:ECONNREFUSED', undefined, undefined);
  }
  return f;
}
