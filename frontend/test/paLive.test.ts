/**
 * 即時監控頁的邏輯(R1):收集器狀態提示、log 合併、篩選檢查、速率格式
 */
import { describe, expect, it } from 'vitest';
import type { CollectorStatus, LiveLog } from '@/api/paLive';
import { appendOlder, collectorBadges, collectorView, controlView, fmtBps, latestSnapTime, logSource, mergeLogs, parseFilter, streamFailure } from '@/composables/paLive';

const st = (state: CollectorStatus['state']) => ({ state }) as CollectorStatus;
const log = (id: string): LiveLog => ({ id, type: 'traffic', receivedAt: '2026-11-05T02:00:00Z' });

describe('collectorView', () => {
  it('只有 ok / degraded 視為即時;停止、未啟用、Redis 連不上都明確標示', () => {
    expect(collectorView(st('ok'))).toMatchObject({ live: true, tone: 'success' });
    expect(collectorView(st('degraded'))).toMatchObject({ live: true, tone: 'warning' });
    expect(collectorView(st('stopped'))).toMatchObject({ live: false, tone: 'danger', title: '資料停止更新' });
    expect(collectorView(st('disabled'))).toMatchObject({ live: false, title: '收集器未啟用' });
    expect(collectorView(st('unavailable')).live).toBe(false);
    expect(collectorView(null).live).toBe(false);
  });
});

describe('mergeLogs', () => {
  it('新的在前、去重、保留上限', () => {
    const cur = [log('3-0'), log('2-0')];
    const out = mergeLogs(cur, [log('3-0'), log('4-0'), log('5-0')], 3);
    expect(out.map((x) => x.id)).toEqual(['5-0', '4-0', '3-0']);
    expect(mergeLogs(cur, [], 3)).toBe(cur);
  });
});

describe('parseFilter', () => {
  it('合法條件轉成 API 參數;不合法列出錯誤且不送出', () => {
    expect(parseFilter({ ip: ' 10.1.2.3 ', port: '443', action: 'Deny' })).toEqual({ filter: { ip: '10.1.2.3', port: 443, action: 'deny' }, error: '' });
    const bad = parseFilter({ ip: '10.1.2.3;x', port: '70000', action: 'a b' });
    expect(bad.filter).toEqual({});
    expect(bad.error).toContain('IP');
    expect(bad.error).toContain('Port');
    expect(bad.error).toContain('Action');
  });
});

describe('fmtBps', () => {
  it('換算單位', () => {
    expect(fmtBps(null)).toBe('—');
    expect(fmtBps(950)).toBe('950 bps');
    expect(fmtBps(85_000_000)).toBe('85.0 Mbps');
    expect(fmtBps(1.25e9)).toBe('1.3 Gbps');
  });
});

describe('appendOlder', () => {
  it('串流先到的較新 log 留在前面,預載的較舊 log 接在後面', () => {
    const streamed = mergeLogs([], [log('9-0'), log('10-0')], 500);
    const out = appendOlder(streamed, [log('10-0'), log('8-0'), log('7-0')], 4);
    expect(out.map((x) => x.id)).toEqual(['10-0', '9-0', '8-0', '7-0']);
  });
});

/** 收集器狀態(測試區現況:輪詢開、接收總開關關) */
const col = (over: Partial<CollectorStatus> = {}, poll: Partial<CollectorStatus['poll']> = {}, receive: Partial<CollectorStatus['receive']> = {}) =>
  ({
    state: 'ok',
    message: '',
    updatedAt: null,
    version: null,
    poll: { enabled: true, paused: false, lastOkAt: null, error: null, errorAt: null, ...poll },
    receive: { enabled: false, paused: false, tls: false, httpLastAt: null, syslogLastAt: null, ...receive },
    redis: { error: null, errorAt: null },
    counters: { received: 0, dropped: 0, rejected: 0, malformed: 0, redisFailed: 0, paused: 0 },
    ...over,
  }) as CollectorStatus;

describe('collectorBadges(驗收 §7.4-1)', () => {
  const texts = (c: CollectorStatus) => collectorBadges(c).map((b) => b.text);
  it('輪詢中、接收未啟用(測試區現況)', () => expect(texts(col())).toEqual(['輪詢中', '接收未啟用']));
  it('輪詢失敗、輪詢暫停、接收中、接收暫停', () => {
    expect(texts(col({ state: 'degraded' }, { error: 'session:連線逾時' }))).toEqual(['輪詢失敗', '接收未啟用']);
    expect(texts(col({ state: 'paused' }, { paused: true }))).toEqual(['輪詢暫停', '接收未啟用']);
    expect(texts(col({}, {}, { enabled: true }))).toEqual(['輪詢中', '接收中']);
    expect(texts(col({}, {}, { enabled: true, paused: true }))).toEqual(['輪詢中', '接收暫停']);
  });
  it('收集器停止回報時不顯示「輪詢中」', () => {
    expect(texts(col({ state: 'stopped' }, {}, { enabled: true }))).toEqual(['輪詢停止更新', '接收停止更新']);
    expect(collectorBadges(null)).toEqual([]);
  });
  it('暫停為 paused 狀態的提示', () => expect(collectorView(st('paused'))).toMatchObject({ live: false, title: '收集器已暫停' }));
});

describe('logSource(驗收 §7.4-2)', () => {
  it('接收未啟用時不說「沒有收到這種 log」', () => {
    const v = logSource(col());
    expect(v.live).toBe(false);
    expect(v.empty).toContain('接收端點未啟用,沒有 log 來源');
    expect(v.empty).not.toContain('沒有收到');
  });
  it('接收暫停、接收中、停止', () => {
    expect(logSource(col({}, {}, { enabled: true, paused: true })).empty).toContain('接收已暫停');
    expect(logSource(col({}, {}, { enabled: true }))).toMatchObject({ live: true });
    expect(logSource(col({ state: 'stopped' }, {}, { enabled: true })).live).toBe(false);
  });
});

describe('latestSnapTime(驗收 §7.4-3)', () => {
  it('取各指標快照最新的 time', () => {
    expect(
      latestSnapTime({
        session: { time: '2026-11-09T06:48:34Z' } as never,
        cpu: { time: '2026-11-09T06:48:49Z' } as never,
        throughput: null,
        interfaces: null,
      }),
    ).toBe('2026-11-09T06:48:49Z');
    expect(latestSnapTime({ session: null, cpu: null, throughput: null, interfaces: null })).toBeNull();
  });
});

describe('controlView(測試區開關)', () => {
  const ctl = { available: true, pollPaused: false, receivePaused: false, updatedAt: null, updatedBy: null };
  it('正式區或沒有權限不顯示', () => {
    expect(controlView(col(), { ...ctl, available: false }, true).visible).toBe(false);
    expect(controlView(col(), ctl, false).visible).toBe(false);
    expect(controlView(col(), undefined, true).visible).toBe(false);
  });
  it('總開關關閉的按鈕停用並說明原因', () => {
    const v = controlView(col(), ctl, true);
    expect(v.visible).toBe(true);
    expect(v.poll.disabled).toBe(false);
    expect(v.receive).toMatchObject({ disabled: true });
    expect(v.receive.reason).toContain('主機設定未開啟接收');
  });
  it('收集器沒有回報時都停用;按鈕狀態取要求的狀態', () => {
    expect(controlView(col({ state: 'unavailable' }), ctl, true).poll.disabled).toBe(true);
    expect(controlView(col(), { ...ctl, pollPaused: true }, true).poll.paused).toBe(true);
  });
});

describe('streamFailure(驗收 §6-5、§4.4)', () => {
  it('429:說明要關閉其他分頁,間隔 30 秒起倍增、最多 5 分鐘', () => {
    const f = streamFailure(429, 'NETOPS_STREAM_BUSY', 0);
    expect(f.message).toContain('串流連線數已達上限,請關閉其他即時監控分頁');
    expect(f.delayMs).toBe(30_000);
    expect(streamFailure(429, null, 1).delayMs).toBe(60_000);
    expect(streamFailure(429, null, 10).delayMs).toBe(300_000);
  });
  it('404 ROUTE_NOT_FOUND:功能尚未啟用(路由未發佈)', () => {
    expect(streamFailure(404, 'ROUTE_NOT_FOUND', 0)).toEqual({ message: '即時串流功能尚未啟用(路由未發佈),5 分鐘後再試', delayMs: 300_000 });
  });
  it('其他:10 秒起倍增、最多 2 分鐘', () => {
    expect(streamFailure(0, null, 0).delayMs).toBe(10_000);
    expect(streamFailure(502, null, 20).delayMs).toBe(120_000);
  });
});
