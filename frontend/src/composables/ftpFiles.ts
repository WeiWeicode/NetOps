/**
 * FTP Log 檔案頁的純函式(畫面與測試共用;規則同舊版 src/views/FtpFiles.vue、AdFiles.vue)
 */
import type { AdDay, PaFile, PaFileState, PaListing } from '@/api/ftp';

export const NO_DAY = '(無日期)';

/** 檔案狀態的顯示 */
export const PA_STATE: Record<PaFileState, { label: string; tone: string }> = {
  new: { label: '未分析', tone: 'neutral' },
  changed: { label: '已變更', tone: 'warning' },
  queued: { label: '排隊中', tone: 'info' },
  running: { label: '分析中', tone: 'primary' },
  done: { label: '已分析', tone: 'success' },
  error: { label: '失敗', tone: 'danger' },
};

export const AD_STATE: Record<AdDay['state'], { label: string; tone: string }> = {
  new: { label: '未匯入', tone: 'neutral' },
  changed: { label: '已變更', tone: 'warning' },
  done: { label: '已匯入', tone: 'success' },
  orphan: { label: 'FTP 上已無', tone: 'danger' },
};

/**
 * 檔案的資料日期 YYYY-MM-DD:已分析的用資料時間(day);未分析的從檔名推算。
 * PA 匯出檔名是匯出日(PA-560_traffic_2026_10_16_last_calendar_day_0.csv = 10/15 的資料),last_calendar_day 往前一天。
 */
export function dayOf(f: Pick<PaFile, 'dir' | 'day' | 'name'>): string {
  if (f.dir) return '';
  if (f.day) return f.day;
  const m = f.name.match(/(\d{4})[_-](\d{2})[_-](\d{2})/);
  if (!m) return NO_DAY;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (/last_calendar_day/i.test(f.name)) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface DayGroup {
  day: string;
  files: number;
  done: number;
  size: number;
}

/** 日期清單(新的在前;「無日期」排最後) */
export function groupDays(items: PaFile[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const f of items) {
    if (f.dir || !f.isLog) continue;
    const d = dayOf(f);
    const v = map.get(d) ?? { day: d, files: 0, done: 0, size: 0 };
    v.files++;
    v.size += f.size;
    if (f.state === 'done') v.done++;
    map.set(d, v);
  }
  return [...map.values()].sort((a, b) => (a.day === NO_DAY ? 1 : b.day === NO_DAY ? -1 : b.day.localeCompare(a.day)));
}

/** log 檔統計(目錄、非 log 不算) */
export function countFiles(items: PaFile[]) {
  const c = { files: 0, size: 0, done: 0, pending: 0, error: 0 };
  for (const f of items) {
    if (!f.isLog) continue;
    c.files++;
    c.size += f.size;
    if (f.state === 'done') c.done++;
    else if (f.state === 'error') c.error++;
    else c.pending++;
  }
  return c;
}

/** 目前日期、檔名關鍵字與狀態篩選後的清單;資料夾一律保留(狀態篩選時除外) */
export function filterFiles(items: PaFile[], f: { day: string; keyword: string; state: string }): PaFile[] {
  const k = f.keyword.trim().toLowerCase();
  return items.filter(
    (x) => (x.dir || !f.day || dayOf(x) === f.day) && (!k || x.name.toLowerCase().includes(k)) && (!f.state || (!x.dir && x.state === f.state)),
  );
}

/**
 * 目前目錄的檔案能不能分析:後端只分析 TRAFFIC 目錄(FTP_LOG_DIR)直屬與各類型 log 目錄的檔案(isTrafficLog / eventLogType),
 * 其他目錄(例如 FTP_LOG_DIR 之外的 /my-data)只能瀏覽,不顯示勾選框(D1 驗收 2026-11-05 §3.1)
 */
export const analyzableDir = (l: Pick<PaListing, 'path' | 'type' | 'logDir'> | null | undefined): boolean => !!l && (!!l.type || l.path === l.logDir);

/** FTP 路徑麵包屑:[{ name: '/', path: '/' }, { name: 'threat', path: '/threat' }, …] */
export function crumbsOf(dir: string): { name: string; path: string }[] {
  const parts = dir.split('/').filter(Boolean);
  return [{ name: '/', path: '/' }, ...parts.map((p, i) => ({ name: p, path: `/${parts.slice(0, i + 1).join('/')}` }))];
}

/** 分析進度百分比 */
export const progressPct = (j: { total: number; done: number; failed: number } | null | undefined): number =>
  j?.total ? Math.round(((j.done + j.failed) / j.total) * 100) : 0;

/** AD:已匯入但 Security 檔案全部是 0 筆的日期(DC 的記錄被覆蓋或沒開稽核) */
export function securityEmptyDays(days: AdDay[]): string[] {
  return days
    .filter((d) => {
      if (d.state === 'new') return false;
      const sec = d.files.filter((f) => f.channel === 'Security');
      return sec.length > 0 && sec.every((f) => (f.rows ?? 0) === 0);
    })
    .map((d) => d.day);
}

/** 依 size 切成多批(API 單次上限) */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
