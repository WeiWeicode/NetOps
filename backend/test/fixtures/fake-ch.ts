/**
 * 假 ClickHouse 唯讀查詢(C3):記憶體中的 TRAFFIC 與威脅類紀錄(核心紀錄格式),實作 infra/clickhouse/reader 的介面
 */
import { ClickHouseError } from '../../src/infra/clickhouse/index.js';
import type { AiCond, AiFlowRow, AiThreatRow, ChEventType, ClickHouseReader, LogRecord, TopRow, TrafficFilter } from '../../src/infra/clickhouse/reader.js';
import { buildCondition } from '../../src/modules/ai/core/evidence.js';
import { buildFilter } from '../../src/modules/pa/core/palog.js';

const ms = (t: string) => Date.parse(`${t.slice(0, 10).replace(/\//g, '-')}T${t.slice(11, 19)}+08:00`);
const HOUR = 3600_000;

export interface FakeReader extends ClickHouseReader {
  traffic: LogRecord[];
  threats: { type: ChEventType; rec: LogRecord }[];
  /** true 時每個查詢都丟 ClickHouseError(連不上) */
  failing: boolean;
  calls: string[];
  /**
   * 原始表的保留期限(AC2 長期間 fixture):這個時間(UTC 毫秒)之前的原始 TRAFFIC / 威脅類查不到(TTL 已刪),
   * 彙總(aiDays、aiTops、trafficDays、trafficHours)仍看得到;未設定 = 全部都在
   */
  rawSince: { traffic?: number; threat?: number };
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
    rawSince: {},
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
    async threatDays() {
      check('threatDays');
      const types = [...new Set(f.threats.map((x) => x.type))];
      return types.flatMap((type) => days(f.threats.filter((x) => x.type === type).map((x) => ms(String(x.rec.time)))).map((d) => ({ type, ...d })));
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
      for (const r of f.traffic) if (ms(String(r.time)) >= Math.max(from, f.rawSince.traffic ?? -Infinity) && ms(String(r.time)) < to) (onRow({ ...r }), n++);
      return n;
    },
    async searchTraffic(q, limit) {
      check('searchTraffic');
      return search(f.traffic, q, limit, f.traffic.length);
    },
    async searchThreat(q, limit) {
      check('searchThreat');
      const { severity, threat, ...rest } = q;
      const sev = severity === 'info' ? 'informational' : severity;
      const recs = f.threats
        .filter((x) => x.type === 'threat')
        .map((x) => x.rec)
        .filter((r) => (!sev || r.severity === sev) && (!threat || String(r.name).toLowerCase().includes(threat.toLowerCase())));
      return search(recs, rest, limit, f.threats.length);
    },
    async threatCount(from, to) {
      check('threatCount');
      return f.threats.filter((x) => x.type === 'threat' && ms(String(x.rec.time)) >= from && ms(String(x.rec.time)) < to).length;
    },
    async trafficCount(from, to) {
      check('trafficCount');
      const h = (t: number) => Math.floor(t / HOUR) * HOUR;
      return f.traffic.filter((r) => ms(String(r.time)) >= h(from) && ms(String(r.time)) < to).length;
    },
    async threatRecords(type, from, to, onRow) {
      check('threatRecords');
      let n = 0;
      for (const { type: t, rec } of f.threats) if (t === type && ms(String(rec.time)) >= Math.max(from, f.rawSince.threat ?? -Infinity) && ms(String(rec.time)) < to) (onRow({ ...rec }), n++);
      return n;
    },
    async aiTrafficFlows(cond, from, to, limit) {
      check('aiTrafficFlows');
      const m = new Map<string, AiFlowRow>();
      for (const r of rawTraffic(cond, from, to)) {
        const hour = String(r.time).slice(0, 13);
        const g = { src: s(r.src), dst: s(r.dst), natSrc: s(r.natSrc), natDst: s(r.natDst), proto: s(r.proto), dport: Number(r.dport) || 0, action: s(r.action), rule: s(r.rule), app: s(r.app), fromZone: s(r.fromZone), toZone: s(r.toZone), dstCountry: s(r.dstCountry), srcUser: s(r.srcUser), category: s(r.category), hour };
        const k = JSON.stringify(g);
        const v: AiFlowRow = m.get(k) ?? { ...g, first: s(r.time), last: s(r.time), n: 0, bytes: 0, end: [] };
        v.n++;
        v.bytes += Number(r.bytes) || 0;
        if (s(r.time) < v.first) v.first = s(r.time);
        if (s(r.time) > v.last) v.last = s(r.time);
        const e = v.end.find(([x]) => x === s(r.endReason));
        if (e) e[1]++;
        else v.end.push([s(r.endReason), 1]);
        m.set(k, v);
      }
      const all = [...m.values()].sort((a, b) => b.n - a.n);
      return { rows: all.slice(0, limit), truncated: all.length > limit };
    },
    async aiTrafficSamples(cond, from, to, limit) {
      check('aiTrafficSamples');
      const seen = new Set<string>();
      const out: LogRecord[] = [];
      for (const r of rawTraffic(cond, from, to).sort((a, b) => s(b.time).localeCompare(s(a.time)))) {
        const k = [r.src, r.dst, r.dport, r.action, r.rule].join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ...r });
        if (out.length >= limit) break;
      }
      return out;
    },
    async aiThreatGroups(types, cond, from, to, limit) {
      check('aiThreatGroups');
      const test = (buildCondition(cond, '', '9999') as { flowTest: (r: unknown) => boolean }).flowTest;
      const since = f.rawSince.threat ?? -Infinity;
      const m = new Map<string, AiThreatRow>();
      for (const { type, rec } of f.threats) {
        const t = ms(String(rec.time));
        if (!types.includes(type) || t < from || t >= to || t < since || !test(rec)) continue;
        const { time, repeat, ...rest } = rec;
        const k = JSON.stringify([type, rest]);
        const v = m.get(k) ?? ({ ...rest, type, n: 0, first: s(time), last: s(time) } as AiThreatRow);
        v.n += Math.max(Number(repeat) || 1, 1);
        if (s(time) < v.first) v.first = s(time);
        if (s(time) > v.last) v.last = s(time);
        m.set(k, v);
      }
      const all = [...m.values()].sort((a, b) => b.n - a.n);
      return { rows: all.slice(0, limit), truncated: all.length > limit };
    },
    async aiDays(from, to) {
      check('aiDays');
      type Day = { day: number; sessions: number; deny: number; bytes: number; sent: number; recv: number; critical: number; high: number; medium: number; low: number; info: number };
      const m = new Map<number, Day>();
      const get = (t: number) => {
        const day = Math.floor((t + 8 * HOUR) / (24 * HOUR)) * 24 * HOUR - 8 * HOUR;
        const v = m.get(day) ?? { day, sessions: 0, deny: 0, bytes: 0, sent: 0, recv: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        m.set(day, v);
        return v;
      };
      for (const r of f.traffic) {
        const t = ms(s(r.time));
        if (t < from || t >= to) continue;
        const v = get(t);
        v.sessions++;
        if (r.action !== 'allow') v.deny++;
        v.bytes += Number(r.bytes) || 0;
        v.sent += Number(r.sent) || 0;
        v.recv += Number(r.recv) || 0;
      }
      for (const { type, rec } of f.threats) {
        const t = ms(s(rec.time));
        if (type !== 'threat' || t < from || t >= to) continue;
        const sev = s(rec.severity) === 'informational' ? 'info' : s(rec.severity);
        const v = get(t) as unknown as Record<string, number>;
        if (sev in v) v[sev] = (v[sev] ?? 0) + 1;
      }
      return [...m.values()].sort((a, b) => a.day - b.day);
    },
    async aiTops(from, to, limit) {
      check('aiTops');
      const rs = f.traffic.filter((r) => ms(s(r.time)) >= from && ms(s(r.time)) < to);
      const top = (key: (r: LogRecord) => string, list = rs): TopRow[] => {
        const m = new Map<string, TopRow>();
        for (const r of list) {
          const k = key(r);
          if (!k) continue;
          const v: TopRow = m.get(k) ?? [k, 0, 0];
          v[1]++;
          v[2] += Number(r.bytes) || 0;
          m.set(k, v);
        }
        const all = [...m.values()];
        const keys = new Map<string, TopRow>();
        for (const x of [...[...all].sort((a, b) => b[1] - a[1]).slice(0, limit), ...[...all].sort((a, b) => b[2] - a[2]).slice(0, limit)]) keys.set(x[0], x);
        return [...keys.values()];
      };
      const actions: Record<string, number> = {};
      for (const r of rs) actions[s(r.action) || '(空白)'] = (actions[s(r.action) || '(空白)'] ?? 0) + 1;
      return {
        actions,
        app: top((r) => s(r.app)),
        zone: top((r) => (r.fromZone || r.toZone ? `${r.fromZone || '?'} → ${r.toZone || '?'}` : '')),
        src: top((r) => s(r.src)),
        blockSrc: top((r) => s(r.src), rs.filter((r) => r.action !== 'allow')),
      };
    },
  };
  const s = (v: unknown) => String(v ?? '');
  /** 原始 TRAFFIC(保留期限內)符合 AI 問答條件的紀錄:條件語意用核心 buildCondition(FTP 版) */
  function rawTraffic(cond: AiCond, from: number, to: number) {
    const { filter } = buildCondition(cond, '', '9999') as { filter: (r: unknown, raw: string) => boolean };
    const since = f.rawSince.traffic ?? -Infinity;
    return f.traffic.filter((r) => {
      const t = ms(s(r.time));
      return t >= from && t < to && t >= since && filter(r, Object.values(r).join(','));
    });
  }
  /** 條件語意用核心 buildFilter(FTP 版);時間與來源 / 目的國家另外比 */
  function search(recs: LogRecord[], q: TrafficFilter, limit: number, scanned: number) {
    const { fromMs, toMs, srcCountry, dstCountry, ipRanges, ...rest } = q;
    const filter = buildFilter(rest) as (r: LogRecord, raw: string) => boolean;
    const has = (v: unknown, x?: string) => !x || String(v).toLowerCase().includes(x.toLowerCase());
    // AC3 名稱搜尋:來源、目的、NAT 任一方落在範圍內(同 trafficWhere 的 ipRanges)
    const n = (ip: string) => ip.split('.').reduce((x, p) => x * 256 + Number(p), 0);
    const inRanges = (r: LogRecord) =>
      !ipRanges ||
      [r.src, r.dst, r.natSrc, r.natDst].some((ip) => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ipRanges.some(([a, b]) => n(ip) >= n(a) && n(ip) <= n(b)));
    const hit = recs
      .filter((r) => ms(String(r.time)) >= fromMs && ms(String(r.time)) < toMs && has(r.srcCountry, srcCountry) && has(r.dstCountry, dstCountry) && inRanges(r) && filter(r, Object.values(r).join(',')))
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    return { rows: hit.slice(0, limit).map((r) => ({ ...r })), more: hit.length > limit, scanned };
  }
  function check(name: string) {
    f.calls.push(name);
    if (f.failing) throw new ClickHouseError('ClickHouse 連線失敗:ECONNREFUSED', undefined, undefined);
  }
  return f;
}
