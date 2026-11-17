/**
 * 戰情室邏輯層(docs/WARROOM-PLAN.md §3 WR-4):篩選、聚焦、速率換算、輪詢失敗重試(stale)、partial、mock 切換、AI 冷卻。
 */
import { effectScope, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveLog } from '@/api/paLive';
import type { Warroom, WarroomLink, WarroomRisk, WarroomSource } from '@/api/warroom';

const wr = vi.hoisted(() => ({ get: vi.fn(), risk: vi.fn(), insight: vi.fn(), runInsight: vi.fn() }));
const live = vi.hoisted(() => ({ snapshot: vi.fn(), logs: vi.fn(), setControl: vi.fn(), streamUrl: vi.fn(() => '/s'), probeStream: vi.fn() }));
vi.mock('@/api/warroom', async (orig) => ({ ...(await orig<typeof import('@/api/warroom')>()), warroom: wr }));
vi.mock('@/api/paLive', async (orig) => {
  const real = await orig<typeof import('@/api/paLive')>();
  return { ...real, paLive: { ...real.paLive, ...live } };
});

import { ApiError } from '@giganexus/web-kit';
import { buildNodes, classifyLog, isPrivateIp, warroomNotices, denyTone, filterLogs, particleRate, perMinutes, sourceIdOf, sumRates, useWarroom, STALE_MS } from '@/composables/useWarroom';
import { cooldownFromError, useWarroomAi, COOLDOWN_MS } from '@/composables/useWarroomAi';
import { createWarroomMock, resolveMock, seededRandom, warroomMockEnabled } from '@/composables/warroomMock';

const SOURCES: WarroomSource[] = [
  { id: 'cc:TW', kind: 'country', label: '台灣', country: 'TW', conn: 100, deny: 2, threat: 0, topDst: [], topApp: [] },
  { id: 'ip:45.155.205.12', kind: 'ip', label: '45.155.205.12', country: 'NL', conn: 50, deny: 49, threat: 0, topDst: [], topApp: [] },
  { id: 'other', kind: 'other', label: '其他', country: null, conn: 10, deny: 3, threat: 0, topDst: [], topApp: [] },
  { id: 'lan', kind: 'other', label: '內部互連', country: null, conn: 5, deny: 0, threat: 0, topDst: [], topApp: [] },
];
const L = (o: Partial<LiveLog>): LiveLog => ({ id: Math.random().toString(), type: 'traffic', receivedAt: '', ...o }) as LiveLog;
const LINKS: WarroomLink[] = [
  { source: 'cc:TW', segment: 'vlan10', conn: 2, allow: 1.9, deny: 0.1, threat: 0 },
  { source: 'ip:45.155.205.12', segment: 'dmz', conn: 1, allow: 0, deny: 0.9, threat: 0.1 },
];
const WR: Warroom = {
  generatedAt: '',
  minutes: 5,
  partial: false,
  segmentsSource: 'file',
  gauge: { throughputMaxBps: 1e9, sessionMax: 65536 },
  geo: { available: true, version: '2026-11', attribution: { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' } },
  sample: { traffic: 10, trafficSec: 300, threat: 1, threatSec: 300, complete: true },
  sources: SOURCES, segments: [], links: LINKS, kpis: { denyPerMin: 60, threat5m: 3 } };

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

describe('純函式', () => {
  it('classifyLog:威脅類一律威脅,TRAFFIC 依 action', () => {
    expect(classifyLog(L({ type: 'threat', action: 'alert' }))).toBe('threat');
    expect(classifyLog(L({ action: 'deny' }))).toBe('deny');
    expect(classifyLog(L({ action: 'reset-both' }))).toBe('deny');
    expect(classifyLog(L({ action: 'allow' }))).toBe('allow');
    expect(classifyLog(L({ action: 'sinkhole' }))).toBe('deny');
    expect(classifyLog(L({ action: 'allow-block' }))).toBe('allow');
  });

  it('sourceIdOf:同後端規則(攻擊 IP 只計連入、內部互連、國家、其他)', () => {
    expect(sourceIdOf(L({ src: '45.155.205.12', dst: '10.1.1.1', country: 'NL' }), SOURCES)).toBe('ip:45.155.205.12');
    // 連出到攻擊 IP 不算攻擊 IP 節點,歸國家(NL 不在清單 → 其他)
    expect(sourceIdOf(L({ src: '10.1.1.1', dst: '45.155.205.12', country: 'NL' }), SOURCES)).toBe('other');
    expect(sourceIdOf(L({ src: '1.2.3.4', dst: '10.1.1.1', country: 'TW' }), SOURCES)).toBe('cc:TW');
    expect(sourceIdOf(L({ src: '10.1.1.1', dst: '61.2.3.4', country: 'TW' }), SOURCES)).toBe('cc:TW');
    expect(sourceIdOf(L({ src: '1.2.3.4', dst: '10.1.1.1', country: null }), SOURCES)).toBe('other');
    expect(sourceIdOf(L({ src: '10.1.1.1', dst: '192.168.1.2', country: null }), SOURCES)).toBe('lan');
    expect(sourceIdOf(L({ src: '100.64.0.1', dst: '172.20.0.1' }), SOURCES)).toBe('lan');
  });

  it('isPrivateIp:同後端範圍', () => {
    for (const ip of ['10.0.0.1', '172.31.255.255', '192.168.0.1', '100.127.0.1', '127.0.0.1', '169.254.1.1', 'fd00::1', 'fe80::1', '::1']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['172.32.0.1', '100.128.0.1', '8.8.8.8', '2001:db8::1']) expect(isPrivateIp(ip)).toBe(false);
  });

  it('warroomNotices:範例網段、設定錯誤、推估、partial', () => {
    expect(warroomNotices(WR, null)).toEqual([]);
    const keys = (w: Partial<Warroom>, r: Partial<WarroomRisk> | null = null) => warroomNotices({ ...WR, ...w }, r as WarroomRisk | null).map((n) => n.key);
    expect(keys({ segmentsSource: 'example' })).toEqual(['segments-example']);
    expect(keys({ segmentsSource: 'invalid' })).toEqual(['segments-invalid']);
    expect(keys({ geo: { ...WR.geo, available: false } })).toEqual(['geo-unavailable']);
    expect(keys({ sample: { ...WR.sample!, complete: false } })).toEqual(['estimated']);
    expect(keys({ partial: true, message: 'Redis 連不上' }, { partial: true, sample: { threat: 1, complete: false } })).toEqual(['partial', 'risk-partial', 'risk-estimated']);
  });

  it('filterLogs:篩選 + 聚焦 + 上限', () => {
    const logs = [L({ action: 'deny', src: '1.1.1.1', dst: '10.0.0.1', country: 'TW', segment: 'a' }), L({ action: 'allow', src: '1.1.1.2', dst: '10.0.0.2', country: 'TW', segment: 'b' }), L({ type: 'threat', src: '2.2.2.2', dst: '10.0.0.3', country: 'JP', segment: 'a' })];
    expect(filterLogs(logs, 'deny', null, SOURCES)).toHaveLength(1);
    expect(filterLogs(logs, 'threat', null, SOURCES)).toHaveLength(1);
    expect(filterLogs(logs, 'all', { side: 'segment', id: 'a' }, SOURCES)).toHaveLength(2);
    expect(filterLogs(logs, 'all', { side: 'source', id: 'cc:TW' }, SOURCES)).toHaveLength(2);
    expect(filterLogs(logs, 'allow', { side: 'segment', id: 'a' }, SOURCES)).toHaveLength(0);
    expect(filterLogs(Array.from({ length: 300 }, () => L({})), 'all', null, SOURCES)).toHaveLength(200);
  });

  it('速率換算:加總、每分、粒子預算', () => {
    expect(sumRates(LINKS)).toEqual({ conn: 3, allow: 1.9, deny: 1, threat: 0.1 });
    expect(sumRates(LINKS, (l) => l.source === 'cc:TW').conn).toBe(2);
    expect(perMinutes(1)).toBe(60);
    expect(perMinutes(0.5, 5)).toBe(150);
    expect(particleRate(LINKS[0]!, 3)).toBe(2);
    // 總量超過預算:依比例縮小
    expect(particleRate({ ...LINKS[0]!, conn: 100 }, 400, { budget: 120 })).toBe(30);
    expect(particleRate({ ...LINKS[0]!, conn: 10 }, 400, { budget: 120 })).toBe(3);
  });

  it('buildNodes:阻擋比例、顏色、大小、聚焦淡出', () => {
    expect(denyTone(0.7)).toBe('deny');
    expect(denyTone(0.3)).toBe('warn');
    expect(denyTone(0.1)).toBe('allow');
    const v = buildNodes(WR, { side: 'source', id: 'cc:TW' });
    expect(v.sources[1]!.tone).toBe('deny');
    expect(v.sources[0]!.size).toBe(1);
    expect(v.links.map((l) => l.dimmed)).toEqual([false, true]);
    expect(buildNodes(null, null).sources).toEqual([]);
  });
});

describe('mock 切換', () => {
  it('正式建置一律關閉', () => {
    expect(warroomMockEnabled({ PROD: true, VITE_WARROOM_MOCK: '1' }, '?mock=1')).toBe(false);
    expect(warroomMockEnabled({ PROD: false }, '?mock=1')).toBe(true);
    expect(warroomMockEnabled({ PROD: false, VITE_WARROOM_MOCK: '1' }, '')).toBe(true);
    expect(warroomMockEnabled({ PROD: false }, '')).toBe(false);
    // 呼叫端傳 mock: true 也不能在正式建置開啟
    expect(resolveMock(true, { PROD: true })).toBe(false);
    expect(resolveMock(true, { PROD: false })).toBe(true);
  });

  it('mock 資料形狀與 API 相同', () => {
    const m = createWarroomMock(seededRandom(7));
    const w = m.warroom();
    expect(w.sources.length).toBe(10);
    expect(w.geo.attribution.text).toBe('IP Geolocation by DB-IP');
    expect(w.links.every((l) => Math.abs(l.allow + l.deny + l.threat - l.conn) < 1e-9)).toBe(true);
    // mock log 能對回 mock 來源節點(聚焦篩選可用)
    const ids = new Set(w.sources.map((x) => x.id));
    for (let i = 0; i < 50; i++) {
      const log = m.log();
      expect(typeof log.segment).toBe('string');
      expect(ids.has(sourceIdOf(log, w.sources)!)).toBe(true);
    }
  });
});

describe('useWarroom', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    Object.values(wr).forEach((f) => f.mockReset());
    live.snapshot.mockResolvedValue({ collector: { state: 'ok' }, metrics: {} });
    live.logs.mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mock 模式不呼叫 API,有節點與 log', () => {
    const scope = effectScope();
    const w = scope.run(() => useWarroom({ mock: true, rand: seededRandom(3) }))!;
    expect(w.nodes.value.sources.length).toBe(10);
    expect(w.notices.value.map((n) => n.key)).toEqual(['segments-example']);
    expect(w.geoAttribution.value?.url).toBe('https://db-ip.com');
    expect(w.gauge.value.sessionMax).toBe(64_000);
    expect(w.logs.value.length).toBe(20);
    expect(wr.get).not.toHaveBeenCalled();
    expect(live.snapshot).not.toHaveBeenCalled();
    scope.stop();
  });

  it('輪詢失敗保留上一份、標示 stale,下一輪自動恢復', async () => {
    wr.get.mockResolvedValueOnce(WR).mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValue(WR);
    wr.risk.mockResolvedValue({ partial: false });
    const scope = effectScope();
    const w = scope.run(() => useWarroom({ mock: false }))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(w.stale.value).toBe(false);
    await vi.advanceTimersByTimeAsync(STALE_MS + 1000);
    expect(w.warroomError.value).toBeTruthy();
    expect(w.data.value).toBe(WR);
    expect(w.stale.value).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.warroomError.value).toBeNull();
    expect(w.stale.value).toBe(false);
    scope.stop();
  });

  it('partial:WR-1 或 WR-2 任一不完整', async () => {
    wr.get.mockResolvedValue({ ...WR, partial: false });
    wr.risk.mockResolvedValue({ partial: true, sample: null });
    const scope = effectScope();
    const w = scope.run(() => useWarroom({ mock: false }))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(w.partial.value).toBe(true);
    scope.stop();
  });

  it('暫停凍結 log、聚焦同步篩選、再點同節點取消', async () => {
    const scope = effectScope();
    const w = scope.run(() => useWarroom({ mock: true, rand: seededRandom(5) }))!;
    w.paused.value = true;
    await nextTick();
    const before = w.logs.value.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(w.logs.value.length).toBe(before);
    expect(w.events.value.length).toBeGreaterThan(before);
    w.toggleFocus({ side: 'segment', id: 'vlan10' });
    expect(w.logs.value.every((l) => l.segment === 'vlan10')).toBe(true);
    w.toggleFocus({ side: 'segment', id: 'vlan10' });
    expect(w.focus.value).toBeNull();
    scope.stop();
  });
});

/** !116 GET /ai/hourly-insight 無資料時的實際形狀 */
const none = (over: Record<string, unknown> = {}) => ({
  enabled: true, status: 'none', running: false, hour: null, until: null, text: null, model: null, trigger: null,
  partial: false, statsMinutes: null, at: null, error: null, cooldownUntil: null, ...over,
});

describe('useWarroomAi', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(wr).forEach((f) => f.mockReset());
  });
  afterEach(() => vi.useRealTimers());

  it('cooldownFromError:429 用 retryAfter,沒有時 5 分鐘', () => {
    expect(cooldownFromError(new ApiError(429, 'X', '', null, [{ field: 'retryAfterSec', message: '30' }]), 0)).toBe(30_000);
    expect(cooldownFromError(new ApiError(429, 'X', '', null), 0)).toBe(COOLDOWN_MS);
    expect(cooldownFromError(new ApiError(409, 'X', '', null), 0)).toBeNull();
  });

  it('沒有權限不能執行;執行逐字後進入冷卻', async () => {
    // 手動執行後伺服器回 cooldownUntil(!116)
    let cdAt: string | null = null;
    wr.insight.mockImplementation(async () => {
      if (wr.runInsight.mock.calls.length && !cdAt) cdAt = new Date(Date.now() + 300_000).toISOString();
      return none({ cooldownUntil: cdAt && Date.parse(cdAt) > Date.now() ? cdAt : null });
    });
    wr.runInsight.mockImplementation(async (on: (e: { event: string; data: unknown }) => void) => {
      on({ event: 'content', data: { text: '你' } });
      on({ event: 'content', data: { text: '好' } });
    });
    const scope = effectScope();
    const deny = scope.run(() => useWarroomAi({ mock: false, can: () => false }))!;
    expect(deny.canRun.value).toBe(false);
    const a = scope.run(() => useWarroomAi({ mock: false, can: () => true }))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(a.canRun.value).toBe(true);
    const p = a.run();
    expect(a.running.value).toBe(true);
    await p;
    expect(a.streamText.value).toBe('你好');
    expect(a.cooldownSec.value).toBe(300);
    expect(a.canRun.value).toBe(false);
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS + 1000);
    expect(a.canRun.value).toBe(true);
    scope.stop();
  });

  it('SSE meta 事件的 hour / model / partial 寫回最新一筆', async () => {
    wr.insight.mockResolvedValueOnce(none()).mockRejectedValue(new Error('net'));
    wr.runInsight.mockImplementation(async (on: (e: { event: string; data: unknown }) => void) => {
      on({ event: 'open', data: {} });
      on({ event: 'meta', data: { hour: '2026-11-17T09:00:00+08:00', until: '2026-11-17T09:20:00+08:00', trigger: 'manual', model: 'Qwen', partial: true, statsMinutes: { traffic: 15, risk: 60 } } });
      on({ event: 'thinking', data: { chars: 10 } });
      on({ event: 'content', data: { text: 'ok' } });
      on({ event: 'done', data: {} });
    });
    const scope = effectScope();
    const a = scope.run(() => useWarroomAi({ mock: false, can: () => true }))!;
    await vi.advanceTimersByTimeAsync(0);
    await a.run();
    expect(a.insight.value).toMatchObject({ hour: '2026-11-17T09:00:00+08:00', model: 'Qwen', partial: true, trigger: 'manual', status: 'done', text: 'ok', running: false });
    expect(a.text.value).toBe('ok');
    scope.stop();
  });

  it('後端 running:busy、不能執行,並以短間隔追結果;enabled false 不能執行;failed 帶原因', async () => {
    wr.insight
      .mockResolvedValueOnce(none({ running: true }))
      .mockResolvedValueOnce(none({ status: 'failed', error: { code: 'NETOPS_AI_UNAVAILABLE', message: 'AI 主機無法連線' } }))
      .mockResolvedValue(none({ enabled: false }));
    const scope = effectScope();
    const a = scope.run(() => useWarroomAi({ mock: false, can: () => true }))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(a.busy.value).toBe(true);
    expect(a.canRun.value).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wr.insight).toHaveBeenCalledTimes(2);
    expect(a.failed.value).toBe(true);
    expect(a.failReason.value).toBe('AI 主機無法連線');
    expect(a.canRun.value).toBe(true);
    await a.reload();
    expect(a.enabled.value).toBe(false);
    expect(a.canRun.value).toBe(false);
    scope.stop();
  });

  it('伺服器 cooldownUntil 為 null 時解除本機冷卻', async () => {
    wr.insight.mockResolvedValue(none());
    wr.runInsight.mockRejectedValue(new ApiError(429, 'X', '冷卻中', null, [{ field: 'retryAfterSec', message: '200' }]));
    const scope = effectScope();
    const a = scope.run(() => useWarroomAi({ mock: false, can: () => true }))!;
    await vi.advanceTimersByTimeAsync(0);
    await a.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.cooldownSec.value).toBe(0);
    expect(a.runError.value).toBeTruthy();
    scope.stop();
  });

  it('後端 cooldownUntil 決定冷卻', async () => {
    wr.insight.mockResolvedValue(none({ cooldownUntil: new Date(Date.now() + 120_000).toISOString() }));
    const scope = effectScope();
    const a = scope.run(() => useWarroomAi({ mock: false, can: () => true }))!;
    await vi.advanceTimersByTimeAsync(0);
    expect(a.cooldownSec.value).toBeGreaterThan(110);
    expect(a.canRun.value).toBe(false);
    scope.stop();
  });

  it('429 → 顯示錯誤並依 retryAfter 冷卻', async () => {
    wr.insight.mockImplementation(async () => none({ cooldownUntil: wr.runInsight.mock.calls.length ? new Date(Date.now() + 60_000).toISOString() : null }));
    wr.runInsight.mockRejectedValue(new ApiError(429, 'NETOPS_AI_COOLDOWN', '冷卻中', null, [{ field: 'retryAfterSec', message: '60' }]));
    const scope = effectScope();
    const a = scope.run(() => useWarroomAi({ mock: false, can: () => true }))!;
    await vi.advanceTimersByTimeAsync(0);
    await a.run();
    expect(a.runError.value).toBeTruthy();
    expect(a.cooldownSec.value).toBe(60);
    scope.stop();
  });
});
