import { describe, expect, it } from 'vitest';
import { coverageText, rangeError, rangeLabel, rangePresets, ymdhm } from '@/composables/dateRange';

const NOW = new Date(2026, 10, 12, 9, 30); // 2026-11-12 09:30(本地)

describe('dateRange', () => {
  it('日期模式快捷選項:今天、昨天、最近 7 天、最近 30 天;超過天數上限的不列', () => {
    const p = rangePresets(NOW, 'date', 92);
    expect(p.map((x) => [x.key, x.from, x.to])).toEqual([
      ['today', '2026-11-12', '2026-11-12'],
      ['yesterday', '2026-11-11', '2026-11-11'],
      ['last7', '2026-11-06', '2026-11-12'],
      ['last30', '2026-10-14', '2026-11-12'],
    ]);
    expect(rangePresets(NOW, 'date', 7).map((x) => x.key)).toEqual(['today', 'yesterday', 'last7']);
  });

  it('時間模式快捷選項:最近 1 小時、最近 24 小時、今天、昨天', () => {
    const p = rangePresets(NOW, 'datetime', 30);
    expect(p[0]).toMatchObject({ key: 'last1h', from: '2026-11-12T08:30', to: '2026-11-12T09:30' });
    expect(p[2]).toMatchObject({ key: 'today', from: '2026-11-12T00:00', to: '2026-11-12T09:30' });
    expect(p[3]).toMatchObject({ key: 'yesterday', from: '2026-11-11T00:00', to: '2026-11-11T23:59' });
  });

  it('整個在資料範圍之前(超過保留期限)的選項停用', () => {
    const p = rangePresets(NOW, 'date', 92, { from: '2026-11-12', to: '2026-11-12' });
    expect(p.find((x) => x.key === 'yesterday')?.disabled).toBe(true);
    expect(p.find((x) => x.key === 'last7')?.disabled).toBe(false);
  });

  it('欄位文字:同一天只顯示一次;時間模式同一天結束只顯示時分', () => {
    expect(rangeLabel({ from: '2026-11-12', to: '2026-11-12' }, 'date')).toBe('2026-11-12');
    expect(rangeLabel({ from: '2026-11-10', to: '2026-11-12' }, 'date')).toBe('2026-11-10 ~ 2026-11-12');
    expect(rangeLabel({ from: '2026-11-12T08:00', to: '2026-11-12T09:00' }, 'datetime')).toBe('2026-11-12 08:00 ~ 09:00');
    expect(rangeLabel({ from: '', to: '' }, 'date')).toBe('');
  });

  it('區間檢查:未選、開始晚於結束、超過天數', () => {
    expect(rangeError({ from: '', to: '2026-11-12' }, 30)).toBe('請選擇開始與結束');
    expect(rangeError({ from: '2026-11-12', to: '2026-11-11' }, 30)).toBe('開始不可晚於結束');
    expect(rangeError({ from: '2026-10-01', to: '2026-11-12' }, 30)).toBe('期間最長 30 天');
    expect(rangeError({ from: '2026-11-01', to: '2026-11-12' }, 30)).toBe('');
    // 時間模式看實際經過的時間(同明細頁與後端)
    expect(rangeError({ from: '2026-10-13T00:00', to: '2026-11-12T00:00' }, 30)).toBe('');
    expect(rangeError({ from: '2026-10-13T00:00', to: '2026-11-12T00:01' }, 30)).toBe('期間最長 30 天');
  });

  it('資料範圍說明', () => {
    expect(coverageText({ from: '2026-11-11', to: '2026-11-12' })).toBe('可查 2026-11-11 ~ 2026-11-12');
    expect(coverageText(null)).toBe('目前沒有資料');
    expect(ymdhm(NOW)).toBe('2026-11-12T09:30');
  });
});
