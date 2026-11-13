import { describe, expect, it } from 'vitest';
import { filenameOf } from '@/api/gateway';
import { countryRange, ignoredThreatCond, isEventIds, localToIso, MAX_COND, pickQuery, toLocalInput } from '@/composables/searchQuery';

describe('ignoredThreatCond、countryRange(C7 第二輪)', () => {
  it('只列出無法套用的條件:不認得的類型、非 THREAT 帶的威脅名稱 / 嚴重度、不認得的嚴重度', () => {
    expect(ignoredThreatCond({ type: 'THREAT', threat: 'X(1)', severity: 'high', src: '10.0.0.1' })).toBe('');
    expect(ignoredThreatCond({ threat: 'X(1)', severity: 'high' })).toBe('威脅名稱「X(1)」、嚴重度 high');
    expect(ignoredThreatCond({ type: 'URL' })).toBe('類型 URL');
    expect(ignoredThreatCond({ type: 'THREAT', severity: 'urgent' })).toBe('嚴重度 urgent');
    expect(ignoredThreatCond({ src: '10.0.0.1' })).toBe('');
    expect(ignoredThreatCond({ type: 'TRAFFIC' })).toBe('');
  });

  it('countryRange:PA 國家欄位的網段範圍 → 內部網路與 CIDR;一般國家回 null', () => {
    expect(countryRange('10.0.0.0-10.255.255.255')).toEqual({ label: '內部網路 10.0.0.0/8', cidr: '10.0.0.0/8' });
    expect(countryRange('169.254.0.0-169.254.255.255')).toEqual({ label: '內部網路 169.254.0.0/16', cidr: '169.254.0.0/16' });
    expect(countryRange('10.0.0.1-10.0.0.3')).toEqual({ label: '網段 10.0.0.1-10.0.0.3', cidr: null });
    expect(countryRange('fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')?.cidr).toBeNull();
    expect(countryRange('United States')).toBeNull();
    expect(countryRange('Asia Pacific Region')).toBeNull();
  });
});

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
    expect(filenameOf(`attachment; filename*=UTF-8''${encodeURIComponent('../a/b:c.md')}`, 'x')).toBe('.._a_b_c.md');
  });
});
