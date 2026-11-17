/**
 * 戰情室 mock 資料(仿樣稿 docs/mockups/warroom-v5.html 的隨機資料),讓畫面在後端 WR-1~WR-3 完成前就能開發。
 * 只由 useWarroom / useWarroomAi 在 mock 模式使用;是否開啟見 warroomMockEnabled()(正式建置一律關閉)。
 */
import type { LiveLog } from '@/api/paLive';
import type { HourlyInsight, Warroom, WarroomRisk, WarroomSegment, WarroomSource } from '@/api/warroom';
import type { PaLiveSnapshot } from '@/api/paLive';

/**
 * mock 模式開關:只在開發建置(vite dev / 測試)有效,正式建置(import.meta.env.PROD)一律 false。
 *   - 網址加 `?mock=1`(例:http://localhost:5173/netops/firewall/live?mock=1)
 *   - 或 `.env.development.local` 設 `VITE_WARROOM_MOCK=1`
 */
export function warroomMockEnabled(
  env: { PROD?: boolean; VITE_WARROOM_MOCK?: string } = import.meta.env,
  search: string = typeof location !== 'undefined' ? location.search : '',
): boolean {
  if (env.PROD) return false;
  return env.VITE_WARROOM_MOCK === '1' || new URLSearchParams(search).get('mock') === '1';
}

/** composable 用:正式建置一律 false(即使呼叫端傳 mock: true) */
export function resolveMock(opt: boolean | undefined, env: { PROD?: boolean; VITE_WARROOM_MOCK?: string } = import.meta.env): boolean {
  if (env.PROD) return false;
  return opt ?? warroomMockEnabled(env);
}

/** 可重現的亂數(測試用固定種子) */
export function seededRandom(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

interface MockSrc {
  id: string;
  kind: WarroomSource['kind'];
  label: string;
  /** 每秒連線(基準) */
  v: number;
  /** 阻擋比例 */
  d: number;
  ipPrefix: string;
}

const SOURCES: MockSrc[] = [
  { id: 'TW', kind: 'country', label: '台灣', v: 9, d: 0.02, ipPrefix: '114.32' },
  { id: 'US', kind: 'country', label: '美國', v: 5.2, d: 0.06, ipPrefix: '52.14' },
  { id: 'JP', kind: 'country', label: '日本', v: 3, d: 0.03, ipPrefix: '126.77' },
  { id: 'CN', kind: 'country', label: '中國', v: 2.6, d: 0.55, ipPrefix: '223.104' },
  { id: 'RU', kind: 'country', label: '俄羅斯', v: 1.4, d: 0.8, ipPrefix: '91.240' },
  { id: 'NL', kind: 'country', label: '荷蘭', v: 1.1, d: 0.35, ipPrefix: '89.248' },
  { id: '45.155.205.12', kind: 'ip', label: '45.155.205.12', v: 0.9, d: 0.97, ipPrefix: '' },
  { id: '185.220.101.7', kind: 'ip', label: '185.220.101.7', v: 0.7, d: 0.95, ipPrefix: '' },
  { id: 'other', kind: 'other', label: '其他', v: 1.8, d: 0.2, ipPrefix: '102.88' },
];

const SEGMENTS: (Omit<WarroomSegment, 'conn' | 'bytes' | 'threat'> & { w: number; net: string })[] = [
  { id: 'vlan10', kind: 'vlan', label: 'VLAN 10 辦公', icon: 'pc', w: 7, net: '10.10.10' },
  { id: 'vlan20', kind: 'vlan', label: 'VLAN 20 廠務', icon: 'factory', w: 3.8, net: '10.10.20' },
  { id: 'vlan30', kind: 'vlan', label: 'VLAN 30 MES', icon: 'gear', w: 2.6, net: '10.10.30' },
  { id: 'dmz-web', kind: 'service', label: 'DMZ Web', icon: 'server', w: 5.2, net: '10.10.200' },
  { id: 'mail', kind: 'service', label: 'Mail', icon: 'mail', w: 2.4, net: '10.10.201' },
  { id: 'ad-dns', kind: 'service', label: 'AD / DNS', icon: 'key', w: 2, net: '10.10.1' },
  { id: 'vpn', kind: 'service', label: 'VPN (GP)', icon: 'lock', w: 1.5, net: '10.10.250' },
  { id: 'guest', kind: 'vlan', label: 'Guest WiFi', icon: 'wifi', w: 1.2, net: '172.16.8' },
];

const APPS: [string, number][] = [
  ['ssl', 443],
  ['web-browsing', 80],
  ['smtp', 25],
  ['dns', 53],
  ['ssh', 22],
  ['rdp', 3389],
  ['ms-ds-smb', 445],
  ['ping', 0],
  ['globalprotect', 443],
];
const THREATS = ['SSH Brute Force', 'SMB Exploit Attempt', 'Suspicious DNS Query', 'HTTP SQL Injection', 'RDP Scan'];

export function createWarroomMock(rand: () => number = Math.random) {
  const load = SOURCES.map((s) => s.v);
  let seq = 0;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
  const segTotal = SEGMENTS.reduce((n, s) => n + s.w, 0);

  /** 每次呼叫讓流量隨機漂移(樣稿每秒 ±7.5%) */
  function tick() {
    load.forEach((v, i) => (load[i] = Math.max(0.3, v * (1 + (rand() - 0.5) * 0.15))));
  }

  function warroom(): Warroom {
    const links = SOURCES.flatMap((s, i) =>
      SEGMENTS.map((g) => {
        const conn = (load[i]! * g.w) / segTotal;
        const deny = conn * s.d;
        const threat = (conn - deny) * 0.03;
        return { source: s.id, segment: g.id, conn, deny, threat, allow: conn - deny - threat };
      }),
    );
    const sum = (f: (l: (typeof links)[number]) => boolean, k: 'conn' | 'deny' | 'threat') => links.filter(f).reduce((n, l) => n + l[k], 0) * 300;
    return {
      generatedAt: new Date().toISOString(),
      minutes: 5,
      partial: false,
      sources: SOURCES.map((s) => ({
        id: s.id,
        kind: s.kind,
        label: s.label,
        conn: Math.round(sum((l) => l.source === s.id, 'conn')),
        deny: Math.round(sum((l) => l.source === s.id, 'deny')),
        threat: Math.round(sum((l) => l.source === s.id, 'threat')),
        topDst: SEGMENTS.slice(0, 2).map((g) => g.label),
        topApp: ['ssl', 'web-browsing'],
      })),
      segments: SEGMENTS.map((g) => ({
        id: g.id,
        kind: g.kind,
        label: g.label,
        icon: g.icon,
        conn: Math.round(sum((l) => l.segment === g.id, 'conn')),
        bytes: Math.round(sum((l) => l.segment === g.id, 'conn') * 12_000),
        threat: Math.round(sum((l) => l.segment === g.id, 'threat')),
      })),
      links,
      kpis: { denyPerMin: Math.round(links.reduce((n, l) => n + l.deny, 0) * 60), threat5m: Math.round(links.reduce((n, l) => n + l.threat, 0) * 300) },
    };
  }

  function risk(): WarroomRisk {
    return {
      threats: 120 + Math.floor(rand() * 40),
      denies: 4200 + Math.floor(rand() * 800),
      attackSources: 30 + Math.floor(rand() * 10),
      critical: 2 + Math.floor(rand() * 4),
      topThreats: THREATS.map((name, i) => ({ name, severity: i < 2 ? 'critical' : i < 4 ? 'high' : 'medium', count: 14 - i * 3 + Math.floor(rand() * 3) })),
      topSources: SOURCES.filter((s) => s.d > 0.3).map((s) => ({ key: s.id, label: s.label, count: Math.round(s.v * 3600 * s.d), denyRatio: s.d })),
      partial: false,
    };
  }

  function snapshot(): PaLiveSnapshot {
    const now = new Date().toISOString();
    const r = (a: number, b: number) => a + rand() * (b - a);
    return {
      collector: {
        state: 'ok',
        message: 'mock',
        updatedAt: now,
        version: 'mock',
        poll: { enabled: true, paused: false, lastOkAt: now, error: null, errorAt: null },
        receive: { enabled: true, paused: false, tls: true, httpLastAt: now, syslogLastAt: now },
        redis: { error: null, errorAt: null },
        counters: { received: 0, dropped: 0, rejected: 0, malformed: 0, redisFailed: 0, paused: 0 },
      },
      metrics: {
        session: { time: now, active: Math.round(r(41000, 46000)), max: 64000, utilization: r(60, 72), tcp: null, udp: null, icmp: null },
        cpu: { time: now, mgmt: r(10, 30), dataplane: r(20, 95), memUsed: null, memTotal: null },
        throughput: { time: now, bps: r(380e6, 620e6), pps: null, cps: Math.round(r(900, 1400)) },
        interfaces: null,
      },
      control: { available: true, pollPaused: false, receivePaused: false, updatedAt: null, updatedBy: null },
    };
  }

  /** 一筆 TRAFFIC 或威脅 log(含 WR-1 的衍生欄位 country、segment) */
  function log(): LiveLog {
    let si = 0;
    let x = rand() * load.reduce((n, v) => n + v, 0);
    while (si < SOURCES.length - 1 && (x -= load[si]!) > 0) si++;
    const s = SOURCES[si]!;
    const g = pick(SEGMENTS);
    const [app, dport] = pick(APPS);
    const deny = rand() < s.d;
    const threat = !deny && rand() < 0.1;
    const src = s.kind === 'ip' ? s.id : `${s.ipPrefix}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}`;
    const base = {
      id: `mock-${++seq}`,
      receivedAt: new Date().toISOString(),
      src,
      dst: `${g.net}.${1 + Math.floor(rand() * 254)}`,
      dport,
      app,
      country: s.kind === 'country' ? s.id : null,
      segment: g.id,
    };
    if (threat) return { ...base, type: 'threat', action: 'alert', severity: pick(['critical', 'high', 'medium']), name: pick(THREATS), rule: 'av-vp-default' };
    return {
      ...base,
      type: 'traffic',
      action: deny ? 'deny' : 'allow',
      rule: deny ? 'block-geo' : g.kind === 'service' ? 'allow-dmz' : 'allow-lan',
      bytes: deny ? 0 : Math.floor(rand() * 90_000),
      sessionid: Math.floor(rand() * 9e5),
    };
  }

  function insight(trigger: HourlyInsight['trigger'] = 'auto'): HourlyInsight {
    const hour = new Date();
    hour.setMinutes(0, 0, 0);
    return {
      hour: hour.toISOString(),
      text: '近一小時阻擋以俄羅斯、中國來源為主,45.155.205.12 對 DMZ Web 持續掃描(阻擋 97%);SSH 暴力破解命中 14 次,集中在 VLAN 30 MES。建議確認 MES 主機是否開放 SSH 對外。(mock 資料)',
      model: 'mock',
      trigger,
      partial: false,
      status: 'done',
      createdAt: new Date().toISOString(),
    };
  }

  return { tick, warroom, risk, snapshot, log, insight };
}
export type WarroomMock = ReturnType<typeof createWarroomMock>;
