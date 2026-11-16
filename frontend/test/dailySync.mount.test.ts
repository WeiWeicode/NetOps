// @vitest-environment happy-dom
/**
 * 對帳後每日同步(AC1):純函式與「每日自動同步」卡片。
 *   - 只取指定類型(AD 頁只看 ad)、前一天完成數、失敗清單、表頭日期與星期
 *   - FTP 連續多天沒有新檔的類型(stale):前一天略過數、提示「PA 匯出可能中斷」與「中斷」標籤(驗收報告 §3.2)
 *   - 卡片:狀態標籤、每類型每天的格子(含無障礙文字)、失敗提示、停止重試提示、未啟用說明;沒有 daily(舊版後端)不顯示
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ui from '@/ui';
import type { DailySyncStatus } from '@/api/ftp';
import DailySyncCard from '@/components/DailySyncCard.vue';
import { dailyCategories, dailyDayLabel, dailyDays, dailyErrors, dailyLatest, dailyStale } from '@/composables/ftpFiles';

const DAYS = ['2026-11-12', '2026-11-11', '2026-11-10'];
const status = (o: Partial<DailySyncStatus> = {}): DailySyncStatus => ({
  enabled: true,
  at: '08:10',
  retentionDays: 10,
  state: 'retrying',
  runDay: '2026-11-13',
  lastRunAt: '2026-11-13T00:20:00.000Z',
  lastSyncAt: '2026-11-13T00:10:00.000Z',
  finishedAt: null,
  tries: 2,
  categories: [
    { key: 'decryption', label: '解密', days: DAYS.map((day) => ({ day, state: 'done' as const })) },
    { key: 'globalprotect', label: 'GlobalProtect VPN', days: DAYS.map((day, i) => ({ day, state: i === 0 ? ('pending' as const) : ('done' as const) })) },
    { key: 'userid', label: 'User-ID', days: DAYS.map((day, i) => ({ day, state: i === 2 ? ('error' as const) : ('done' as const) })) },
    { key: 'ad', label: 'AD 事件', days: DAYS.map((day, i) => ({ day, state: i === 0 ? ('none' as const) : ('done' as const) })) },
  ],
  ...o,
});

describe('每日同步的純函式', () => {
  it('依類型篩選、前一天完成數、失敗清單、表頭', () => {
    const s = status();
    expect(dailyCategories(s, ['ad']).map((c) => c.key)).toEqual(['ad']);
    expect(dailyCategories(null)).toEqual([]);
    expect(dailyDays(dailyCategories(s))).toEqual(DAYS);
    expect(dailyLatest(dailyCategories(s))).toEqual({ day: '2026-11-12', done: 2, total: 4, stale: 0 });
    expect(dailyStale(dailyCategories(s))).toEqual([]);
    expect(dailyErrors(dailyCategories(s))).toEqual(['User-ID 2026-11-10']);
    expect(dailyDayLabel('2026-11-12')).toEqual({ md: '11/12', wd: '四' });
  });
});

describe('DailySyncCard', () => {
  const make = (props: { status: DailySyncStatus | null | undefined; only?: string[] }) => mount(DailySyncCard, { props, global: { plugins: [ui] } });

  it('顯示狀態、每類型每天的格子與失敗提示', () => {
    const w = make({ status: status() });
    expect(w.text()).toContain('每日自動同步');
    expect(w.text()).toContain('每天 08:10 對帳後自動匯入');
    expect(w.text()).toContain('前一天尚未完成');
    expect(w.text()).toContain('2 / 4');
    expect(w.findAll('tbody tr')).toHaveLength(4);
    expect(w.findAll('thead th.day').map((th) => th.text())).toEqual(['11/12四', '11/11三', '11/10二']);
    expect(w.find('[aria-label="GlobalProtect VPN 2026-11-12:處理中"]').exists()).toBe(true);
    expect(w.find('[aria-label="AD 事件 2026-11-12:尚無檔案"]').exists()).toBe(true);
    expect(w.text()).toContain('有檔案匯入失敗');
    expect(w.text()).toContain('User-ID 2026-11-10');
  });

  it('AD 頁只顯示 AD;停止重試時提示手動同步', () => {
    const w = make({ status: status({ state: 'gave-up', finishedAt: '2026-11-13T15:00:00.000Z' }), only: ['ad'] });
    expect(w.findAll('tbody tr')).toHaveLength(1);
    expect(w.text()).toContain('每天 08:10 對帳後自動匯入 AD 事件');
    expect(w.text()).toContain('今天已停止重試');
    expect(w.text()).toContain('手動同步');
    expect(w.text()).not.toContain('有檔案匯入失敗');
  });

  it('FTP 連續多天沒有新檔的類型標「中斷」並提示 PA 匯出可能中斷', () => {
    const none = DAYS.map((day) => ({ day, state: 'none' as const }));
    const base = status();
    const s = status({
      state: 'done',
      finishedAt: '2026-11-13T00:30:00.000Z',
      categories: [
        { ...base.categories[0]!, noFileDays: 0, stale: false },
        { key: 'userid', label: 'User-ID', noFileDays: 3, stale: true, days: none },
        { key: 'globalprotect', label: 'GlobalProtect VPN', noFileDays: 2, stale: true, days: DAYS.map((day, i) => ({ day, state: i < 2 ? ('none' as const) : ('done' as const) })) },
      ],
    });
    const cats = dailyCategories(s);
    expect(dailyLatest(cats)).toMatchObject({ done: 1, total: 3, stale: 2 });
    expect(dailyStale(cats)).toEqual(['User-ID:FTP 已 3 天以上沒有新檔,PA 匯出可能中斷', 'GlobalProtect VPN:FTP 已 2 天沒有新檔,PA 匯出可能中斷']);
    const w = make({ status: s });
    expect(w.text()).toContain('PA 匯出可能中斷');
    expect(w.text()).toContain('2 類 FTP 中斷,略過');
    expect(w.text()).toContain('GlobalProtect VPN:FTP 已 2 天沒有新檔');
    expect(w.text()).toContain('今天已完成');
    expect(w.findAll('.stale-badge')).toHaveLength(2);
    // 舊版後端沒有 stale 欄位:不顯示
    expect(make({ status: status() }).text()).not.toContain('PA 匯出可能中斷');
  });

  it('未啟用時說明只能手動同步;沒有 daily(舊版後端)不顯示', () => {
    const w = make({ status: status({ enabled: false, state: 'disabled', at: null, categories: [] }) });
    expect(w.text()).toContain('未啟用');
    expect(w.text()).toContain('手動同步');
    expect(w.find('table').exists()).toBe(false);
    expect(make({ status: undefined }).find('.daily').exists()).toBe(false);
  });
});
