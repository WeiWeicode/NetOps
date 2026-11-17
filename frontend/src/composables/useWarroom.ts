/**
 * 戰情室(/firewall/live,docs/WARROOM-PLAN.md §2、§3 WR-4)的資料與互動狀態;頁面只用這裡,不直接 fetch。
 *   - 輪詢 WR-1 /pa-live/warroom(5 秒)、WR-2 /pa-live/risk(60 秒);失敗時保留上一份並標示 stale,下一輪自動重試
 *   - 設備 KPI 用 snapshot(先查一次,之後由 SSE snapshot 事件更新);即時 log 用既有 useLiveStream(traffic + threat,斷線重連沿用)
 *   - logs:最多 200 筆;篩選 全部 / 阻擋 / 允許 / 威脅、暫停(凍結畫面,串流照收)、聚焦節點同步篩選
 *   - mock 模式(warroomMockEnabled() 或 options.mock):全部改用 warroomMock 的假資料,不呼叫 API
 * 純函式(classifyLog、filterLogs、buildNodes、sumRates…)另外匯出,方便畫面與測試共用。
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { paLive, type CollectorControl, type LiveLog, type PaLiveSnapshot } from '@/api/paLive';
import { warroom as api, type Warroom, type WarroomLink, type WarroomRisk, type WarroomSegment, type WarroomSource } from '@/api/warroom';
import { MAX_LOGS, useLiveStream } from './paLive';
import { usePolling } from './usePolling';
import { createWarroomMock, resolveMock, type WarroomMock } from './warroomMock';

export const WARROOM_POLL_MS = 5_000;
export const RISK_POLL_MS = 60_000;
export const MAX_WARROOM_LOGS = 200;
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

const DENY_RE = /deny|drop|reset|block/i;

/** log → 阻擋 / 允許 / 威脅(威脅類 log 一律算威脅;TRAFFIC 依 action) */
export function classifyLog(l: LiveLog): LogKind {
  if (l.type !== 'traffic') return 'threat';
  return DENY_RE.test(String(l.action ?? '')) ? 'deny' : 'allow';
}

/** 阻擋比例 → 顏色等級(樣稿:> 60% 紅、> 25% 黃、其餘綠) */
export function denyTone(ratio: number): Tone {
  return ratio > 0.6 ? 'deny' : ratio > 0.25 ? 'warn' : 'allow';
}

/** log 屬於哪個來源節點:先比對攻擊 IP,再比對國家(WR-1 SSE 衍生欄位 country),都不中歸「其他」 */
export function sourceIdOf(l: LiveLog, sources: readonly WarroomSource[]): string | null {
  const ip = sources.find((s) => s.kind === 'ip' && s.id === l.src);
  if (ip) return ip.id;
  const c = typeof l.country === 'string' ? sources.find((s) => s.kind === 'country' && s.id === l.country) : undefined;
  if (c) return c.id;
  return sources.find((s) => s.kind === 'other')?.id ?? null;
}

/** log 屬於哪個網段(WR-1 SSE 衍生欄位 segment) */
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

export interface SourceNode extends WarroomSource {
  denyRatio: number;
  tone: Tone;
  /** 0~1,依 conn 相對最大值(畫面決定實際半徑) */
  size: number;
  rates: Rates;
}
export interface SegmentNode extends WarroomSegment {
  size: number;
  rates: Rates;
}
export interface LinkView extends WarroomLink {
  denyRatio: number;
  tone: Tone;
  /** 聚焦時與焦點無關 → true(畫面淡出) */
  dimmed: boolean;
}

export function buildNodes(w: Warroom | null, focus: Focus | null): { sources: SourceNode[]; segments: SegmentNode[]; links: LinkView[] } {
  if (!w) return { sources: [], segments: [], links: [] };
  const maxS = Math.max(1, ...w.sources.map((s) => s.conn));
  const maxG = Math.max(1, ...w.segments.map((s) => s.conn));
  const ratio = (deny: number, conn: number) => (conn > 0 ? deny / conn : 0);
  return {
    sources: w.sources.map((s) => ({ ...s, denyRatio: ratio(s.deny, s.conn), tone: denyTone(ratio(s.deny, s.conn)), size: s.conn / maxS, rates: sumRates(w.links, (l) => l.source === s.id) })),
    segments: w.segments.map((g) => ({ ...g, size: g.conn / maxG, rates: sumRates(w.links, (l) => l.segment === g.id) })),
    links: w.links.map((l) => ({
      ...l,
      denyRatio: ratio(l.deny, l.conn),
      tone: denyTone(ratio(l.deny, l.conn)),
      dimmed: !!focus && (focus.side === 'source' ? l.source !== focus.id : l.segment !== focus.id),
    })),
  };
}

export interface UseWarroomOptions {
  /** 強制開關 mock;沒給時依 warroomMockEnabled() */
  mock?: boolean;
  /** mock 用的亂數(測試給固定種子) */
  rand?: () => number;
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
      mockSrc = createWarroomMock(options.rand);
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
      timers.push(setInterval(refresh, 1000), setInterval(pushLog, 700), setInterval(() => (risk.value = mockSrc!.risk()), RISK_POLL_MS));
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

  watch(paused, (p) => (frozen.value = p ? allLogs.value : null));

  const view = computed(() => buildNodes(data.value, focus.value));
  const sources = computed(() => data.value?.sources ?? []);
  const logs = computed(() => filterLogs(frozen.value ?? allLogs.value, filter.value, focus.value, sources.value));
  /** 右欄即時事件:不受篩選、暫停影響 */
  const events = computed(() => allLogs.value.slice(0, MAX_EVENTS).map((l) => ({ log: l, kind: classifyLog(l) })));
  const rates = computed(() => sumRates(data.value?.links ?? []));
  /** 背景分頁輪詢放慢,不判過期(切回前景會立即更新) */
  const stale = computed(() => {
    if (typeof document !== 'undefined' && document.hidden && lastOkAt.value !== null) return false;
    return lastOkAt.value === null || now.value - lastOkAt.value > STALE_MS;
  });
  /** 資料不完整:WR-1 / WR-2 partial、串流部分類型讀不到 */
  const partial = computed(() => !!data.value?.partial || !!risk.value?.partial || !!stream?.degraded.value);
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
    paused,
    toggleFocus,
    setControl,
    stop,
  };
}
