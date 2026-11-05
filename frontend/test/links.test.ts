import { describe, expect, it } from 'vitest';
import { LINKS } from '@/config/links';
import { askLink } from '@/composables/aiChat';

describe('一般連結', () => {
  it('只剩 Veeam(AI 已搬進新版,不再連到舊版 NetOps;IMPL-PLAN A1)', () => {
    expect(Object.keys(LINKS)).toEqual(['veeam']);
    expect(JSON.stringify(LINKS)).not.toContain('/NetOps');
  });
});

describe('askLink(其他頁帶問題到 AI 問答)', () => {
  it('問題與日期帶進新版 AI 問答(YYYY-MM-DD,由使用者送出)', () => {
    expect(askLink('10.0.0.1 在威脅 log 的狀況?', '2026-11-01', '2026-11-02')).toEqual({ path: '/firewall/ask', query: { q: '10.0.0.1 在威脅 log 的狀況?', from: '2026-11-01', to: '2026-11-02' } });
  });
  it('AD 用 AD 的 AI 問答;沒有日期不帶 from / to;to 省略時等於 from', () => {
    expect(askLink('x', '', '', 'ad')).toEqual({ path: '/ad/ask', query: { q: 'x' } });
    expect(askLink('x', '2026-11-01', '').query).toEqual({ q: 'x', from: '2026-11-01', to: '2026-11-01' });
  });
});
