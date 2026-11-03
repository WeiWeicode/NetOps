/**
 * PA TRAFFIC log 匯入(由舊版 server/lib/importer.js 搬移,IMPL-PLAN B2;流程不變,研判在 core/palog.js 不動):
 *   從 FTP 串流讀取每個檔案、算出摘要與連線組合統計,只透過 store 寫入(原始 log 不存本機,ARCHITECTURE §4)
 *   檔案大小、修改時間或 SUMMARY_VERSION 變了會重新分析
 * 與舊版不同:同時分析的檔案數 = FTP_MAX_CONNECTIONS(與明細查詢共用連線上限);自動同步由 start() / stop() 控制;
 *   讀取失敗時立即中斷 FTP 傳輸(舊版會留著連線);佇列有上限 MAX_QUEUE;寫檔失敗的訊息不帶本機路徑。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { FtpConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { cancelledError, type Ftp, type FtpEntry, type FtpStream } from '../../infra/ftp/index.js';
import type { PaStore } from '../../infra/store/index.js';
import { createFlowStats, flowFileName } from './core/flows.js';
import { createSummary, readLog, SUMMARY_VERSION } from './core/palog.js';

export interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** FTP 檔案的分析狀態(index.json 的一筆,格式同舊版) */
export interface FileState {
  name: string;
  size: number;
  modified: string;
  status: 'done' | 'error';
  error: string;
  v?: number;
  analyzedAt: string;
  ms?: number;
  rows?: number;
  day?: string;
  timeMin?: string;
  timeMax?: string;
  summary?: string;
  flows?: string;
  flowCount?: number;
}

export interface QueueItem {
  path: string;
  name: string;
  size: number;
  modified: string | Date | null;
}

interface Running extends QueueItem {
  read: number;
  rows: number;
  startedAt: number;
  controller: AbortController;
}

/** 佇列上限(每類型);一天約 150 個檔案,保留補分析多天的空間 */
export const MAX_QUEUE = 5000;

export type FileListState = 'new' | 'changed' | 'done' | 'error' | 'queued' | 'running';

export interface RemoteFile extends FtpEntry {
  isLog: boolean;
  state: FileListState;
  rows: number | null;
  day: string;
  timeMin: string;
  timeMax: string;
  analyzedAt: string | null;
  ms: number | null;
  error: string;
}

export const sumName = (p: string) =>
  `${path.posix.basename(p).replace(/[^\w.-]+/g, '_').slice(0, 80)}-${crypto.createHash('md5').update(p).digest('hex').slice(0, 8)}.json`;
/** 修改時間 → ISO 字串;無法解析時回 ''(不丟例外) */
export const modKey = (d: string | Date | null | undefined) => {
  const t = d ? new Date(d).getTime() : Number.NaN;
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
};

/** 存進分析狀態、回給畫面的錯誤訊息:本機檔案錯誤(帶路徑)不外露,細節只寫日誌(ARCHITECTURE §4.2) */
export const errorText = (err: unknown) =>
  err instanceof AppError || !(err as NodeJS.ErrnoException).path ? (err as Error).message : '寫入分析結果失敗(詳見服務日誌)';

/** 佇列已滿 */
export const queueFull = () => new AppError(409, 'NETOPS_IMPORT_QUEUE_FULL', `分析佇列已滿(上限 ${MAX_QUEUE} 個檔案),請等候目前的分析完成`);

export type TrafficImporter = ReturnType<typeof createTrafficImporter>;

export function createTrafficImporter({ ftp, store, ftpConfig, log }: { ftp: Ftp; store: PaStore; ftpConfig: FtpConfig | null; log: Log }) {
  const index = store.loadIndex<FileState>();
  const parallel = ftpConfig?.maxConnections ?? 1;

  let saveTimer: NodeJS.Timeout | null = null;
  function saveIndex(now = false) {
    const write = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      store.saveIndex(index);
    };
    if (now) return write();
    saveTimer ??= setTimeout(write, 1000).unref();
  }

  /* ───────── 工作佇列 ───────── */

  const job = {
    queue: [] as QueueItem[],
    /** 佇列中的路徑(去重) */
    queued: new Set<string>(),
    running: new Map<string, Running>(),
    total: 0,
    done: 0,
    failed: 0,
    startedAt: null as string | null,
    finishedAt: null as string | null,
    lastSyncAt: null as string | null,
    lastSyncError: '',
    /** 正在列出 FTP 目錄(同步在背景執行,畫面依此顯示「同步中」) */
    syncing: false,
  };

  function status() {
    return {
      busy: job.running.size > 0 || job.queue.length > 0,
      total: job.total,
      done: job.done,
      failed: job.failed,
      queued: job.queue.length,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      lastSyncAt: job.lastSyncAt,
      lastSyncError: job.lastSyncError,
      syncing: job.syncing,
      autoSyncMinutes: ftpConfig?.syncMinutes ?? 0,
      running: [...job.running.values()].map((r) => ({ path: r.path, name: r.name, size: r.size, read: r.read, rows: r.rows, seconds: Math.round((Date.now() - r.startedAt) / 1000) })),
    };
  }

  async function analyze(item: QueueItem) {
    const controller = new AbortController();
    const run: Running = { path: item.path, name: item.name, size: item.size, modified: item.modified, read: 0, rows: 0, startedAt: Date.now(), controller };
    job.running.set(item.path, run);
    const t0 = Date.now();
    let opened: FtpStream | null = null;
    try {
      opened = await ftp.openStream(item.path, { signal: controller.signal });
      const { stream, done } = opened;
      stream.on('data', (chunk: Buffer) => (run.read += chunk.length));
      const sum = createSummary();
      const flows = createFlowStats();
      const { bad } = await readLog(stream, item.name, (r: Record<string, unknown>) => {
        sum.add(r);
        flows.add(r);
        run.rows++;
      });
      await done;
      // 中斷或傳輸不完整時串流也會「正常結束」,不能把不完整的摘要當成已分析
      if (controller.signal.aborted) throw cancelledError();
      if (item.size && run.read < item.size) throw new Error(`FTP 傳輸不完整(${run.read} / ${item.size} bytes)`);
      const result = { file: item.path, name: item.name, size: item.size, modified: item.modified, analyzedAt: new Date().toISOString(), bad, ...sum.result() };
      const file = sumName(item.path);
      store.saveSummary(file, result);
      const flowFile = flowFileName(file);
      const fl = flows.serialize();
      if (fl.overflow) store.removeFlows(flowFile);
      else store.saveFlows(flowFile, fl.text);
      summaryCache.delete(file);
      index.files[item.path] = {
        name: item.name,
        size: item.size,
        modified: modKey(item.modified),
        status: 'done',
        error: '',
        v: SUMMARY_VERSION,
        analyzedAt: result.analyzedAt,
        ms: Date.now() - t0,
        rows: result.rows,
        day: result.day,
        timeMin: result.timeMin,
        timeMax: result.timeMax,
        summary: file,
        // 連線組合統計:組合數;組合太多(overflow)時沒有統計檔,問答改掃 FTP
        flows: fl.overflow ? '' : flowFile,
        flowCount: fl.flows,
      };
      job.done++;
    } catch (err) {
      // 讀取失敗(標頭不對、解析例外)時中斷傳輸,釋放 FTP 連線
      opened?.abort();
      // 取消的檔案維持原本狀態(下次同步再分析)
      if (controller.signal.aborted) return;
      log.error({ file: item.path, err }, '[匯入] 分析失敗');
      index.files[item.path] = { ...(index.files[item.path] ?? {}), name: item.name, size: item.size, modified: modKey(item.modified), status: 'error', error: errorText(err), analyzedAt: new Date().toISOString() };
      job.failed++;
    } finally {
      job.running.delete(item.path);
      saveIndex();
    }
  }

  const inflight = new Set<Promise<void>>();
  function pump() {
    while (job.running.size < parallel && job.queue.length) {
      const item = job.queue.shift()!;
      job.queued.delete(item.path);
      const p: Promise<void> = analyze(item)
        .catch((err) => log.error({ file: item.path, err }, '[匯入] 非預期錯誤'))
        .finally(() => {
          inflight.delete(p);
          pump();
        });
      inflight.add(p);
    }
    if (!job.running.size && !job.queue.length && job.startedAt && !job.finishedAt) {
      job.finishedAt = new Date().toISOString();
      saveIndex(true);
    }
  }

  /** 加入分析佇列(已在佇列或分析中的會略過) */
  function enqueue(items: QueueItem[]) {
    const fresh = items.filter((it) => !job.running.has(it.path) && !job.queued.has(it.path));
    if (job.queue.length + fresh.length > MAX_QUEUE) throw queueFull();
    if (!job.running.size && !job.queue.length) Object.assign(job, { total: 0, done: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null });
    let added = 0;
    for (const it of fresh) {
      if (job.queued.has(it.path)) continue;
      job.queue.push(it);
      job.queued.add(it.path);
      added++;
    }
    job.total += added;
    pump();
    return added;
  }

  /** 取消:清空佇列並中斷分析中的檔案 */
  function cancel() {
    const n = job.queue.length + job.running.size;
    job.queue = [];
    job.queued.clear();
    for (const r of job.running.values()) r.controller.abort();
    return n;
  }

  /* ───────── FTP 檔案清單 ───────── */

  /**
   * FTP 上的檔案搬到別的資料夾:檔名與大小相同就沿用原本的分析結果,只更新路徑,不重新分析
   * PA 匯出檔名含日期與序號,同名同大小即為同一個檔案
   */
  function migrateMoved(list: FtpEntry[]) {
    const here = new Set(list.map((f) => f.path));
    const byName = new Map<string, string>();
    for (const [p, st] of Object.entries(index.files)) if (!here.has(p) && st.status === 'done') byName.set(path.posix.basename(p), p);
    let moved = 0;
    for (const f of list) {
      if (f.dir || index.files[f.path]) continue;
      const old = byName.get(f.name);
      if (!old || index.files[old]!.size !== f.size) continue;
      index.files[f.path] = { ...index.files[old]!, modified: modKey(f.modified) };
      delete index.files[old];
      moved++;
    }
    if (moved) {
      log.info({ moved }, '[匯入] 已分析的檔案在 FTP 上搬了位置,已更新路徑(不重新分析)');
      saveIndex(true);
    }
  }

  /** FTP 目錄的檔案 + 分析狀態 */
  async function listRemote(dir?: string): Promise<RemoteFile[]> {
    const re = ftpConfig?.pattern ?? /\.(csv|log|txt|gz)$/i;
    const target = dir ?? ftpConfig?.logDir ?? '/';
    const list = await ftp.listDir(target);
    // 只在 TRAFFIC 目錄比對搬移;瀏覽其他資料夾不改分析狀態
    if (target === ftpConfig?.logDir) migrateMoved(list);
    return list.map((f) => {
      const st = index.files[f.path];
      let state: FileListState = 'new';
      if (job.running.has(f.path)) state = 'running';
      else if (job.queued.has(f.path)) state = 'queued';
      else if (st) state = st.status === 'error' ? 'error' : st.size === f.size && st.modified === modKey(f.modified) && st.v === SUMMARY_VERSION ? 'done' : 'changed';
      return {
        ...f,
        isLog: !f.dir && re.test(f.name),
        state,
        rows: st?.rows ?? null,
        day: st?.day ?? '',
        timeMin: st?.timeMin ?? '',
        timeMax: st?.timeMax ?? '',
        analyzedAt: st?.analyzedAt ?? null,
        ms: st?.ms ?? null,
        error: st?.error ?? '',
      };
    });
  }

  /** 同步:FTP_LOG_DIR 裡符合 FTP_PATTERN、還沒分析或已變更的檔案加入佇列 */
  async function sync() {
    if (job.syncing) return { found: 0, added: 0, busy: true };
    job.syncing = true;
    try {
      const list = await listRemote();
      const items = list.filter((f) => f.isLog && ['new', 'changed', 'error'].includes(f.state));
      job.lastSyncAt = new Date().toISOString();
      job.lastSyncError = '';
      return { found: list.filter((f) => f.isLog).length, added: enqueue(items) };
    } catch (err) {
      job.lastSyncAt = new Date().toISOString();
      job.lastSyncError = errorText(err);
      throw err;
    } finally {
      job.syncing = false;
    }
  }

  /* ───────── 自動同步 ───────── */

  const timers: NodeJS.Timeout[] = [];
  function start() {
    if (!ftpConfig || ftpConfig.syncMinutes <= 0) return;
    // 失敗(例如啟動時剛好連不上 FTP)2 分鐘後再試一次,不必等到下一個週期
    const tick = (retry = true) =>
      sync().then(
        (r) => r.added && log.info({ added: r.added }, '[自動同步] 新增檔案待分析'),
        (err) => {
          log.error({ err: (err as Error).message, retry }, '[自動同步] 失敗');
          if (retry) timers.push(setTimeout(() => tick(false), 120000).unref());
        },
      );
    timers.push(setTimeout(tick, 15000).unref(), setInterval(tick, ftpConfig.syncMinutes * 60000).unref());
  }
  /** 停止自動同步並中止分析;等分析中的檔案真正停止後才寫入分析狀態 */
  async function stop() {
    for (const t of timers.splice(0)) clearTimeout(t);
    cancel();
    await Promise.allSettled([...inflight]);
    saveIndex(true);
  }

  /** 檔案是不是 TRAFFIC log(在 TRAFFIC 目錄下、符合檔名規則) */
  const isTrafficLog = (p: string) => Boolean(ftpConfig) && path.posix.dirname(p) === ftpConfig!.logDir && ftpConfig!.pattern.test(path.posix.basename(p));

  /* ───────── 已分析的摘要 ───────── */

  /** 已分析完成的檔案(依資料時間排序) */
  function analyzedFiles() {
    return Object.entries(index.files)
      .filter(([, v]) => v.status === 'done')
      .map(([p, v]) => ({ path: p, ...v }))
      .sort((a, b) => (a.timeMin || '').localeCompare(b.timeMin || '') || a.name.localeCompare(b.name, 'en', { numeric: true }));
  }

  /** 有資料的日期(資料時間,不是檔名日期):[{ day, files, rows }] */
  function availableDays() {
    const days = new Map<string, { day: string; files: number; rows: number }>();
    for (const f of analyzedFiles()) {
      if (!f.day) continue;
      const d = days.get(f.day) ?? { day: f.day, files: 0, rows: 0 };
      d.files++;
      d.rows += f.rows || 0;
      days.set(f.day, d);
    }
    return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
  }

  /** 資料時間與 [from, to] 有重疊的檔案;from / to 為 'yyyy/MM/dd' 或 'yyyy/MM/dd HH:mm' */
  function filesInRange(from: string, to: string) {
    const end = to && to.length <= 10 ? `${to} 23:59:59` : to ? `${to}:59` : '';
    return analyzedFiles().filter((f) => (!from || (f.timeMax || '') >= from) && (!end || (f.timeMin || '') <= end));
  }

  const summaryCache = new Map<string, unknown>();
  /** 摘要;資料檔不存在回 null(呼叫端算進缺少的檔案) */
  function readSummary(file: string) {
    if (summaryCache.has(file)) return summaryCache.get(file) ?? null;
    const s = store.readSummary(file);
    if (!s) return null;
    if (summaryCache.size > 400) summaryCache.delete(summaryCache.keys().next().value!);
    summaryCache.set(file, s);
    return s;
  }

  /** 刪除摘要(之後同步會重新分析) */
  function forget(paths: string[]) {
    let n = 0;
    for (const p of paths) {
      const st = index.files[p];
      if (!st) continue;
      if (st.summary) {
        store.removeSummary(st.summary);
        summaryCache.delete(st.summary);
      }
      if (st.flows) store.removeFlows(st.flows);
      delete index.files[p];
      n++;
    }
    saveIndex(true);
    return n;
  }

  return { status, enqueue, cancel, listRemote, sync, start, stop, isTrafficLog, analyzedFiles, availableDays, filesInRange, readSummary, forget };
}
