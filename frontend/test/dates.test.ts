import { describe, expect, it } from 'vitest';
import { checkDayRange, daysBetween, ymd } from '@/composables/dates';

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

describe('checkDayRange(安全事件總覽是否送出查詢)', () => {
  it('沒有已分析資料、期間空白:不送出,也不顯示訊息(後端 from 必填,送出會 400)', () => {
    expect(checkDayRange('', '', false, 92)).toEqual({ ok: false, error: '' });
  });
  it('有資料但期間空白:不送出並提示', () => {
    expect(checkDayRange('', '2026-11-02', true, 92)).toEqual({ ok: false, error: '請選擇開始與結束日期' });
  });
  it('開始晚於結束、超過上限:不送出', () => {
    expect(checkDayRange('2026-11-03', '2026-11-02', true, 92).ok).toBe(false);
    expect(checkDayRange('2026-01-01', '2026-11-02', true, 92)).toEqual({ ok: false, error: '期間最長 92 天' });
  });
  it('有效期間:送出', () => {
    expect(checkDayRange('2026-11-01', '2026-11-02', true, 92)).toEqual({ ok: true, error: '' });
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
