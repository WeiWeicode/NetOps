/**
 * 熱力圖 / 儀表板 / 時段明細的假資料產生器(V-b1;VIZ-RULES-DESIGN §8、HANDOFF-GEMINI-VIZ §2)。
 * 本機假 Gateway(mock/viz.ts,MOCK=admin npm run dev)與元件測試共用。
 * 放在 mock/ 而不是 test/:vite.config.ts 一定會載入 mock/gateway.ts → mock/viz.ts → 這裡,而 Docker 建置的 .dockerignore 排除 test/(2026-11-13 部署建置失敗)。只用 Date 與純函式,不 import src/(mock 在 Vite 設定階段載入)。
 *   - 決定性:同樣的參數產生同樣的資料(偽亂數以時間為種子)
 *   - 年視圖 5 年每天、月視圖 31 天每小時、日視圖 1 天每 5 分鐘都能產生(since 之前 v = null,用來看「沒有資料」的樣式)
 *   - 上班時間流量高、夜間低;偶爾有 critical / high;每 17 格一個 partial
 * 格式以 docs/API.md §4.4、§4.5 為準。
 */
const OFFSET = 8 * 3600_000;
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

export const iso = (ms: number): string => {
  const d = new Date(ms + OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
};
export const dayMs = (day: string): number => Date.parse(`${day}T00:00:00+08:00`);
const dayOf = (ms: number) => iso(ms).slice(0, 10);

/** 0–1 的決定性偽亂數 */
function rnd(seed: number): number {
  const x = Math.sin(seed / 1000 + 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export type Granularity = 'year' | 'month' | 'day';
export type Metric = 'threat' | 'traffic' | 'deny';

interface Agg {
  bytes: number;
  sent: number;
  recv: number;
  sessions: number;
  deny: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

/** 一個時間格的彙總(秒數決定規模) */
export function aggAt(t: number, seconds: number): Agg {
  const hour = new Date(t + OFFSET).getUTCHours();
  const dow = new Date(t + OFFSET).getUTCDay();
  const work = dow > 0 && dow < 6 && hour >= 8 && hour < 18 ? 1 : 0.25;
  const scale = seconds / 300;
  const r = rnd(t);
  const sessions = Math.round((800 + 1200 * r) * work * scale);
  const sent = Math.round(sessions * (20_000 + 30_000 * rnd(t + 1)));
  const recv = Math.round(sessions * (60_000 + 90_000 * rnd(t + 2)));
  const threats = (p: number) => (rnd(t + p) > 0.97 ? Math.ceil(rnd(t + p + 1) * 3 * Math.sqrt(scale)) : 0);
  return {
    bytes: sent + recv,
    sent,
    recv,
    sessions,
    deny: Math.round(sessions * 0.04 * rnd(t + 3)),
    critical: threats(5),
    high: threats(7),
    medium: threats(11) * 2,
    low: Math.round(rnd(t + 13) * 5 * scale),
    info: Math.round(rnd(t + 17) * 20 * scale),
  };
}

const BUCKET: Record<Granularity, number> = { year: DAY, month: 3600_000, day: 300_000 };

function rangeOf(g: Granularity, date: string): { from: number; to: number } {
  const d = dayMs(date);
  if (g === 'day') return { from: d, to: d + DAY };
  const [y, m] = date.split('-').map(Number) as [number, number];
  if (g === 'month') return { from: Date.UTC(y, m - 1, 1) - OFFSET, to: Date.UTC(y, m, 1) - OFFSET };
  const dow = new Date(d + OFFSET).getUTCDay();
  const week = d - ((dow + 6) % 7) * DAY;
  return { from: week - 52 * 7 * DAY, to: week + 7 * DAY };
}

const IPS = ['10.10.112.20', '10.10.113.7', '10.10.112.31', '10.10.130.124', '10.10.114.50'];

/** GET /pa/heatmap 的回應;since 省略為 5 年前(資料齊全) */
export function heatmapResponse(q: { granularity: Granularity; metric: Metric; date: string; now: number; since?: number }) {
  const { from, to } = rangeOf(q.granularity, q.date);
  const step = BUCKET[q.granularity];
  const since = q.since ?? q.now - 5 * 365 * DAY;
  const raw: { t: number; a: Agg | null }[] = [];
  for (let t = from; t < to && t <= q.now; t += step) raw.push({ t, a: t >= since ? aggAt(t, step / 1000) : null });
  const val = (a: Agg) => (q.metric === 'traffic' ? a.bytes : q.metric === 'deny' ? a.deny : 10 * a.critical + 5 * a.high + 2 * a.medium + a.low);
  const nz = raw.filter((x) => x.a && val(x.a) > 0).map((x) => val(x.a!)).sort((a, b) => a - b);
  const th = nz.length ? [0.25, 0.5, 0.75].map((p) => nz[Math.floor(p * (nz.length - 1))]!) : [];
  const cells = raw.map(({ t, a }, i) => {
    const v = a ? val(a) : null;
    const level = !a ? 0 : q.metric === 'threat' ? (a.critical ? 4 : a.high ? 3 : a.medium ? 2 : a.low || a.info ? 1 : 0) : v! > 0 ? 1 + th.filter((x) => v! >= x).length : 0;
    const z = a ?? { bytes: 0, sent: 0, recv: 0, sessions: 0, deny: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    return {
      t: iso(t),
      v,
      level,
      partial: !!a && i % 17 === 16,
      tip: {
        bytes: z.bytes,
        sessions: z.sessions,
        deny: z.deny,
        threats: { critical: z.critical, high: z.high, medium: z.medium, low: z.low, info: z.info },
        topIp: a ? { traffic: IPS[i % 5]!, deny: z.deny ? IPS[(i + 1) % 5]! : null, threat: z.critical + z.high + z.medium ? IPS[(i + 2) % 5]! : null } : { traffic: null, deny: null, threat: null },
      },
    };
  });
  return {
    granularity: q.granularity,
    metric: q.metric,
    date: q.date,
    from: iso(from),
    to: iso(to),
    bucketSeconds: step / 1000,
    coverage: { since: iso(since), gaps: [], gapsKnown: true },
    levels: q.metric === 'threat' ? { method: 'severity', thresholds: [] } : { method: 'quantile', thresholds: th },
    cells,
    generatedAt: new Date(q.now).toISOString(),
  };
}

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
/** 假威脅名稱(依嚴重度;欄位同 API.md §4.4 threat 明細的 name) */
const THREAT_NAMES: Record<Severity, string> = {
  critical: 'Apache Log4j Remote Code Execution(91991)',
  high: 'SMB Brute Force(40004)',
  medium: 'HTTP SQL Injection Attempt(30514)',
  low: 'Non-RFC Compliant DNS(30520)',
  info: 'Suspicious TLS Evasion Found(14978)',
};

/** GET /pa/slice 的結果(source 依呼叫端);type=threat 時依 severity 篩選摘要、排行與明細(C8) */
export function sliceResult(q: { start: string; end: string; type?: 'traffic' | 'threat'; severity?: Severity; source?: 'hot' | 'cold' | 'mixed'; rows?: number }) {
  const s = Date.parse(q.start);
  const e = Date.parse(q.end);
  const a = aggAt(s, (e - s) / 1000);
  const n = Math.min(q.rows ?? 100, 40);
  const traffic = (q.type ?? 'traffic') === 'traffic';
  if (!traffic && q.severity) for (const k of SEVERITIES) if (k !== q.severity) a[k] = 0;
  const sevs = !traffic && q.severity ? [q.severity] : SEVERITIES.filter((k) => a[k] > 0);
  const threatRow = (i: number, time: string) => {
    const sev = sevs[i % Math.max(1, sevs.length)] ?? 'info';
    return { time, subtype: 'vulnerability', action: i % 3 ? 'reset-both' : 'alert', src: i % 2 ? '203.0.113.9' : IPS[i % 5]!, dst: '10.10.130.124', dport: 445, app: 'ms-ds-smb', name: THREAT_NAMES[sev], severity: sev, srcCountry: 'China', dstCountry: 'Taiwan' };
  };
  return {
    source: q.source ?? 'hot',
    type: q.type ?? 'traffic',
    start: iso(s),
    end: iso(e),
    filters: !traffic && q.severity ? { severity: q.severity } : {},
    summary: { sessions: traffic ? a.sessions : a.critical + a.high + a.medium + a.low + a.info, bytes: traffic ? a.bytes : 0, sent: traffic ? a.sent : 0, recv: traffic ? a.recv : 0, deny: a.deny, threats: { critical: a.critical, high: a.high, medium: a.medium, low: a.low, info: a.info } },
    top: traffic
      ? {
          src: IPS.map((ip, i) => ({ key: ip, sessions: 500 - i * 80, bytes: (5 - i) * 2e8 })),
          dst: [{ key: '8.8.8.8', sessions: 300, bytes: 1e8 }],
          app: [{ key: 'ssl', sessions: 800, bytes: 9e8 }, { key: 'web-browsing', sessions: 200, bytes: 2e8 }],
          dport: [{ key: '443', sessions: 900, bytes: 1e9 }],
          dstCountry: [{ key: 'United States', sessions: 400, bytes: 6e8 }],
        }
      : {
          name: sevs.map((k) => ({ key: THREAT_NAMES[k], severity: k, count: a[k] })),
          src: [{ key: '203.0.113.9', count: 9 }],
          dst: [{ key: '10.10.130.124', count: 9 }],
          srcCountry: [{ key: 'China', count: 9 }],
        },
    rows: Array.from({ length: traffic || sevs.length ? n : 0 }, (_, i) => {
      const time = iso(e - (i + 1) * Math.max(1000, Math.floor((e - s) / (n + 1))));
      return traffic ? { time, action: i % 9 ? 'allow' : 'deny', src: IPS[i % 5]!, dst: '8.8.8.8', dport: 443, app: 'ssl', bytes: 1000 + i * 37 } : threatRow(i, time);
    }),
    rowsLimit: q.rows ?? 100,
    rowsTruncated: n < (q.rows ?? 100) ? false : true,
    coverage: { partial: false, gaps: [], gapsKnown: true },
    seconds: 0.4,
  };
}

const spanDays = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY) + 1;
const grainMs = (days: number) => (days <= 2 ? 300_000 : days <= 31 ? 3600_000 : DAY);

/** GET /pa/insight/traffic */
export function trafficInsight(r: { from: string; to: string; now: number }) {
  const days = spanDays(r.from, r.to);
  const g = grainMs(days);
  const ag = days <= 2 ? 3600_000 : DAY;
  const from = dayMs(r.from);
  const to = dayMs(r.to) + DAY;
  const pts = (step: number) => {
    const out: number[] = [];
    for (let t = from; t < to && t <= r.now; t += step) out.push(t);
    return out;
  };
  const apps = ['ssl', 'web-browsing', 'ms-office365', 'youtube-streaming', 'dns-base', 'ms-teams', 'rustdesk', 'google-base', 'zoom', 'onedrive'];
  return {
    view: 'traffic',
    from: r.from,
    to: r.to,
    bucketSeconds: g / 1000,
    allowDenyBucketSeconds: ag / 1000,
    coverage: { since: iso(r.now - 5 * 365 * DAY), gaps: [], gapsKnown: true },
    trend: pts(g).map((t) => {
      const a = aggAt(t, g / 1000);
      return { t: iso(t), sent: a.sent, recv: a.recv, sessions: a.sessions };
    }),
    sankey: {
      nodes: [
        { id: 'z:trust', name: 'trust', layer: 0 },
        { id: 'z:dmz', name: 'dmz', layer: 0 },
        ...apps.slice(0, 6).map((a) => ({ id: `a:${a}`, name: a, layer: 1 })),
        { id: 'a:其他', name: '其他', layer: 1 },
        { id: 'd:untrust', name: 'untrust', layer: 2 },
        { id: 'd:dmz', name: 'dmz', layer: 2 },
      ],
      links: [
        ...apps.slice(0, 6).flatMap((a, i) => [
          { source: 'z:trust', target: `a:${a}`, bytes: (6 - i) * 3e9 },
          { source: `a:${a}`, target: i % 3 ? 'd:untrust' : 'd:dmz', bytes: (6 - i) * 3e9 },
        ]),
        { source: 'z:dmz', target: 'a:其他', bytes: 2e9 },
        { source: 'a:其他', target: 'd:untrust', bytes: 2e9 },
      ],
    },
    topIp: IPS.concat(['10.10.115.9', '10.10.116.3', '10.10.117.44', '10.10.118.2', '10.10.119.8']).map((ip, i) => ({ ip, bytes: (10 - i) * 4e9, sent: (10 - i) * 1e9, recv: (10 - i) * 3e9, sessions: (10 - i) * 900 })),
    topApp: apps.map((app, i) => ({ app, bytes: (10 - i) * 5e9, sessions: (10 - i) * 1200 })),
    allowDeny: pts(ag).map((t) => {
      const a = aggAt(t, ag / 1000);
      return { t: iso(t), allow: a.sessions - a.deny, deny: a.deny };
    }),
    generatedAt: new Date(r.now).toISOString(),
  };
}

/** GET /pa/insight/threat */
export function threatInsight(r: { from: string; to: string; now: number }) {
  const days = spanDays(r.from, r.to);
  const g = grainMs(days);
  const from = dayMs(r.from);
  const to = dayMs(r.to) + DAY;
  const timeline: { t: string; critical: number; high: number; medium: number; low: number }[] = [];
  const score = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (let t = from; t < to && t <= r.now; t += g) {
    const a = aggAt(t, g / 1000);
    timeline.push({ t: iso(t), critical: a.critical, high: a.high, medium: a.medium, low: a.low });
    for (const k of Object.keys(score) as (keyof typeof score)[]) score[k] += a[k];
  }
  const countries: [string, string, number][] = [
    ['China', 'CN', 420],
    ['United States', 'US', 310],
    ['Russian Federation', 'RU', 120],
    ['Netherlands', 'NL', 80],
    ['Germany', 'DE', 60],
    ['Singapore', 'SG', 40],
    ['Japan', 'JP', 30],
    ['Hong Kong', 'HK', 22],
    ['Brazil', 'BR', 15],
    ['India', 'IN', 9],
    ['Viet Nam', 'VN', 6],
  ];
  return {
    view: 'threat',
    from: r.from,
    to: r.to,
    bucketSeconds: g / 1000,
    coverage: { since: iso(r.now - 5 * 365 * DAY), gaps: [], gapsKnown: true },
    score: { ...score, prev: { critical: Math.max(0, score.critical - 1), high: score.high + 2, medium: score.medium, low: score.low, info: score.info }, prevFrom: dayOf(from - (to - from)), prevTo: dayOf(from - DAY) },
    timeline,
    countries: [...countries.map(([country, iso2, count]) => ({ country, iso2, count, critical: Math.floor(count / 50), high: Math.floor(count / 10) })), { country: '未知', iso2: null, count: 5, critical: 0, high: 1 }],
    topInternalSrc: IPS.map((ip, i) => ({ ip, count: 50 - i * 8, high: 5 - i })),
    topServerDst: null,
    topNames: [
      { name: 'SMB Brute Force(40004)', severity: 'high', count: 90 },
      { name: 'Microsoft RDP Brute Force(40021)', severity: 'critical', count: 33 },
      { name: 'SIPVicious Scanner(54638)', severity: 'medium', count: 21 },
      { name: 'HTTP OPTIONS Method(30520)', severity: 'info', count: 12 },
    ],
    notes: ['內網以 RFC 1918 判斷;伺服器網段尚未設定(偵測設定 V-c),「被攻擊最多的伺服器」暫不提供'],
    generatedAt: new Date(r.now).toISOString(),
  };
}
