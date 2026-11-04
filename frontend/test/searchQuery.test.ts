import { describe, expect, it } from 'vitest';
import { filenameOf } from '@/api/gateway';
import { isEventIds, localToIso, MAX_COND, pickQuery, toLocalInput } from '@/composables/searchQuery';

describe('明細查詢的網址條件', () => {
  it('時間:日期補 00:00 / 23:59,接受舊版斜線格式,錯誤日期略過', () => {
    expect(toLocalInput('2026-11-02')).toBe('2026-11-02T00:00');
    expect(toLocalInput('2026-11-02', true)).toBe('2026-11-02T23:59');
    expect(toLocalInput('2026-11-02T08:30')).toBe('2026-11-02T08:30');
    expect(toLocalInput('2026/11/02 08:30')).toBe('2026-11-02T08:30');
    expect(toLocalInput('2026-02-31')).toBe('');
    expect(toLocalInput('<script>')).toBe('');
    expect(toLocalInput(['2026-11-02'])).toBe('');
  });

  it('送 API 的時間含時區', () => {
    expect(localToIso('2026-11-02T08:30')).toBe('2026-11-02T08:30:00+08:00');
    expect(localToIso('x')).toBe('');
  });

  it('只收白名單、去空白、長度與格式檢查', () => {
    const q = { src: ' 10.0.0.1 ', evil: 'x', eventId: '4625,abc', q: 'a'.repeat(MAX_COND + 1), level: 'warning' };
    expect(pickQuery(q, ['src', 'eventId', 'q', 'level'] as const, { eventId: isEventIds })).toEqual({ src: '10.0.0.1', level: 'warning' });
    expect(isEventIds('4625, 4771')).toBe(true);
  });
});

describe('filenameOf', () => {
  it('優先用 filename*=UTF-8', () => {
    expect(filenameOf(`attachment; filename="a.csv"; filename*=UTF-8''${encodeURIComponent('網通知識庫匯整.md')}`, 'x')).toBe('網通知識庫匯整.md');
    expect(filenameOf('attachment; filename="a.csv"', 'x')).toBe('a.csv');
    expect(filenameOf(null, 'x.csv')).toBe('x.csv');
  });
});
