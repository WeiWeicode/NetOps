/**
 * PA 其他類型 log 的匯入(由舊版 server/lib/paevimport.js 搬移,IMPL-PLAN B2;類型定義與研判在 core/paevents.js 不動)
 *   威脅、URL、資料過濾、WildFire、解密、GlobalProtect、User-ID;FTP 目錄見設定 FTP_*_DIR
 *   與 TRAFFIC 相同從 FTP 串流讀取,原始 log 不存本機;用 1 條 FTP 連線依序分析
 * AI 用的 eventsForIps / eventsContext 於 IMPL-PLAN A1 搬移(文字與舊版相同)。
 */
import path from 'node:path';
import type { EventType, FtpConfig } from '../../config.js';
import { cancelledError, type Ftp, type FtpStream } from '../../infra/ftp/index.js';
import type { PaStore } from '../../infra/store/index.js';
import { readLog } from '../pa/core/palog.js';
import { errorText, fileDataDay, MAX_QUEUE, modKey, queueFull, sumName, type FileListState, type FileState, type Log, type QueueItem, type RemoteFile } from '../pa/importer.js';
import { aggText, createEventSummary, EVENT_TYPES, EVENT_VERSION, mergeEventSummaries } from './core/paevents.js';

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
const TYPE_DEFS = EVENT_TYPES as unknown as Record<string, { label: string; columns: unknown; numeric?: unknown; ips: string[]; dims: [string, ...unknown[]][] }>;
/** core/paevents.js 的 aggText(JS 推斷的型別太窄) */
const agg = aggText as unknown as (type: string, rows: unknown[][]) => { total: number; kinds: number; text: string };

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
      log.error({ type: item.type, file: item.path, err, cause: (err as { cause?: unknown }).cause }, `[PA ${def.label}] 分析失敗`);
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

  /**
   * 同步:每個類型目錄的新檔 / 已變更 / 失敗的檔案加入佇列;回傳 { found, added, errors }
   *   types:只同步這些類型;days:只排檔名資料日期('yyyy/MM/dd',fileDataDay)在其中的檔(AC1 每日同步,檔名沒有日期的不排)
   */
  async function sync(opts: { types?: string[]; days?: Set<string> } = {}) {
    if (job.syncing) return { found: 0, added: 0, errors: [] as string[], busy: true };
    job.syncing = true;
    try {
      return await syncDirs(opts);
    } finally {
      job.syncing = false;
    }
  }

  async function syncDirs({ types, days }: { types?: string[]; days?: Set<string> }) {
    let found = 0;
    const items: EventItem[] = [];
    const errors: string[] = [];
    for (const t of eventTypes()) {
      if (types && !types.includes(t.type)) continue;
      try {
        const list = await listRemote(t.type);
        const logs = list.filter((f) => f.isLog);
        found += logs.length;
        const want = logs.filter((f) => ['new', 'changed', 'error'].includes(f.state) && (!days || days.has(fileDataDay(f.name) ?? '')));
        items.push(...want.map((f) => ({ path: f.path, name: f.name, size: f.size, modified: f.modified, type: t.type })));
      } catch (err) {
        errors.push(`${t.label}:${errorText(err)}`);
        log.error({ type: t.type, err, cause: (err as { cause?: unknown }).cause }, '[PA 其他 log] 同步失敗');
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

  /**
   * 某類型某一天('yyyy/MM/dd')的匯入狀態(AC1 每日同步):資料日期依檔名(fileDataDay),檔名沒有日期時用摘要的 day。
   *   pending:有這天的檔在佇列或分析中;error:有這天的檔分析失敗;done:這天的檔都分析完;none:還沒有這天的檔(FTP 上還沒出現或還沒同步)
   */
  function dayState(type: string, day: string): 'done' | 'pending' | 'error' | 'none' {
    const active = [...job.queue, ...(job.running ? [job.running] : [])];
    if (active.some((it) => it.type === type && fileDataDay(it.name) === day)) return 'pending';
    let done = false;
    for (const f of Object.values(index.files)) {
      if (f.type !== type || (fileDataDay(f.name) ?? f.day) !== day) continue;
      if (f.status === 'error') return 'error';
      if (f.status === 'done') done = true;
    }
    return done ? 'done' : 'none';
  }

  /** 某類型有沒有分析過任何檔(沒有 = PA 可能沒有匯出這個類型;每日同步依此判斷要不要對過期的日子記 warn) */
  const hasAnyFile = (type: string) => Object.values(index.files).some((f) => f.type === type && f.status === 'done');

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

  /* ───────── 給 AI 的文字(由舊版 paevimport.js 搬移,IMPL-PLAN A1;內容不變) ───────── */

  /**
   * AI 問答:問題中的 IP 在各類型 log 的紀錄(每小時組合依 IP 篩選)
   *   test(ip) → 是否符合;from / to 為 'yyyy/MM/dd HH:mm'
   * 回傳 { text, hits: [{ type, label, total, kinds }] };都沒有回傳 text = ''
   * types:只看這些類型(AC2:AI 改查 ClickHouse 後,這裡只剩解密、GlobalProtect、User-ID);省略 = 全部
   */
  function eventsForIps(from: string, to: string, test: (ip: string) => boolean, types: readonly string[] | null = null) {
    const parts: string[] = [];
    const hits: { type: string; label: string; total: number; kinds: number }[] = [];
    const end = `${to}:59`;
    for (const t of eventTypes()) {
      if (types && !types.includes(t.type)) continue;
      const def = TYPE_DEFS[t.type]!;
      const ipIdx = def.ips.map((k) => def.dims.findIndex(([d]) => d === k) + 1);
      const nd = def.dims.length;
      const rows: unknown[][] = [];
      let overflow = 0;
      for (const f of filesInRange(t.type, from, to)) {
        if (f.aggOverflow) overflow++;
        const s = readSummary(f.summary!) as { agg?: unknown[][] } | null;
        for (const r of s?.agg ?? []) {
          if ((r[nd + 3] as string) < from || (r[nd + 2] as string) > end) continue;
          if (ipIdx.some((i) => r[i] && test(r[i] as string))) rows.push(r);
        }
      }
      if (!rows.length) continue;
      const a = agg(t.type, rows);
      hits.push({ type: t.type, label: t.label, total: a.total, kinds: a.kinds });
      parts.push(`### ${t.label}（${t.type}）：${a.total.toLocaleString('en-US')} 次、${a.kinds} 種組合${overflow ? `（${overflow} 個檔案事件太多沒有組合統計，可能不完整）` : ''}\n${a.text}`);
    }
    return { text: parts.length ? `## PA 其他 log（威脅 / URL / 資料過濾 / WildFire / 解密 / GlobalProtect / User-ID）中與問題 IP 相關的紀錄\n\n${parts.join('\n\n')}` : '', hits };
  }

  /** AI 分析 / 問答(沒有 IP 時):期間內各類型的重點摘要文字 */
  function eventsContext(from: string, to: string, { types = null, topN = 10 }: { types?: string[] | null; topN?: number } = {}) {
    const out: string[] = [];
    for (const t of eventTypes()) {
      if (types && !types.includes(t.type)) continue;
      const m = summary(t.type, from, to, topN) as unknown as { rows: number; timeMin: string; timeMax: string; kpis: { title: string; items: { key: string; n: number }[] }[]; tops: { title: string; items: { key: string; n: number }[] }[] };
      if (!m.rows) continue;
      const lines = [`### ${t.label}（${t.type}）：${m.rows.toLocaleString('en-US')} 筆，${m.timeMin} ~ ${m.timeMax}`];
      for (const k of m.kpis) lines.push(`- ${k.title}：${k.items.slice(0, 8).map((x) => `${x.key} ${x.n.toLocaleString('en-US')}`).join('、')}`);
      for (const tp of m.tops) if (tp.items.length) lines.push(`- ${tp.title}：${tp.items.slice(0, topN).map((x) => `${x.key}（${x.n.toLocaleString('en-US')}）`).join('、')}`);
      out.push(lines.join('\n'));
    }
    return out.length ? `## PA 其他 log 摘要（${from} ~ ${to}）\n\n${out.join('\n\n')}` : '';
  }

  return { eventTypes, typeOfDir, eventLogType, status, enqueue, cancel, listRemote, sync, start, stop, forget, dayState, hasAnyFile, isEventPath, eventTypeOfPath, overview, summary, eventsForIps, eventsContext };
}
