import { describe, expect, it } from 'vitest';
import { LINKS, legacyAskUrl } from '@/config/links';

describe('legacyAskUrl', () => {
  it('問題與日期帶進舊版 AI 問答(日期改 yyyy/MM/dd,查詢字串編碼)', () => {
    const u = new URL(legacyAskUrl('10.0.0.1 在威脅 log 的狀況?', '2026-11-01', '2026-11-02'));
    expect(`${u.origin}${u.pathname}`).toBe(LINKS.paAsk);
    expect(u.searchParams.get('q')).toBe('10.0.0.1 在威脅 log 的狀況?');
    expect(u.searchParams.get('from')).toBe('2026/11/01');
    expect(u.searchParams.get('to')).toBe('2026/11/02');
  });
  it('AD 用 AD 的 AI 問答;沒有日期不帶 from / to', () => {
    const u = new URL(legacyAskUrl('x', '', '', 'ad'));
    expect(`${u.origin}${u.pathname}`).toBe(LINKS.adAsk);
    expect(u.searchParams.has('from')).toBe(false);
  });
});
