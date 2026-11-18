/**
 * 戰情室(/firewall/live,docs/WARROOM-PLAN.md §2、§3 WR-4)的資料與互動狀態;頁面只用這裡,不直接 fetch。
 *   - 輪詢 WR-1 /pa-live/warroom(5 秒)、WR-2 /pa-live/risk(60 秒);失敗時保留上一份並標示 stale,下一輪自動重試
 *   - 設備 KPI 用 snapshot(先查一次,之後由 SSE snapshot 事件更新);即時 log 用既有 useLiveStream(traffic + threat,斷線重連沿用)
 *   - logs:最多 200 筆;篩選 全部 / 阻擋 / 允許 / 威脅、暫停(凍結畫面,串流照收)、聚焦節點同步篩選
 *   - mock 模式(warroomMockEnabled() 或 options.mock):全部改用 warroomMock 的假資料,不呼叫 API
 * 純函式(classifyLog、filterLogs、buildNodes、sumRates…)另外匯出,方便畫面與測試共用。
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { can } from '@/api/gateway';
import { UI } from '@/api/perms';
import { paLive, type CollectorControl, type LiveLog, type PaLiveSnapshot } from '@/api/paLive';
import { LAN_SOURCE, OTHER_SOURCE, warroom as api, type Warroom, type WarroomLink, type WarroomRisk, type WarroomSegment, type WarroomSource } from '@/api/warroom';
import { MAX_LOGS, useLiveStream } from './paLive';
import { usePolling } from './usePolling';
import { createWarroomMock, resolveMock, warroomMockLoadScale, type WarroomMock } from './warroomMock';

export const WARROOM_POLL_MS = 5_000;
export const RISK_POLL_MS = 60_000;
export const MAX_WARROOM_LOGS = 200;
/** 戰情室 Log 表 / 事件欄最快更新間隔 */
export const LOG_RENDER_MS = 1000;
export const MAX_EVENTS = 30;
/** 超過這麼久沒有成功更新 WR-1,視為資料過期(輪詢 3 輪) */
export const STALE_MS = 15_000;

export type LogKind = 'deny' | 'allow' | 'threat';
export type LogFilterKind = 'all' | LogKind;
export type Tone = 'allow' | 'warn' | 'deny';
export interface Focus {
  side: 'source' | 'segment';
  id: string;
}

/** 同後端 isDenyAction */
const DENY_RE = /^(deny|drop|reset|block|sinkhole)/;

/** log → 阻擋 / 允許 / 威脅(威脅類 log 一律算威脅;TRAFFIC 依 action) */
export function classifyLog(l: LiveLog): LogKind {
  if (l.type !== 'traffic') return 'threat';
  return DENY_RE.test(String(l.action ?? '')) ? 'deny' : 'allow';
}

/** 阻擋比例 → 顏色等級(樣稿:> 60% 紅、> 25% 黃、其餘綠) */
export function denyTone(ratio: number): Tone {
  return ratio > 0.6 ? 'deny' : ratio > 0.25 ? 'warn' : 'allow';
}

const PRIVATE_V4: [number, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
].map(([ip, bits]) => [ipv4ToInt(ip as string)!, bits as number]);

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

/** 內部位址(同後端 pa-live/warroom.ts isPrivateIp):私有 IPv4、CGNAT、loopback、link-local、IPv6 ULA / link-local */
export function isPrivateIp(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n !== null) return PRIVATE_V4.some(([base, bits]) => (bits === 0 ? 0 : (n >>> (32 - bits)) === base >>> (32 - bits)));
  const v6 = ip.toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
}

const isIpLike = (v: unknown): v is string => typeof v === 'string' && (ipv4ToInt(v) !== null || v.includes(':'));

/**
 * log 屬於哪個來源節點(同後端 WR-1 聚合規則):
 *   來源是外部 IP 而且在 Top 攻擊 IP → ip:<src>;兩端都是內部 → lan;外部端國家(SSE 衍生欄位 country)在清單 → cc:<國家>;其餘 → other
 */
export function sourceIdOf(l: LiveLog, sources: readonly WarroomSource[]): string | null {
  const has = (id: string) => sources.some((s) => s.id === id);
  const src = isIpLike(l.src) ? l.src : '';
  const dst = isIpLike(l.dst) ? l.dst : '';
  const srcExt = !!src && !isPrivateIp(src);
  const external = srcExt || (!!dst && !isPrivateIp(dst));
  if (srcExt && has(`ip:${src}`)) return `ip:${src}`;
  if (!external) return has(LAN_SOURCE) ? LAN_SOURCE : null;
  if (typeof l.country === 'string' && has(`cc:${l.country}`)) return `cc:${l.country}`;
  return has(OTHER_SOURCE) ? OTHER_SOURCE : null;
}

/** log 屬於哪個網段(SSE 衍生欄位 segment;對不到為 unmatched) */
export function segmentIdOf(l: LiveLog): string | null {
  return typeof l.segment === 'string' && l.segment ? l.segment : null;
}

export function matchesFocus(l: LiveLog, focus: Focus | null, sources: readonly WarroomSource[]): boolean {
  if (!focus) return true;
  return focus.side === 'segment' ? segmentIdOf(l) === focus.id : sourceIdOf(l, sources) === focus.id;
}

/** 底部 TRAFFIC LOG:篩選 + 聚焦,新到舊,最多 max 筆 */
export function filterLogs(logs: readonly LiveLog[], kind: LogFilterKind, focus: Focus | null, sources: readonly WarroomSource[], max = MAX_WARROOM_LOGS): LiveLog[] {
  const out: LiveLog[] = [];
  for (const l of logs) {
    if (kind !== 'all' && classifyLog(l) !== kind) continue;
    if (!matchesFocus(l, focus, sources)) continue;
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

export interface Rates {
  conn: number;
  allow: number;
  deny: number;
  threat: number;
}

/** 連線的每秒速率加總(可只算某個節點) */
export function sumRates(links: readonly WarroomLink[], pick: (l: WarroomLink) => boolean = () => true): Rates {
  const r: Rates = { conn: 0, allow: 0, deny: 0, threat: 0 };
  for (const l of links) {
    if (!pick(l)) continue;
    r.conn += l.conn;
    r.allow += l.allow;
    r.deny += l.deny;
    r.threat += l.threat;
  }
  return r;
}

/** 每秒 → 每分 / 每 N 分(KPI 與說明文字用) */
export function perMinutes(perSec: number, minutes = 1): number {
  return perSec * 60 * minutes;
}

/**
 * 粒子產生速率(每秒幾顆):依連線每秒速率等比例,單條上限 maxPerLink,全部合計不超過 budget(計畫 §4 建議 ≤ 1500 顆在畫面上)。
 * scale = 每 1 conn/s 產生幾顆。
 */
export function particleRate(link: WarroomLink, totalConn: number, opts: { scale?: number; maxPerLink?: number; budget?: number } = {}): number {
  const { scale = 1, maxPerLink = 30, budget = 120 } = opts;
  const raw = link.conn * scale;
  const capped = totalConn * scale > budget && totalConn > 0 ? (link.conn / totalConn) * budget : raw;
  return Math.min(maxPerLink, capped);
}

// ---------- 進出方向(WD-2,docs/WARROOM-DIRECTION-POLICY-PLAN.md §2) ----------

/**
 * 方向篩選:all 全部 / in 連入 / out 連出。
 * 「連入」= 總數 − 連出(計畫 §2.2),所以內部互連與外部對外部的轉送歸在連入這一邊(粒子同樣左 → 右)。
 */
export type Direction = 'all' | 'in' | 'out';
export const DIRECTIONS: readonly Direction[] = ['all', 'in', 'out'];
/** 偏好設定(只存方向,不存資料;AGENT.md §7.1 偏好可存 localStorage) */
export const DIRECTION_STORAGE_KEY = 'wr-direction';

export function readDirection(): Direction {
  try {
    const v = localStorage.getItem(DIRECTION_STORAGE_KEY);
    return (DIRECTIONS as readonly string[]).includes(v ?? '') ? (v as Direction) : 'all';
  } catch {
    return 'all';
  }
}

/** 粒子的方向與顏色機率:out = 連出的機率;其餘為「該方向內」的阻擋 / 威脅機率 */
export interface DirectionProbs {
  out: number;
  inDeny: number;
  outDeny: number;
  inThreat: number;
  outThreat: number;
}

/** 連出部分夾在 0 ~ 總數之間(欄位缺少 = 舊版後端 → 全部連入) */
const outPart = (v: number | undefined, total: number) => Math.min(Math.max(0, v ?? 0), Math.max(0, total));
const frac = (a: number, b: number) => (b > 0 ? Math.min(1, Math.max(0, a / b)) : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function linkDirectionProbs(l: WarroomLink): DirectionProbs {
  const outConn = outPart(l.outConn, l.conn);
  const outDeny = outPart(l.outDeny, l.deny);
  const outThreat = outPart(l.outThreat, l.threat);
  const inConn = l.conn - outConn;
  return {
    out: frac(outConn, l.conn),
    inDeny: frac(l.deny - outDeny, inConn),
    outDeny: frac(outDeny, outConn),
    inThreat: frac(l.threat - outThreat, inConn),
    outThreat: frac(outThreat, outConn),
  };
}

/** 只留某個方向的速率(all 原樣);out* 跟著改成該方向的值,粒子方向機率因此是 0 或 1 */
export function linkOfDirection(l: WarroomLink, dir: Direction): WarroomLink {
  if (dir === 'all') return l;
  const outConn = outPart(l.outConn, l.conn);
  const outDeny = outPart(l.outDeny, l.deny);
  const outThreat = outPart(l.outThreat, l.threat);
  if (dir === 'out') return { ...l, conn: outConn, deny: outDeny, allow: r3(Math.max(0, outConn - outDeny)), threat: outThreat, outConn, outDeny, outThreat };
  const conn = r3(l.conn - outConn);
  const deny = r3(l.deny - outDeny);
  return { ...l, conn, deny, allow: r3(Math.max(0, conn - deny)), threat: r3(l.threat - outThreat), outConn: 0, outDeny: 0, outThreat: 0 };
}

/**
 * 依方向篩選整份 WR-1(不重新呼叫 API):
 *   - links:只留該方向的速率,兩者皆 0 的連線拿掉
 *   - 節點 conn:in = conn − outConn、out = outConn;deny / threat 依該節點連線速率的方向比例換算、bytes 依 conn 比例換算
 *     (後端只給節點的 outConn,這三個是推估)
 *   - 節點排序:國家依該方向的 conn + threat 重排(攻擊 IP、其他、內部互連維持原位置);網段維持設定檔順序
 * 節點不刪除(版面位置穩定),該方向沒有流量的節點由 buildNodes 標 dimmed。
 */
export function directionView(w: Warroom | null, dir: Direction): Warroom | null {
  if (!w || dir === 'all') return w;
  const links = w.links.map((l) => linkOfDirection(l, dir)).filter((l) => l.conn > 0 || l.threat > 0);
  const pick = <T extends WarroomSource | WarroomSegment>(n: T, match: (l: WarroomLink) => boolean): T => {
    const outConn = outPart(n.outConn, n.conn);
    const conn = dir === 'out' ? outConn : n.conn - outConn;
    const all = sumRates(w.links, match);
    const d = sumRates(links, match);
    const next = { ...n, conn, threat: Math.round(n.threat * frac(d.threat, all.threat)), outConn: dir === 'out' ? conn : 0 };
    if ('deny' in n) (next as WarroomSource).deny = Math.min(conn, Math.round(n.deny * frac(d.deny, all.deny)));
    if ('bytes' in n) (next as WarroomSegment).bytes = Math.round(n.bytes * frac(conn, n.conn));
    return next;
  };
  const sources = w.sources.map((s) => pick(s, (l) => l.source === s.id));
  // 國家依該方向重排,放回原本國家所在的位置
  const slots = sources.flatMap((s, i) => (s.kind === 'country' ? [i] : []));
  const countries = slots.map((i) => sources[i]!).sort((a, b) => b.conn + b.threat - (a.conn + a.threat) || a.id.localeCompare(b.id));
  slots.forEach((i, k) => (sources[i] = countries[k]!));
  return { ...w, sources, segments: w.segments.map((g) => pick(g, (l) => l.segment === g.id)), links };
}

export interface SourceNode extends WarroomSource {
  denyRatio: number;
  tone: Tone;
  /** 0~1,依 conn 相對最大值(畫面決定實際半徑) */
  size: number;
  rates: Rates;
  /** 期間內連入 / 連出筆數(節點下方「入 x / 出 y」;攻擊 IP 只有連入) */
  inConn: number;
  outConn: number;
  /** 方向篩選後這個節點沒有流量(畫面淡化,例如選「連出」時的攻擊 IP) */
  dimmed: boolean;
}
export interface SegmentNode extends WarroomSegment {
  size: number;
  rates: Rates;
  inConn: number;
  outConn: number;
  dimmed: boolean;
}
export interface LinkView extends WarroomLink {
  denyRatio: number;
  tone: Tone;
  /** 聚焦時與焦點無關 → true(畫面淡出) */
  dimmed: boolean;
}

/** dir:資料經 directionView 篩選時的方向(只影響 dimmed) */
export function buildNodes(w: Warroom | null, focus: Focus | null, dir: Direction = 'all'): { sources: SourceNode[]; segments: SegmentNode[]; links: LinkView[] } {
  if (!w) return { sources: [], segments: [], links: [] };
  const io = (n: { conn: number; threat: number; outConn?: number }) => {
    const outConn = outPart(n.outConn, n.conn);
    return { inConn: n.conn - outConn, outConn, dimmed: dir !== 'all' && n.conn + n.threat <= 0 };
  };
  const maxS = Math.max(1, ...w.sources.map((s) => s.conn));
  const maxG = Math.max(1, ...w.segments.map((s) => s.conn));
  const ratio = (deny: number, conn: number) => (conn > 0 ? deny / conn : 0);
  return {
    sources: w.sources.map((s) => ({ ...s, denyRatio: ratio(s.deny, s.conn), tone: denyTone(ratio(s.deny, s.conn)), size: s.conn / maxS, rates: sumRates(w.links, (l) => l.source === s.id), ...io(s) })),
    segments: w.segments.map((g) => ({ ...g, size: g.conn / maxG, rates: sumRates(w.links, (l) => l.segment === g.id), ...io(g) })),
    links: w.links.map((l) => ({
      ...l,
      denyRatio: ratio(l.deny, l.conn),
      tone: denyTone(ratio(l.deny, l.conn)),
      dimmed: !!focus && (focus.side === 'source' ? l.source !== focus.id : l.segment !== focus.id),
    })),
  };
}

export const DEFAULT_GAUGE = { throughputMaxBps: 1e9, sessionMax: 64_000 };

export interface WarroomNotice {
  key: 'segments-example' | 'segments-invalid' | 'estimated' | 'risk-estimated' | 'partial' | 'risk-partial' | 'geo-unavailable';
  tone: 'info' | 'warning' | 'danger';
  text: string;
}

/** WR-1 / WR-2 的狀態 → 畫面提示(AGENT §5:不完整要明確標示) */
export function warroomNotices(w: Warroom | null, r: WarroomRisk | null): WarroomNotice[] {
  const out: WarroomNotice[] = [];
  if (w?.partial) out.push({ key: 'partial', tone: 'danger', text: w.message || '即時資料庫無法連線,戰情室資料不完整' });
  if (r?.partial) out.push({ key: 'risk-partial', tone: 'danger', text: r.message || '高風險統計暫時無法取得' });
  if (w?.segmentsSource === 'example') out.push({ key: 'segments-example', tone: 'info', text: '目前顯示範例網段(網通網段清單尚未設定)' });
  if (w?.segmentsSource === 'invalid') out.push({ key: 'segments-invalid', tone: 'warning', text: '網段設定檔格式錯誤,暫時改用範例網段' });
  if (w && !w.partial && w.geo && !w.geo.available) out.push({ key: 'geo-unavailable', tone: 'warning', text: 'GeoIP 資料庫無法使用,國家歸入「其他」' });
  if (w?.sample && !w.sample.complete) out.push({ key: 'estimated', tone: 'warning', text: `流量較大,只讀到最近 ${w.sample.trafficSec} 秒的 log,數字為推估` });
  if (r?.sample && !r.sample.complete) out.push({ key: 'risk-estimated', tone: 'warning', text: '高風險統計的嚴重度與阻擋比例依部分樣本推估' });
  return out;
}

export interface UseWarroomOptions {
  /** 強制開關 mock;沒給時依 warroomMockEnabled() */
  mock?: boolean;
  /** mock 用的亂數(測試給固定種子) */
  rand?: () => number;
  /** 權限判斷(測試注入);預設 gateway can() */
  can?: (code: string) => boolean;
}

export function useWarroom(options: UseWarroomOptions = {}) {
  const mock = resolveMock(options.mock);
  const data = shallowRef<Warroom | null>(null);
  const risk = shallowRef<WarroomRisk | null>(null);
  const snapshot = shallowRef<PaLiveSnapshot | null>(null);
  const warroomError = ref<Error | null>(null);
  const riskError = ref<Error | null>(null);
  const lastOkAt = ref<number | null>(null);
  const now = ref(Date.now());

  const filter = ref<LogFilterKind>('all');
  const focus = ref<Focus | null>(null);
  /** 進出方向篩選(WD-2):只影響畫面(粒子、節點數字與排序),不重新呼叫 API;記在 localStorage */
  const direction = ref<Direction>(readDirection());
  watch(direction, (d) => {
    try {
      localStorage.setItem(DIRECTION_STORAGE_KEY, d);
    } catch {
      /* 無法寫入時只影響重整後的記憶 */
    }
  });
  const paused = ref(false);
  /** 暫停當下的畫面 log(串流照收,恢復後顯示最新) */
  const frozen = shallowRef<LiveLog[] | null>(null);

  let mockSrc: WarroomMock | null = null;
  const mockLogs = shallowRef<LiveLog[]>([]);
  const timers: ReturnType<typeof setInterval>[] = [];
  const stream = mock ? null : useLiveStream((s) => (snapshot.value = s));

  const allLogs = computed<LiveLog[]>(() => (mock ? mockLogs.value : (stream?.logs.value ?? [])));

  const wPoll = usePolling(
    () => api.get(5),
    (r) => {
      if (r instanceof Error) warroomError.value = r;
      else {
        data.value = r;
        warroomError.value = null;
        lastOkAt.value = Date.now();
      }
      return true;
    },
    WARROOM_POLL_MS,
  );
  const rPoll = usePolling(
    () => api.risk(60),
    (r) => {
      if (r instanceof Error) riskError.value = r;
      else {
        risk.value = r;
        riskError.value = null;
      }
      return true;
    },
    RISK_POLL_MS,
  );

  function start() {
    if (mock) {
      const loadScale = warroomMockLoadScale();
      mockSrc = createWarroomMock(options.rand, { loadScale });
      const pushLog = () => (mockLogs.value = [mockSrc!.log(), ...mockLogs.value].slice(0, MAX_LOGS));
      const refresh = () => {
        mockSrc!.tick();
        data.value = mockSrc!.warroom();
        snapshot.value = mockSrc!.snapshot();
        lastOkAt.value = Date.now();
      };
      refresh();
      risk.value = mockSrc.risk();
      for (let i = 0; i < 20; i++) pushLog();
      flushLogs();
      timers.push(setInterval(refresh, 1000), setInterval(pushLog, loadScale > 1 ? 100 : 700), setInterval(() => (risk.value = mockSrc!.risk()), RISK_POLL_MS));
    } else {
      void wPoll.run();
      void rPoll.run();
      void paLive.snapshot().then(
        (s) => (snapshot.value ??= s),
        () => undefined,
      );
      stream!.connect(['traffic', 'threat'], {});
      // 進頁先補最近的 log(威脅也要,篩選「威脅」與事件欄才不會是空的);preload 依時間由新到舊合併
      void Promise.allSettled([paLive.logs('traffic', {}, 100), paLive.logs('threat', {}, 50)]).then((rs) => {
        const items = rs.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []));
        stream!.preload(items.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)));
        flushLogs();
      });
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    }
    timers.push(setInterval(() => (now.value = Date.now()), 1000));
  }

  /** 分頁切回前景:立即更新(背景時輪詢放慢 5 倍) */
  function onVisible() {
    if (document.hidden) return;
    void wPoll.run();
    void rPoll.run();
  }

  function stop() {
    if (!mock && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    timers.splice(0).forEach(clearInterval);
    wPoll.stop();
    rPoll.stop();
    stream?.close();
  }

  /**
   * 畫面用的 log:最多每 LOG_RENDER_MS 更新一次(串流照收)。真實流量每秒上百筆,
   * 逐筆重繪 200 列表格會讓戰情室掉到 40 fps(2026-11-17 量測:暫停 Log 表後 95 fps、0 次卡頓)。
   */
  const shownLogs = shallowRef<LiveLog[]>(allLogs.value);
  let lastShow = 0;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  watch(allLogs, (v) => {
    const wait = LOG_RENDER_MS - (Date.now() - lastShow);
    if (wait <= 0) {
      lastShow = Date.now();
      shownLogs.value = v;
    } else if (!showTimer) {
      showTimer = setTimeout(() => {
        showTimer = null;
        lastShow = Date.now();
        shownLogs.value = allLogs.value;
      }, wait);
    }
  });
  if (getCurrentScope()) onScopeDispose(() => showTimer && clearTimeout(showTimer));
  /** 進頁預載後立即顯示(不等節流) */
  function flushLogs() {
    lastShow = Date.now();
    shownLogs.value = allLogs.value;
  }

  watch(paused, (p) => (frozen.value = p ? allLogs.value : null));

  const view = computed(() => buildNodes(directionView(data.value, direction.value), focus.value, direction.value));
  const sources = computed(() => data.value?.sources ?? []);
  const logs = computed(() => filterLogs(frozen.value ?? shownLogs.value, filter.value, focus.value, sources.value));
  /** 右欄即時事件:不受篩選、暫停影響 */
  const events = computed(() => shownLogs.value.slice(0, MAX_EVENTS).map((l) => ({ log: l, kind: classifyLog(l) })));
  const rates = computed(() => sumRates(data.value?.links ?? []));
  /** 背景分頁輪詢放慢,不判過期(切回前景會立即更新) */
  const stale = computed(() => {
    if (typeof document !== 'undefined' && document.hidden && lastOkAt.value !== null) return false;
    return lastOkAt.value === null || now.value - lastOkAt.value > STALE_MS;
  });
  /** 資料不完整:WR-1 / WR-2 partial、串流部分類型讀不到 */
  const partial = computed(() => !!data.value?.partial || !!risk.value?.partial || !!stream?.degraded.value);
  /** 畫面提示:範例網段、網段設定錯誤、樣本不完整(推估)、partial 說明 */
  const notices = computed(() => warroomNotices(data.value, risk.value));
  /** 儀表滿格值(後端設定;還沒載入時用預設 1 Gbps / 64K) */
  const gauge = computed(() => data.value?.gauge ?? DEFAULT_GAUGE);
  /** GeoIP 授權標示(畫面必須顯示並連結);GeoIP 不可用時 null */
  /** DB-IP 授權標示(CC BY 4.0 必須顯示);連結只接受 https://db-ip.com,其他改用官方網址 */
  const geoAttribution = computed(() => {
    const a = data.value?.geo?.available ? data.value.geo.attribution : null;
    if (!a) return null;
    return { text: a.text || 'IP Geolocation by DB-IP', url: /^https:\/\/(www\.)?db-ip\.com(\/|$)/i.test(a.url) ? a.url : 'https://db-ip.com' };
  });
  const connected = computed(() => (mock ? true : (stream?.connected.value ?? false)));
  const streamError = computed(() => stream?.streamError.value ?? '');

  function toggleFocus(f: Focus | null) {
    focus.value = f && focus.value && f.side === focus.value.side && f.id === focus.value.id ? null : f;
  }

  /** 系統狀態抽屜:測試區暫停 / 繼續收集器(netops.pa-realtime.write;正式區 403) */
  async function setControl(change: { pollPaused?: boolean; receivePaused?: boolean }): Promise<CollectorControl> {
    if (mock) {
      const s = snapshot.value!;
      const c = { ...s.control!, ...change, updatedAt: new Date().toISOString(), updatedBy: 'mock' };
      snapshot.value = { ...s, control: c };
      return c;
    }
    const c = await paLive.setControl(change);
    if (snapshot.value) snapshot.value = { ...snapshot.value, control: c };
    void paLive.snapshot().then(
      (s) => (snapshot.value = s),
      () => undefined,
    );
    return c;
  }

  start();
  if (getCurrentScope()) onScopeDispose(stop);

  return {
    mock,
    data,
    risk,
    snapshot,
    warroomError,
    riskError,
    stale,
    partial,
    notices,
    gauge,
    geoAttribution,
    connected,
    streamError,
    nodes: computed(() => ({ sources: view.value.sources, segments: view.value.segments })),
    links: computed(() => view.value.links),
    rates,
    kpis: computed(() => data.value?.kpis ?? null),
    events,
    logs,
    filter,
    focus,
    direction,
    paused,
    toggleFocus,
    setControl,
    /** 測試區暫停 / 繼續開關的權限(netops.pa-live.manage);畫面不自行判斷 */
    canManage: computed(() => (options.can ?? can)(UI.paLiveManage)),
    stop,
  };
}
