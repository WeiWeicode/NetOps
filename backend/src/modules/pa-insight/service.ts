/**
 * 分析儀表板(V-b1;docs/VIZ-RULES-DESIGN.md §4.4):一個視角一支 API,一次回該視角全部圖表的資料(畫面一個請求、快取一份)。
 *   traffic  趨勢(上傳 / 下載 + Session)、桑基圖(來源區域 → App → 目的區域)、Top 10 頻寬 IP、Top 10 App、Allow vs Deny
 *   threat   嚴重度計分卡(含前一個同長度期間)、威脅時序、國家(ISO2,給地圖)、內網發起最多的 IP、被攻擊最多的伺服器、Top 10 威脅名稱
 * 期間 from / to 為 'YYYY-MM-DD'(含當天),最長 90 天(來源 IP 彙總與威脅原始表保留 90 天)。只讀彙總表與威脅原始表(log_type 排序鍵裁切)。
 * 伺服器網段要等 V-c 的偵測設定(網段清單 X11 待需求方提供):topServerDst 回 null 並帶 notes;內網先用 RFC 1918。
 */
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import type { HeatGrain, HeatReader, HeatRow } from '../../infra/clickhouse/heat.js';
import type { DashboardCache } from '../../infra/redis/cache.js';
import { unavailable } from '../pa/ch-overview.js';
import type { Reconciler } from '../pa/reconcile.js';
import { dayText, isoTaipei, parseDay, taipeiDayOf } from '../pa-heat/heat.js';
import { countryIso2 } from './countries.js';

const DAY_MS = 86_400_000;
export const INSIGHT_MAX_DAYS = 90;
const GRAIN_MS: Record<HeatGrain, number> = { '5m': 300_000, '1h': 3600_000, '1d': DAY_MS };
/** 桑基圖 App 取前幾名(其他併「其他」) */
const SANKEY_APPS = 15;
const TOP = 10;
const OTHER = '其他';
const UNKNOWN = '未知';

export interface InsightDeps {
  heat: HeatReader | null;
  cache: DashboardCache;
  recon: Reconciler | null;
  log: { warn(o: object, m: string): void };
  now?: () => number;
}

interface Range {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  days: number;
}

/** 趨勢的粒度:≤ 2 天每 5 分鐘、≤ 31 天每小時、其他每天 */
export const trendGrain = (days: number): HeatGrain => (days <= 2 ? '5m' : days <= 31 ? '1h' : '1d');
/** Allow vs Deny:≤ 2 天每小時,其他每天 */
export const allowDenyGrain = (days: number): HeatGrain => (days <= 2 ? '1h' : '1d');

/** 每格的時間(只到現在);rows 依 t 對應,沒有列的格子:since 之後 0、之前 null */
function series<T>(r: Range, grain: HeatGrain, rows: HeatRow[], since: number | null, now: number, pick: (x: HeatRow) => T, zero: T): { t: string; v: T | null }[] {
  const by = new Map(rows.map((x) => [x.t, x]));
  const out: { t: string; v: T | null }[] = [];
  for (let t = r.fromMs; t < r.toMs && t <= now; t += GRAIN_MS[grain]) {
    const x = by.get(t);
    out.push({ t: isoTaipei(t), v: x ? pick(x) : since !== null && t >= since ? zero : null });
  }
  return out;
}

const sum = (rows: HeatRow[]) =>
  rows.reduce((s, r) => ({ critical: s.critical + r.critical, high: s.high + r.high, medium: s.medium + r.medium, low: s.low + r.low, info: s.info + r.info }), {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  });

/** PA 的國家欄位是內網範圍(10.0.0.0-10.255.255.255)時不列入 */
const isRange = (c: string) => /^[\d.:a-f]+-[\d.:a-f]+$/i.test(c.trim());

/** 國家排行(純函式):英文全名 → ISO2,對不到的併成「未知」,內網範圍排除;依筆數排序 */
export function toCountries(rows: { country: string; count: number; critical: number; high: number }[]) {
  const m = new Map<string, { country: string; iso2: string | null; count: number; critical: number; high: number }>();
  for (const r of rows) {
    if (!r.country || isRange(r.country)) continue;
    const iso2 = countryIso2(r.country);
    const key = iso2 ?? UNKNOWN;
    const cur = m.get(key) ?? { country: iso2 ? r.country : UNKNOWN, iso2, count: 0, critical: 0, high: 0 };
    cur.count += r.count;
    cur.critical += r.critical;
    cur.high += r.high;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));
}

/** 桑基圖(純函式):三層節點 z:來源區域、a:App、d:目的區域;App 空字串(前幾名以外)為「其他」 */
export function toSankey(flows: { fromZone: string; app: string; toZone: string; bytes: number }[]) {
  const nodes = new Map<string, { id: string; name: string; layer: 0 | 1 | 2 }>();
  const links = new Map<string, { source: string; target: string; bytes: number }>();
  const node = (id: string, name: string, layer: 0 | 1 | 2) => (nodes.has(id) || nodes.set(id, { id, name, layer }), id);
  const link = (source: string, target: string, bytes: number) => {
    const k = `${source}\u0000${target}`;
    const cur = links.get(k) ?? { source, target, bytes: 0 };
    cur.bytes += bytes;
    links.set(k, cur);
  };
  for (const f of flows) {
    const z = node(`z:${f.fromZone || UNKNOWN}`, f.fromZone || UNKNOWN, 0);
    const a = node(`a:${f.app || OTHER}`, f.app || OTHER, 1);
    const d = node(`d:${f.toZone || UNKNOWN}`, f.toZone || UNKNOWN, 2);
    link(z, a, f.bytes);
    link(a, d, f.bytes);
  }
  return { nodes: [...nodes.values()], links: [...links.values()].sort((x, y) => y.bytes - x.bytes) };
}

export function createInsightService(d: InsightDeps) {
  const now = d.now ?? Date.now;

  function range(q: { from: string; to: string }): Range {
    const bad = (field: string, message: string) => new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field, message }]);
    const fromMs = parseDay(q.from);
    const toDay = parseDay(q.to);
    if (Number.isNaN(fromMs)) throw bad('from', '日期格式必須是 YYYY-MM-DD');
    if (Number.isNaN(toDay)) throw bad('to', '日期格式必須是 YYYY-MM-DD');
    if (toDay < fromMs) throw bad('to', '結束日期不可早於開始日期');
    if (toDay > taipeiDayOf(now())) throw bad('to', '結束日期不可晚於今天');
    const days = Math.round((toDay - fromMs) / DAY_MS) + 1;
    if (days > INSIGHT_MAX_DAYS) throw bad('to', `期間最長 ${INSIGHT_MAX_DAYS} 天`);
    return { from: q.from, to: q.to, fromMs, toMs: toDay + DAY_MS, days };
  }

  const reader = () => {
    if (!d.heat) throw unavailable();
    return d.heat;
  };

  async function viaCh<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ClickHouseError)) throw err;
      d.log.warn({ code: err.code, status: err.status }, 'ClickHouse 儀表板查詢失敗');
      throw unavailable({ code: err.code, status: err.status });
    }
  }

  /** 已知缺口(同熱力圖:C3 每日對帳的缺口小時) */
  function coverage(r: Range, since: number | null) {
    const gaps: { from: string; to: string; reason: string }[] = [];
    if (d.recon)
      for (const day of d.recon.list(r.from.replace(/-/g, '/'), r.to.replace(/-/g, '/')))
        for (const h of day.hours)
          if (h.status === 'gap') {
            const s = Date.parse(`${h.hour.slice(0, 10).replace(/\//g, '-')}T${h.hour.slice(11, 13)}:00:00+08:00`);
            gaps.push({ from: isoTaipei(s), to: isoTaipei(s + 3600_000), reason: 'recon-gap' });
          }
    return { since: since === null ? null : isoTaipei(since), gaps: gaps.sort((a, b) => a.from.localeCompare(b.from)), gapsKnown: d.recon !== null };
  }

  /** 含今天 60 秒;過去的期間 10 分鐘 */
  const cached = <T>(view: string, r: Range, load: () => Promise<T>) => {
    const live = r.toMs > now() - 3600_000;
    return viaCh(() => d.cache.cached('pa-insight', { view, from: r.from, to: r.to }, live ? 60 : 600, load, { longTtl: !live }));
  };

  async function traffic(q: { from: string; to: string }) {
    const r = range(q);
    const h = reader();
    const t = now();
    const g = trendGrain(r.days);
    const ag = allowDenyGrain(r.days);
    const data = await cached('traffic', r, async () => ({
      trend: await h.heatRows(g, r.fromMs, r.toMs),
      ad: ag === g ? null : await h.heatRows(ag, r.fromMs, r.toMs),
      since: await h.heatEarliest(g),
      flows: await h.insightFlows(r.fromMs, r.toMs, SANKEY_APPS),
      topIp: await h.insightTopSrc(r.fromMs, r.toMs, TOP),
      topApp: await h.insightTopApps(r.fromMs, r.toMs, TOP),
    }));
    const trend = series(r, g, data.trend, data.since, t, (x) => ({ sent: x.sent, recv: x.recv, sessions: x.sessions }), { sent: 0, recv: 0, sessions: 0 });
    const allowDeny = series(r, ag, data.ad ?? data.trend, data.since, t, (x) => ({ allow: x.sessions - x.deny, deny: x.deny }), { allow: 0, deny: 0 });
    return {
      view: 'traffic' as const,
      from: r.from,
      to: r.to,
      bucketSeconds: GRAIN_MS[g] / 1000,
      allowDenyBucketSeconds: GRAIN_MS[ag] / 1000,
      coverage: coverage(r, data.since),
      trend: trend.map((p) => ({ t: p.t, sent: p.v?.sent ?? null, recv: p.v?.recv ?? null, sessions: p.v?.sessions ?? null })),
      sankey: toSankey(data.flows),
      topIp: data.topIp,
      topApp: data.topApp,
      allowDeny: allowDeny.map((p) => ({ t: p.t, allow: p.v?.allow ?? null, deny: p.v?.deny ?? null })),
      generatedAt: new Date(t).toISOString(),
    };
  }

  async function threat(q: { from: string; to: string }) {
    const r = range(q);
    const h = reader();
    const t = now();
    const g = trendGrain(r.days);
    const len = r.toMs - r.fromMs;
    const data = await cached('threat', r, async () => ({
      rows: await h.heatRows(g, r.fromMs, r.toMs),
      prev: await h.heatRows('1d', r.fromMs - len, r.fromMs),
      since: await h.heatEarliest(g),
      countries: await h.threatCountries(r.fromMs, r.toMs),
      internal: await h.threatTopInternalSrc(r.fromMs, r.toMs, TOP),
      names: await h.threatTopNames(r.fromMs, r.toMs, TOP),
    }));
    const since = data.since;
    const timeline = series(r, g, data.rows, since, t, (x) => ({ critical: x.critical, high: x.high, medium: x.medium, low: x.low }), { critical: 0, high: 0, medium: 0, low: 0 });
    // 前一期:資料起點晚於前一期的開始時,比較不完整 → prev 為 null(畫面不顯示增減)
    const prevComplete = since !== null && since <= r.fromMs - len;
    return {
      view: 'threat' as const,
      from: r.from,
      to: r.to,
      bucketSeconds: GRAIN_MS[g] / 1000,
      coverage: coverage(r, since),
      score: { ...sum(data.rows), prev: prevComplete ? sum(data.prev) : null, prevFrom: dayText(r.fromMs - len), prevTo: dayText(r.fromMs - DAY_MS) },
      timeline: timeline.map((p) => ({ t: p.t, critical: p.v?.critical ?? null, high: p.v?.high ?? null, medium: p.v?.medium ?? null, low: p.v?.low ?? null })),
      countries: toCountries(data.countries),
      topInternalSrc: data.internal,
      topServerDst: null,
      topNames: data.names,
      notes: ['內網以 RFC 1918 判斷;伺服器網段尚未設定(偵測設定 V-c),「被攻擊最多的伺服器」暫不提供'],
      generatedAt: new Date(t).toISOString(),
    };
  }

  return { traffic, threat };
}

export type InsightService = ReturnType<typeof createInsightService>;
