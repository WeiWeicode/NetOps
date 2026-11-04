/**
 * 假 Gateway:FTP Log 檔案(docs/API.md §5)。資料只在記憶體,重新啟動 dev server 即還原。
 * 同步 / 分析 / 匯入以計時器模擬背景執行,畫面可看到進度與狀態變化。
 */
import type { MockCtx } from './types.ts';

// ---------- PA ----------
const LOG_DIR = '/';
const EVENT_DIRS = [
  { type: 'threat', label: '威脅', dir: '/threat' },
  { type: 'url', label: 'URL 過濾', dir: '/url' },
  { type: 'globalprotect', label: 'GlobalProtect', dir: '/globalprotect' },
];

interface PaFile {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: string;
  isLog: boolean;
  state: string;
  rows: number | null;
  day: string | null;
  timeMin: string | null;
  timeMax: string | null;
  analyzedAt: string | null;
  ms: number | null;
  error: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function makeDir(dir: string, kind: string): PaFile[] {
  const out: PaFile[] = [];
  const today = new Date();
  for (let back = 1; back <= 6; back++) {
    const exp = new Date(today);
    exp.setDate(exp.getDate() - back + 1);
    const data = new Date(exp);
    data.setDate(data.getDate() - 1);
    const n = kind === 'traffic' ? 4 : 1;
    for (let i = 0; i < n; i++) {
      const name = `PA-560_${kind}_${exp.getFullYear()}_${pad(exp.getMonth() + 1)}_${pad(exp.getDate())}_last_calendar_day_${i}.csv`;
      const done = back > 2 || i > 1;
      const failed = back === 3 && i === 0 && kind === 'traffic';
      const day = ymd(data);
      out.push({
        name,
        path: `${dir === '/' ? '' : dir}/${name}`,
        dir: false,
        size: 40_000_000 + ((back * 7 + i * 13) % 9) * 3_100_000,
        modified: new Date(exp.getTime() + 5 * 60_000).toISOString(),
        isLog: true,
        state: failed ? 'error' : done ? 'done' : back === 1 ? 'new' : 'changed',
        rows: done && !failed ? 180_000 + i * 2_345 : null,
        day: done && !failed ? day : null,
        timeMin: done && !failed ? `${day}T00:00:03+08:00` : null,
        timeMax: done && !failed ? `${day}T23:59:58+08:00` : null,
        analyzedAt: done ? new Date(exp.getTime() + 6 * 60_000).toISOString() : null,
        ms: done ? 3456 + i * 120 : null,
        error: failed ? 'FTP 讀取逾時(25 秒內沒有資料)' : '',
      });
    }
  }
  out.push({
    name: 'readme.txt',
    path: `${dir === '/' ? '' : dir}/readme.txt`,
    dir: false,
    size: 812,
    modified: today.toISOString(),
    isLog: false,
    state: 'new',
    rows: null,
    day: null,
    timeMin: null,
    timeMax: null,
    analyzedAt: null,
    ms: null,
    error: '',
  });
  return out;
}

const pa: Record<string, PaFile[]> = {
  '/': [...EVENT_DIRS.map((d) => ({ ...folder(d.dir) })), folder('/archive'), ...makeDir('/', 'traffic')],
  '/threat': makeDir('/threat', 'threat'),
  '/url': makeDir('/url', 'url'),
  '/globalprotect': makeDir('/globalprotect', 'globalprotect'),
  '/archive': [],
};
function folder(path: string): PaFile {
  return {
    name: path.split('/').pop()!,
    path,
    dir: true,
    size: 0,
    modified: new Date().toISOString(),
    isLog: false,
    state: 'new',
    rows: null,
    day: null,
    timeMin: null,
    timeMax: null,
    analyzedAt: null,
    ms: null,
    error: '',
  };
}

function emptyStatus() {
  return {
    busy: false,
    total: 0,
    done: 0,
    failed: 0,
    queued: 0,
    startedAt: null as string | null,
    finishedAt: null as string | null,
    lastSyncAt: null as string | null,
    lastSyncError: '',
    syncing: false,
    autoSyncMinutes: 0,
    running: [] as unknown[],
  };
}
const paStatus = { traffic: emptyStatus(), events: emptyStatus() };
let paQueue: PaFile[] = [];
let paTimer: ReturnType<typeof setInterval> | undefined;

const allPa = () => Object.values(pa).flat();
const kindOf = (f: PaFile) => (EVENT_DIRS.some((d) => f.path.startsWith(`${d.dir}/`)) ? 'events' : 'traffic');

function enqueue(files: PaFile[]) {
  for (const f of files) {
    if (paQueue.includes(f)) continue;
    f.state = 'queued';
    paQueue.push(f);
    const s = paStatus[kindOf(f)];
    if (!s.busy) Object.assign(s, { total: 0, done: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null });
    s.total++;
    s.busy = true;
  }
  refreshQueued();
  if (!paTimer) paTimer = setInterval(tick, 1200);
}
function refreshQueued() {
  for (const k of ['traffic', 'events'] as const) {
    const s = paStatus[k];
    const q = paQueue.filter((f) => kindOf(f) === k);
    s.queued = q.filter((f) => f.state === 'queued').length;
    s.running = q
      .filter((f) => f.state === 'running')
      .map((f) => ({ path: f.path, name: f.name, size: f.size, read: Math.round(f.size * 0.4), rows: 72_000, seconds: 2 }));
  }
}
function tick() {
  for (const k of ['traffic', 'events'] as const) {
    const s = paStatus[k];
    const running = paQueue.find((f) => kindOf(f) === k && f.state === 'running');
    if (running) {
      paQueue = paQueue.filter((f) => f !== running);
      // 檔名是匯出日,資料是前一天
      const [, y, mo, d] = running.name.match(/(\d{4})_(\d{2})_(\d{2})/) ?? [];
      const day = ymd(new Date(Number(y), Number(mo) - 1, Number(d) - 1));
      Object.assign(running, {
        state: 'done',
        rows: 181_234,
        day,
        timeMin: `${day}T00:00:02+08:00`,
        timeMax: `${day}T23:59:59+08:00`,
        analyzedAt: new Date().toISOString(),
        ms: 2400,
        error: '',
      });
      s.done++;
    }
    const next = paQueue.find((f) => kindOf(f) === k && f.state === 'queued');
    if (next) next.state = 'running';
    else if (!paQueue.some((f) => kindOf(f) === k)) {
      if (s.busy) s.finishedAt = new Date().toISOString();
      s.busy = false;
    }
  }
  refreshQueued();
  if (!paQueue.length) {
    clearInterval(paTimer);
    paTimer = undefined;
  }
}

// ---------- AD ----------
const AD_DIR = '/AD_Log_Backup';
const adDays = Array.from({ length: 14 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - i - 1);
  const day = ymd(d);
  const state = i === 0 ? 'new' : i === 1 ? 'changed' : i === 13 ? 'orphan' : 'done';
  const emptySec = i === 4;
  const files = ['Security', 'System', 'Directory_Service', 'DNS_Server'].map((channel, k) => ({
    name: `${channel}_GSMC-DC1.csv`,
    size: [1_234_567, 234_567, 34_567, 98_765][k]!,
    modified: new Date(d.getTime() + 86_400_000 + 60_000).toISOString(),
    channel,
    rows: state === 'new' ? null : channel === 'Security' && emptySec ? 0 : [5000, 420, 33, 210][k]!,
    error: i === 6 && channel === 'DNS_Server' ? '欄位數不符(第 12 列)' : '',
  }));
  return {
    day,
    path: `${AD_DIR}/${day.replace(/-/g, '')}`,
    state,
    events: state === 'new' ? null : files.reduce((a, f) => a + (f.rows ?? 0), 0),
    importedAt: state === 'new' ? null : new Date(d.getTime() + 86_400_000 + 600_000).toISOString(),
    files: state === 'orphan' ? [] : files,
  };
});
const adStatus = {
  running: false,
  dir: AD_DIR,
  autoSyncMinutes: 0,
  lastSyncAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastSyncError: '',
  lastResult: { days: adDays.length, imported: [] as { day: string; events: number }[] },
};

function adRun(days: string[]) {
  adStatus.running = true;
  setTimeout(() => {
    const imported: { day: string; events: number }[] = [];
    for (const d of adDays) {
      if (!days.includes(d.day) || d.state === 'orphan') continue;
      d.files.forEach((f) => (f.rows = f.rows ?? 100));
      d.events = d.files.reduce((a, f) => a + (f.rows ?? 0), 0);
      d.state = 'done';
      d.importedAt = new Date().toISOString();
      imported.push({ day: d.day, events: d.events });
    }
    Object.assign(adStatus, { running: false, lastSyncAt: new Date().toISOString(), lastResult: { days: adDays.length, imported } });
  }, 4000);
}

/** 共用的工作清單(假 Gateway 不分使用者;清單工作 3 秒後完成) */
const jobs = new Map<
  string,
  {
    id: string;
    kind: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    progress: null;
    error: null;
    result: unknown;
    doneAt: number;
  }
>();
function jobView(id: string) {
  const j = jobs.get(id);
  if (!j) return null;
  if (j.status === 'running' && Date.now() >= j.doneAt)
    Object.assign(j, { status: 'done', finishedAt: new Date().toISOString(), result: { dir: AD_DIR, days: adDays } });
  const { doneAt: _d, ...view } = j;
  return view;
}

export function handleFtp({ method, path, url, body, need, send, fail }: MockCtx): boolean {
  if (!path.startsWith('/api/netops/ftp/')) return false;
  const p = path.slice('/api/netops/ftp'.length);
  const read = () => need('netops.ftp.read');
  const write = () => need('netops.ftp.write');

  // PA
  if (method === 'GET' && p === '/pa/files') {
    if (!read()) return true;
    const dir = url.searchParams.get('path') || LOG_DIR;
    if (!(dir in pa)) return (fail(403, 'NETOPS_FTP_PATH_FORBIDDEN', `不可瀏覽 ${dir}`), true);
    const type = EVENT_DIRS.find((d) => d.dir === dir)?.type ?? '';
    return (send(200, { path: dir, type, root: '/', logDir: LOG_DIR, pattern: '\\.(csv|log|txt|gz)$', eventDirs: EVENT_DIRS, items: pa[dir] }), true);
  }
  if (method === 'GET' && p === '/pa/status') return (read() && send(200, paStatus), true);
  if (method === 'POST' && p === '/pa/syncs') {
    if (!write()) return true;
    const now = new Date().toISOString();
    paStatus.traffic.lastSyncAt = now;
    paStatus.events.lastSyncAt = now;
    enqueue(allPa().filter((f) => f.isLog && (f.state === 'new' || f.state === 'changed' || f.state === 'error')));
    return (send(202, paStatus), true);
  }
  if (method === 'POST' && p === '/pa/analyses') {
    if (!write()) return true;
    const paths = ((body as { items?: { path: string }[] })?.items ?? []).map((i) => i.path);
    if (!paths.length || paths.length > 500) return (fail(400, 'VALIDATION_FAILED', 'items 需要 1–500 筆'), true);
    const files = allPa().filter((f) => f.isLog && paths.includes(f.path));
    enqueue(files);
    return (send(200, { added: files.length, skipped: paths.length - files.length }), true);
  }
  if (method === 'DELETE' && p === '/pa/analyses') {
    if (!write()) return true;
    const n = paQueue.length;
    for (const f of paQueue) f.state = f.analyzedAt ? 'done' : 'new';
    paQueue = [];
    for (const s of Object.values(paStatus)) Object.assign(s, { busy: false, queued: 0, running: [], finishedAt: new Date().toISOString() });
    return (send(200, { cancelled: n }), true);
  }
  if (method === 'POST' && p === '/pa/result-deletions') {
    if (!write()) return true;
    const paths = (body as { paths?: string[] })?.paths ?? [];
    let deleted = 0;
    for (const f of allPa())
      if (paths.includes(f.path) && (f.state === 'done' || f.state === 'error')) {
        Object.assign(f, { state: 'new', rows: null, day: null, timeMin: null, timeMax: null, analyzedAt: null, ms: null, error: '' });
        deleted++;
      }
    return (send(200, { deleted }), true);
  }

  // AD
  if (method === 'POST' && p === '/ad/listings') {
    if (!read()) return true;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    jobs.set(id, {
      id,
      kind: 'ad-ftp-listing',
      status: 'running',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      progress: null,
      error: null,
      result: null,
      doneAt: Date.now() + 3000,
    });
    return (send(202, jobView(id)), true);
  }
  const m = p.match(/^\/ad\/listings\/([^/]+)$/);
  if (m) {
    if (!read()) return true;
    if (method === 'DELETE') {
      const j = jobs.get(m[1]!);
      if (j && j.status === 'running') Object.assign(j, { status: 'cancelled', finishedAt: new Date().toISOString() });
      return (send(204, null), true);
    }
    const v = jobView(m[1]!);
    return (v ? send(200, v) : fail(404, 'NETOPS_JOB_NOT_FOUND', '工作不存在或已失效'), true);
  }
  if (method === 'GET' && p === '/ad/status') return (read() && send(200, adStatus), true);
  if (method === 'POST' && p === '/ad/syncs') {
    if (!write()) return true;
    if (adStatus.running) return (fail(409, 'NETOPS_AD_SYNC_BUSY', 'AD 正在同步'), true);
    adRun(adDays.filter((d) => d.state === 'new' || d.state === 'changed').map((d) => d.day));
    return (send(202, adStatus), true);
  }
  if (method === 'POST' && p === '/ad/imports') {
    if (!write()) return true;
    const days = (body as { days?: string[] })?.days ?? [];
    if (!days.length || days.length > 60) return (fail(400, 'VALIDATION_FAILED', 'days 需要 1–60 天'), true);
    if (adStatus.running) return (fail(409, 'NETOPS_AD_SYNC_BUSY', 'AD 正在同步'), true);
    adRun(days);
    return (send(202, adStatus), true);
  }
  if (method === 'POST' && p === '/ad/result-deletions') {
    if (!write()) return true;
    const days = (body as { days?: string[] })?.days ?? [];
    let deleted = 0;
    for (const d of adDays)
      if (days.includes(d.day) && d.state !== 'new') {
        Object.assign(d, { state: 'new', events: null, importedAt: null });
        d.files.forEach((f) => (f.rows = null));
        deleted++;
      }
    return (send(200, { deleted }), true);
  }
  return false;
}
