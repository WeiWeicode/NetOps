/**
 * PA 其他類型 log 的匯入(由舊版 server/lib/paevimport.js 搬移,IMPL-PLAN B2;類型定義與研判在 core/paevents.js 不動)
 *   威脅、URL、資料過濾、WildFire、解密、GlobalProtect、User-ID;FTP 目錄見設定 FTP_*_DIR
 *   與 TRAFFIC 相同從 FTP 串流讀取,原始 log 不存本機;用 1 條 FTP 連線依序分析
 * AI 用的 eventsForIps / eventsContext 不搬移(ARCHITECTURE D17)。
 */
import path from 'node:path';
import type { EventType, FtpConfig } from '../../config.js';
import { cancelledError, type Ftp, type FtpStream } from '../../infra/ftp/index.js';
import type { PaStore } from '../../infra/store/index.js';
import { readLog } from '../pa/core/palog.js';
import { errorText, MAX_QUEUE, modKey, queueFull, sumName, type FileListState, type FileState, type Log, type QueueItem, type RemoteFile } from '../pa/importer.js';
import { createEventSummary, EVENT_TYPES, EVENT_VERSION, mergeEventSummaries } from './core/paevents.js';

interface EventFileState extends FileState {
  type: string;
  lines?: number;
  aggOverflow?: boolean;
}
interface EventItem extends QueueItem {
  type: string;
}
interface Running extends EventItem {
  read: number;
  rows: number;
  startedAt: number;
  controller: AbortController;
}

const LOG_RE = /\.(csv|gz)$/i;
// core/paevents.js 的類型定義(JS 推斷的型別太窄,這裡只取用到的欄位)
const TYPE_DEFS = EVENT_TYPES as unknown as Record<string, { label: string; columns: unknown; numeric?: unknown }>;

export type EventImporter = ReturnType<typeof createEventImporter>;

export function createEventImporter({ ftp, store, ftpConfig, log }: { ftp: Ftp; store: PaStore; ftpConfig: FtpConfig | null; log: Log }) {
  const index = store.loadEventIndex<EventFileState>();
  const saveIndex = () => store.saveEventIndex(index);

  /** 啟用的類型:[{ type, label, dir }] */
  const eventTypes = () =>
    Object.entries(TYPE_DEFS)
      .map(([type, def]) => ({ type, label: def.label, dir: ftpConfig?.eventDirs[type as EventType] ?? '' }))
      .filter((t) => t.dir);

  /** FTP 目錄 → 類型(不是這些目錄回傳 '') */
  const typeOfDir = (dir: string) => eventTypes().find((t) => t.dir === dir)?.type ?? '';

  /* ───────── 工作佇列 ───────── */

  const job = {
    queue: [] as EventItem[],
    queued: new Set<string>(),
    running: null as Running | null,
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
    const r = job.running;
    return {
      busy: Boolean(r) || job.queue.length > 0,
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
      running: r ? [{ path: r.path, name: r.name, type: r.type, size: r.size, read: r.read, rows: r.rows, seconds: Math.round((Date.now() - r.startedAt) / 1000) }] : [],
    };
  }

  async function analyze(item: EventItem) {
    const def = TYPE_DEFS[item.type]!;
    const controller = new AbortController();
    const run: Running = { ...item, read: 0, rows: 0, startedAt: Date.now(), controller };
    job.running = run;
    let opened: FtpStream | null = null;
    try {
      opened = await ftp.openStream(item.path, { signal: controller.signal });
      const { stream, done } = opened;
      stream.on('data', (chunk: Buffer) => (run.read += chunk.length));
      const sum = createEventSummary(item.type);
      const { bad } = await readLog(
        stream,
        item.name,
        (r: Record<string, unknown>) => {
          sum.add(r);
          run.rows++;
        },
        { columns: def.columns as null, numeric: def.numeric as Set<string> | undefined },
      );
      await done;
      if (controller.signal.aborted) throw cancelledError();
      if (item.size && run.read < item.size) throw new Error(`FTP 傳輸不完整(${run.read} / ${item.size} bytes)`);
      const r = sum.result() as { rows: number; lines: number; day: string; timeMin: string; timeMax: string; aggOverflow: boolean };
      const result = { file: item.path, name: item.name, size: item.size, modified: item.modified, analyzedAt: new Date().toISOString(), bad, ...r };
      const file = `${item.type}/${sumName(item.path)}.gz`;
      store.saveEventSummary(file, result);
      cache.delete(file);
      index.files[item.path] = {
        type: item.type,
        name: item.name,
        size: item.size,
        modified: modKey(item.modified),
        status: 'done',
        error: '',
        v: EVENT_VERSION,
        analyzedAt: result.analyzedAt,
        ms: Date.now() - run.startedAt,
        rows: result.rows,
        lines: result.lines,
        day: result.day,
        timeMin: result.timeMin,
        timeMax: result.timeMax,
        aggOverflow: result.aggOverflow,
        summary: file,
      };
      job.done++;
    } catch (err) {
      // 讀取失敗時中斷傳輸,釋放 FTP 連線
      opened?.abort();
      if (controller.signal.aborted) return;
      log.error({ type: item.type, file: item.path, err }, `[PA ${def.label}] 分析失敗`);
      index.files[item.path] = { ...(index.files[item.path] ?? {}), type: item.type, name: item.name, size: item.size, modified: modKey(item.modified), status: 'error', error: errorText(err), analyzedAt: new Date().toISOString() };
      job.failed++;
    } finally {
      job.running = null;
      saveIndex();
    }
  }

  let pumping: Promise<void> | null = null;
  function pump() {
    if (pumping) return;
    pumping = (async () => {
      while (job.queue.length) {
        const item = job.queue.shift()!;
        job.queued.delete(item.path);
        await analyze(item).catch((err) => log.error({ file: item.path, err }, '[PA 其他 log] 非預期錯誤'));
      }
      if (job.startedAt && !job.finishedAt) job.finishedAt = new Date().toISOString();
    })().finally(() => {
      pumping = null;
    });
  }

  /** 加入佇列 */
  function enqueue(items: EventItem[]) {
    const fresh = items.filter((it) => job.running?.path !== it.path && !job.queued.has(it.path));
    if (job.queue.length + fresh.length > MAX_QUEUE) throw queueFull();
    if (!job.running && !job.queue.length) Object.assign(job, { total: 0, done: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null });
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

  function cancel() {
    const n = job.queue.length + (job.running ? 1 : 0);
    job.queue = [];
    job.queued.clear();
    job.running?.controller.abort();
    return n;
  }

  /* ───────── FTP 檔案清單 ───────── */

  /** 類型目錄的檔案 + 分析狀態(與 TRAFFIC 相同格式,FTP Log 檔案頁共用) */
  async function listRemote(type: string): Promise<(RemoteFile & { type: string })[]> {
    const dir = ftpConfig?.eventDirs[type as EventType];
    if (!dir) return [];
    const list = await ftp.listDir(dir);
    return list.map((f) => {
      const st = index.files[f.path];
      let state: FileListState = 'new';
      if (job.running?.path === f.path) state = 'running';
      else if (job.queued.has(f.path)) state = 'queued';
      else if (st) state = st.status === 'error' ? 'error' : st.size === f.size && st.modified === modKey(f.modified) && st.v === EVENT_VERSION ? 'done' : 'changed';
      return {
        ...f,
        type,
        isLog: !f.dir && LOG_RE.test(f.name),
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

  /** 同步:每個類型目錄的新檔 / 已變更 / 失敗的檔案加入佇列;回傳 { found, added, errors } */
  async function sync() {
    if (job.syncing) return { found: 0, added: 0, errors: [] as string[], busy: true };
    job.syncing = true;
    try {
      return await syncDirs();
    } finally {
      job.syncing = false;
    }
  }

  async function syncDirs() {
    let found = 0;
    const items: EventItem[] = [];
    const errors: string[] = [];
    for (const t of eventTypes()) {
      try {
        const list = await listRemote(t.type);
        const logs = list.filter((f) => f.isLog);
        found += logs.length;
        items.push(...logs.filter((f) => ['new', 'changed', 'error'].includes(f.state)).map((f) => ({ path: f.path, name: f.name, size: f.size, modified: f.modified, type: t.type })));
      } catch (err) {
        errors.push(`${t.label}:${errorText(err)}`);
      }
    }
    job.lastSyncAt = new Date().toISOString();
    job.lastSyncError = errors.join(';');
    return { found, added: enqueue(items), errors };
  }

  const timers: NodeJS.Timeout[] = [];
  function start() {
    if (!ftpConfig || ftpConfig.syncMinutes <= 0) return;
    const tick = () =>
      sync().then(
        (r) => r.added && log.info({ added: r.added }, '[PA 其他 log 自動同步] 新增檔案待分析'),
        (err) => log.error({ err: (err as Error).message }, '[PA 其他 log 自動同步] 失敗'),
      );
    // 比 TRAFFIC 晚一點開始,避免同時開很多條 FTP 連線
    timers.push(setTimeout(tick, 60000).unref(), setInterval(tick, ftpConfig.syncMinutes * 60000).unref());
  }
  async function stop() {
    for (const t of timers.splice(0)) clearTimeout(t);
    cancel();
    await pumping;
  }

  /** 檔案是不是某類型的 log(在該類型目錄下、副檔名 csv / gz);是的話回傳類型 */
  const eventLogType = (p: string) => (LOG_RE.test(path.posix.basename(p)) ? typeOfDir(path.posix.dirname(p)) : '');

  /** 刪除摘要(之後同步會重新分析) */
  function forget(paths: string[]) {
    let n = 0;
    for (const p of paths) {
      const st = index.files[p];
      if (!st) continue;
      if (st.summary) {
        store.removeEventSummary(st.summary);
        cache.delete(st.summary);
      }
      delete index.files[p];
      n++;
    }
    saveIndex();
    return n;
  }

  /** 這個路徑是不是其他類型的 log(在類型目錄底下) */
  const isEventPath = (p: string) => Boolean(index.files[p]) || eventTypes().some((t) => path.posix.dirname(p) === t.dir);
  const eventTypeOfPath = (p: string) => index.files[p]?.type || typeOfDir(path.posix.dirname(p));

  /* ───────── 已分析的摘要 ───────── */

  const cache = new Map<string, unknown>();
  function readSummary(file: string) {
    if (cache.has(file)) return cache.get(file) ?? null;
    const s = store.readEventSummary(file);
    if (!s) return null;
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(file, s);
    return s;
  }

  /** 某類型資料時間與 [from, to] 重疊的檔案;from / to 為 'yyyy/MM/dd' 或 'yyyy/MM/dd HH:mm' */
  function filesInRange(type: string, from: string, to: string) {
    const end = to && to.length <= 10 ? `${to} 23:59:59` : to ? `${to}:59` : '';
    return Object.values(index.files).filter((f) => f.type === type && f.status === 'done' && (!from || (f.timeMax || '') >= from) && (!end || (f.timeMin || '') <= end));
  }

  /** 各類型有資料的日期與筆數:[{ type, label, dir, files, rows, days: [day] }] */
  function overview() {
    return eventTypes().map((t) => {
      const files = Object.values(index.files).filter((f) => f.type === t.type && f.status === 'done');
      return { ...t, files: files.length, rows: files.reduce((s, f) => s + (f.rows || 0), 0), days: [...new Set(files.map((f) => f.day).filter(Boolean))].sort().reverse() as string[] };
    });
  }

  /** 某類型期間的合併摘要;missing:index 有、摘要檔卻讀不到的檔案數(結果不完整) */
  function summary(type: string, from: string, to: string, topN = 20) {
    const files = filesInRange(type, from, to);
    const list = files.map((f) => readSummary(f.summary!)).filter(Boolean);
    return { ...mergeEventSummaries(type, list, topN), missing: files.length - list.length };
  }

  return { eventTypes, typeOfDir, eventLogType, status, enqueue, cancel, listRemote, sync, start, stop, forget, isEventPath, eventTypeOfPath, overview, summary };
}
