/**
 * 即時監控頁的邏輯(R1):收集器狀態提示、log 合併、篩選檢查、速率格式
 */
import { describe, expect, it } from 'vitest';
import type { CollectorStatus, LiveLog } from '@/api/paLive';
import { appendOlder, collectorView, fmtBps, mergeLogs, parseFilter } from '@/composables/paLive';

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
