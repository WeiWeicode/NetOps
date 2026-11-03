import { describe, expect, it } from 'vitest';
import { daysBetween, ymd } from '@/composables/dates';

describe('dates', () => {
  it('daysBetween 含兩端、跨月;格式錯誤回 0', () => {
    expect(daysBetween('2026-11-02', '2026-11-02')).toBe(1);
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(4);
    expect(daysBetween('2026-11-02', 'x')).toBe(0);
  });
  it('ymd 用本地日期', () => {
    expect(ymd(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('reasonQuery', () => {
  it('取結尾括號內的代碼(全形 / 半形)', async () => {
    const { reasonQuery } = await import('@/composables/adEvents');
    expect(reasonQuery('使用者名稱或密碼錯誤（0xC000006A）')).toBe('0xC000006A');
    expect(reasonQuery('帳戶已停用(0x25)')).toBe('0x25');
    expect(reasonQuery('其他原因')).toBe('其他原因');
  });
});
