import { describe, expect, it } from 'vitest';
import type { AdDay, PaFile } from '@/api/ftp';
import { analyzableDir, chunk, countFiles, crumbsOf, dayOf, filterFiles, groupDays, NO_DAY, progressPct, securityEmptyDays } from '@/composables/ftpFiles';

const file = (name: string, o: Partial<PaFile> = {}): PaFile => ({
  name,
  path: `/${name}`,
  dir: false,
  size: 100,
  modified: null,
  isLog: true,
  state: 'new',
  ...o,
});

describe('dayOf', () => {
  it('已分析:用資料日期', () => {
    expect(dayOf(file('PA-560_traffic_2026_10_16_last_calendar_day_0.csv', { day: '2026-10-14' }))).toBe('2026-10-14');
  });
  it('未分析:last_calendar_day 是匯出日,往前一天(跨月)', () => {
    expect(dayOf(file('PA-560_traffic_2026_11_01_last_calendar_day_0.csv'))).toBe('2026-10-31');
  });
  it('一般日期檔名不調整', () => {
    expect(dayOf(file('threat-2026-11-02.log'))).toBe('2026-11-02');
  });
  it('沒有日期與資料夾', () => {
    expect(dayOf(file('readme.txt'))).toBe(NO_DAY);
    expect(dayOf(file('threat', { dir: true }))).toBe('');
  });
});

describe('groupDays / countFiles / filterFiles', () => {
  const items = [
    file('threat', { dir: true, isLog: false }),
    file('a_2026_11_02_last_calendar_day_0.csv', { state: 'done', day: '2026-11-01', size: 10 }),
    file('a_2026_11_02_last_calendar_day_1.csv', { size: 20 }),
    file('a_2026_11_03_last_calendar_day_0.csv', { state: 'error', size: 30 }),
    file('noday.log', { size: 1 }),
    file('readme.txt', { isLog: false, size: 5 }),
  ];

  it('日期新的在前、無日期最後;資料夾與非 log 不算', () => {
    expect(groupDays(items).map((d) => [d.day, d.files, d.done, d.size])).toEqual([
      ['2026-11-02', 1, 0, 30],
      ['2026-11-01', 2, 1, 30],
      [NO_DAY, 1, 0, 1],
    ]);
  });

  it('統計只算 log 檔', () => {
    expect(countFiles(items)).toEqual({ files: 4, size: 61, done: 1, pending: 2, error: 1 });
  });

  it('日期篩選保留資料夾;狀態篩選不含資料夾', () => {
    expect(filterFiles(items, { day: '2026-11-01', keyword: '', state: '' }).map((f) => f.name)).toEqual([
      'threat',
      'a_2026_11_02_last_calendar_day_0.csv',
      'a_2026_11_02_last_calendar_day_1.csv',
    ]);
    expect(filterFiles(items, { day: '', keyword: '', state: 'error' }).map((f) => f.name)).toEqual(['a_2026_11_03_last_calendar_day_0.csv']);
    expect(filterFiles(items, { day: '', keyword: 'README', state: '' }).map((f) => f.name)).toEqual(['readme.txt']);
  });
});

describe('analyzableDir', () => {
  // D1 驗收 2026-11-05 §3.1:FTP_LOG_DIR 以外的目錄(例如 /my-data)分析時一定被略過,不給勾選
  it('TRAFFIC 目錄與各類型 log 目錄可以分析', () => {
    expect(analyzableDir({ path: '/my-data', type: '', logDir: '/my-data' })).toBe(true);
    expect(analyzableDir({ path: '/threat', type: 'threat', logDir: '/my-data' })).toBe(true);
  });
  it('其他目錄、TRAFFIC 的子目錄與尚未載入時不能分析', () => {
    expect(analyzableDir({ path: '/my-data', type: '', logDir: '/' })).toBe(false);
    expect(analyzableDir({ path: '/my-data/old', type: '', logDir: '/my-data' })).toBe(false);
    expect(analyzableDir(null)).toBe(false);
  });
});

describe('其他', () => {
  it('麵包屑', () => {
    expect(crumbsOf('/a/b')).toEqual([
      { name: '/', path: '/' },
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' },
    ]);
    expect(crumbsOf('/')).toEqual([{ name: '/', path: '/' }]);
  });

  it('進度含失敗;沒有工作為 0', () => {
    expect(progressPct({ total: 4, done: 1, failed: 1 })).toBe(50);
    expect(progressPct({ total: 0, done: 0, failed: 0 })).toBe(0);
    expect(progressPct(null)).toBe(0);
  });

  it('分批', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('AD:Security 全部 0 筆的日期(未匯入的不算)', () => {
    const day = (d: string, state: AdDay['state'], rows: (number | null)[]): AdDay => ({
      day: d,
      path: `/AD/${d}`,
      state,
      events: null,
      importedAt: null,
      files: rows.map((r, i) => ({ name: `Security_DC${i}.csv`, size: 1, modified: null, channel: 'Security', rows: r, error: '' })),
    });
    expect(securityEmptyDays([day('2026-11-01', 'done', [0, 0]), day('2026-11-02', 'done', [0, 3]), day('2026-11-03', 'new', [null])])).toEqual(['2026-11-01']);
  });
});
