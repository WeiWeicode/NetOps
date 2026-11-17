/**
 * 戰情室邏輯層(docs/WARROOM-PLAN.md §3 WR-4):篩選、聚焦、速率換算、輪詢失敗重試(stale)、partial、mock 切換、AI 冷卻。
 */
import { effectScope, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveLog } from '@/api/paLive';
import type { Warroom, WarroomLink, WarroomSource } from '@/api/warroom';

const wr = vi.hoisted(() => ({ get: vi.fn(), risk: vi.fn(), insight: vi.fn(), runInsight: vi.fn() }));
const live = vi.hoisted(() => ({ snapshot: vi.fn(), logs: vi.fn(), setControl: vi.fn(), streamUrl: vi.fn(() => '/s'), probeStream: vi.fn() }));
vi.mock('@/api/warroom', () => ({ warroom: wr }));
vi.mock('@/api/paLive', async (orig) => {
  const real = await orig<typeof import('@/api/paLive')>();
  return { ...real, paLive: { ...real.paLive, ...live } };
});

import { ApiError } from '@giganexus/web-kit';
import { buildNodes, classifyLog, denyTone, filterLogs, particleRate, perMinutes, sourceIdOf, sumRates, useWarroom, STALE_MS } from '@/composables/useWarroom';
import { cooldownFromError, useWarroomAi, COOLDOWN_MS } from '@/composables/useWarroomAi';
import { createWarroomMock, seededRandom, warroomMockEnabled } from '@/composables/warroomMock';

const SOURCES: WarroomSource[] = [
  { id: 'TW', kind: 'country', label: '台灣', conn: 100, deny: 2, threat: 0, topDst: [], topApp: [] },
  { id: '45.155.205.12', kind: 'ip', label: '45.155.205.12', conn: 50, deny: 49, threat: 0, topDst: [], topApp: [] },
  { id: 'other', kind: 'other', label: '其他', conn: 10, deny: 3, threat: 0, topDst: [], topApp: [] },
];
const L = (o: Partial<LiveLog>): LiveLog => ({ id: Math.random().toString(), type: 'traffic', receivedAt: '', ...o }) as LiveLog;
const LINKS: WarroomLink[] = [
  { source: 'TW', segment: 'vlan10', conn: 2, allow: 1.9, deny: 0.1, threat: 0 },
  { source: '45.155.205.12', segment: 'dmz', conn: 1, allow: 0, deny: 0.9, threat: 0.1 },
];
const WR: Warroom = { generatedAt: '', minutes: 5, partial: false, sources: SOURCES, segments: [], links: LINKS, kpis: { denyPerMin: 60, threat5m: 3 } };

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
  });

  it('sourceIdOf:攻擊 IP 優先、再國家、其餘歸其他', () => {
    expect(sourceIdOf(L({ src: '45.155.205.12', country: 'RU' }), SOURCES)).toBe('45.155.205.12');
    expect(sourceIdOf(L({ src: '1.2.3.4', country: 'TW' }), SOURCES)).toBe('TW');
    expect(sourceIdOf(L({ src: '1.2.3.4', country: 'JP' }), SOURCES)).toBe('other');
  });

  it('filterLogs:篩選 + 聚焦 + 上限', () => {
    const logs = [L({ action: 'deny', country: 'TW', segment: 'a' }), L({ action: 'allow', country: 'TW', segment: 'b' }), L({ type: 'threat', country: 'JP', segment: 'a' })];
    expect(filterLogs(logs, 'deny', null, SOURCES)).toHaveLength(1);
    expect(filterLogs(logs, 'threat', null, SOURCES)).toHaveLength(1);
    expect(filterLogs(logs, 'all', { side: 'segment', id: 'a' }, SOURCES)).toHaveLength(2);
    expect(filterLogs(logs, 'all', { side: 'source', id: 'TW' }, SOURCES)).toHaveLength(2);
    expect(filterLogs(logs, 'allow', { side: 'segment', id: 'a' }, SOURCES)).toHaveLength(0);
    expect(filterLogs(Array.from({ length: 300 }, () => L({})), 'all', null, SOURCES)).toHaveLength(200);
  });

  it('速率換算:加總、每分、粒子預算', () => {
    expect(sumRates(LINKS)).toEqual({ conn: 3, allow: 1.9, deny: 1, threat: 0.1 });
    expect(sumRates(LINKS, (l) => l.source === 'TW').conn).toBe(2);
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
    const v = buildNodes(WR, { side: 'source', id: 'TW' });
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
  });

  it('mock 資料形狀與 API 相同', () => {
    const m = createWarroomMock(seededRandom(7));
    const w = m.warroom();
    expect(w.sources.length).toBe(9);
    expect(w.links.every((l) => Math.abs(l.allow + l.deny + l.threat - l.conn) < 1e-9)).toBe(true);
    const log = m.log();
    expect(typeof log.segment).toBe('string');
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
    expect(w.nodes.value.sources.length).toBe(9);
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
    wr.risk.mockResolvedValue({ partial: true });
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

describe('useWarroomAi', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(wr).forEach((f) => f.mockReset());
  });
  afterEach(() => vi.useRealTimers());

  it('cooldownFromError:429 用 retryAfter,沒有時 5 分鐘', () => {
    expect(cooldownFromError(new ApiError(429, 'X', '', null, { retryAfter: 30 }), 0)).toBe(30_000);
    expect(cooldownFromError(new ApiError(429, 'X', '', null), 0)).toBe(COOLDOWN_MS);
    expect(cooldownFromError(new ApiError(409, 'X', '', null), 0)).toBeNull();
  });

  it('沒有權限不能執行;執行逐字後進入冷卻', async () => {
    wr.insight.mockResolvedValue({ hour: null, text: '', model: '', trigger: 'auto', partial: false, status: 'none' });
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

  it('429 → 顯示錯誤並依 retryAfter 冷卻', async () => {
    wr.insight.mockResolvedValue({ hour: null, text: '', model: '', trigger: 'auto', partial: false, status: 'none' });
    wr.runInsight.mockRejectedValue(new ApiError(429, 'NETOPS_AI_COOLDOWN', '冷卻中', null, { retryAfter: 60 }));
    const scope = effectScope();
    const a = scope.run(() => useWarroomAi({ mock: false, can: () => true }))!;
    await vi.advanceTimersByTimeAsync(0);
    await a.run();
    expect(a.runError.value).toBeTruthy();
    expect(a.cooldownSec.value).toBe(60);
    scope.stop();
  });
});
