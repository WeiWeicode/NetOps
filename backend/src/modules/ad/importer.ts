/**
 * AD 事件記錄匯入(由舊版 server/lib/adimport.js 搬移,IMPL-PLAN B2;解析與統計在 core/adlog.js 不動)
 *   FTP {FTP_AD_DIR}/yyyyMMdd/*.csv → store.ad(一天一份,全部事件,一天約幾千筆)
 *   每天資料夾裡任一檔案大小或時間改變就重新匯入;與 PA log 共用 FTP_SYNC_MINUTES 自動同步
 * 與舊版不同:列目錄與下載用同一條 FTP 連線(舊版會同時開兩條);同步在背景執行。
 * AI 用的 adContext(IMPL-PLAN A1 搬移,文字在 core/ad-ai.js)。
 */
import type { FtpConfig } from '../../config.js';
import type { Ftp, FtpEntry, FtpSession } from '../../infra/ftp/index.js';
import type { AdStore } from '../../infra/store/index.js';
import { errorText, type Log } from '../pa/importer.js';
import { adContext as adContextJs } from './core/ad-ai.js';
import { buildAdFilter, channelOf, enrichEvent, parseAdCsv, summarizeAd } from './core/adlog.js';

export interface AdEvent {
  time: string;
  eventId: number;
  level: string;
  levelText: string;
  provider: string;
  computer: string;
  recordId: string;
  channel: string;
  message: string;
  account?: string;
  domain?: string;
  ip?: string;
  workstation?: string;
  reason?: string;
  actor?: string;
  target?: string;
  group?: string;
  privileged?: boolean;
}

interface DayFile {
  name: string;
  channel?: string;
  size: number;
  modified: Date | string | null;
  rows: number;
  error?: string;
}

interface DayData {
  day: string;
  sig: string;
  importedAt: string;
  files: DayFile[];
  events: AdEvent[];
}

export interface AdFilter {
  channel?: string;
  level?: string;
  eventId?: string;
  q?: string;
  account?: string;
  ip?: string;
  issueOnly?: boolean;
}

/** core/ad-ai.js 的型別(JS 推斷的參數型別太窄) */
const adContextText = adContextJs as unknown as (events: AdEvent[], days: { day: string; files: { channel?: string; rows: number }[] }[], from: string, to: string, opts: object) => string;

const DAY_RE = /^\d{8}$/;
const slash = (d: string) => `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
const toKey = (d: string) => String(d ?? '').replace(/\D/g, '').slice(0, 8);

/** FTP 原始檔(UTF-16 LE 或 UTF-8)→ 文字 */
const decode = (buf: Buffer) => (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');
const csvFiles = async (s: FtpSession, dirPath: string) => (await s.list(dirPath)).filter((f) => !f.dir && /\.csv$/i.test(f.name));
/** 一天資料夾的簽章(同舊版:檔名、大小、時間;舊資料複製過來後不會被誤判為已變更) */
const sigOf = (files: FtpEntry[]) =>
  files
    .map((f) => `${f.name}:${f.size}:${f.modified?.toISOString() ?? f.rawModified}`)
    .sort()
    .join('|');

export type AdImporter = ReturnType<typeof createAdImporter>;

export function createAdImporter({ ftp, store, ftpConfig, log }: { ftp: Ftp; store: AdStore; ftpConfig: FtpConfig | null; log: Log }) {
  const state = { running: false, lastSyncAt: null as string | null, lastSyncError: '', lastResult: null as { days: number; imported: { day: string; events: number }[] } | null };
  const status = () => ({ ...state, dir: ftpConfig?.adDir ?? '', autoSyncMinutes: ftpConfig?.syncMinutes ?? 0 });

  const cache = new Map<string, { version: number; data: DayData }>();
  /** 讀一天的資料(資料檔有變動才重新讀) */
  function readDay(day: string): DayData | null {
    const version = store.dayVersion(day);
    if (version === null) return null;
    const hit = cache.get(day);
    if (hit?.version === version) return hit.data;
    const data = store.readDay<DayData>(day);
    if (!data) return null;
    data.events.forEach(enrichEvent);
    if (cache.size > 60) cache.delete(cache.keys().next().value!);
    cache.set(day, { version, data });
    return data;
  }

  /** 已匯入的日期(新的在前):[{ day: 'yyyy/MM/dd', events, files: [{ name, channel, rows }], importedAt }] */
  function days() {
    return store
      .listDays()
      .map((d) => readDay(d))
      .filter((d): d is DayData => Boolean(d))
      .map((d) => ({ day: slash(d.day), events: d.events.length, files: d.files.map(({ name, channel, rows }) => ({ name, channel, rows })), importedAt: d.importedAt }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  /** 匯入一天(dirPath 為 FTP 上的日期資料夾),回傳筆數 */
  async function importDay(s: FtpSession, day: string, dirPath: string, files: FtpEntry[], sig: string) {
    const events: AdEvent[] = [];
    const info: DayFile[] = [];
    for (const f of files) {
      try {
        const evs = parseAdCsv(decode(await s.download(`${dirPath}/${f.name}`)), f.name) as AdEvent[];
        events.push(...evs);
        info.push({ name: f.name, channel: evs[0]?.channel ?? f.name.replace(/\.csv$/i, ''), size: f.size, modified: f.modified, rows: evs.length });
      } catch (err) {
        info.push({ name: f.name, size: f.size, modified: f.modified, rows: 0, error: errorText(err) });
        log.error({ file: f.name, err, cause: (err as { cause?: unknown }).cause }, '[AD 匯入] 檔案匯入失敗');
      }
    }
    // 同一天可能同時有舊檔名(Security.csv)和新檔名(Security_GSMC-DC1.csv,v3 匯出程式):依主機 + 記錄 + 記錄編號去除重複
    const seen = new Set<string>();
    const unique = events.filter((e) => {
      const k = `${e.computer}|${e.channel}|${e.recordId}`;
      if (!e.recordId || !seen.has(k)) return seen.add(k), true;
      return false;
    });
    unique.sort((a, b) => b.time.localeCompare(a.time));
    store.saveDay(day, { day, sig, importedAt: new Date().toISOString(), files: info, events: unique });
    cache.delete(day);
    return unique.length;
  }

  /**
   * FTP 上的日期資料夾與匯入狀態(FTP Log 檔案頁;工作模式)
   * state:new 未匯入 / changed 檔案有變 / done 已匯入 / orphan 已匯入但 FTP 上已沒有這個資料夾
   */
  /** 同時有多個清單請求時共用同一次 FTP 列表(避免重複送出工作佔滿 FTP 連線) */
  let listing: ReturnType<typeof listDays> | null = null;
  function listRemote() {
    listing ??= listDays().finally(() => {
      listing = null;
    });
    return listing;
  }

  async function listDays() {
    const root = ftp.safePath(ftpConfig?.adDir ?? '/');
    const days = await ftp.withSession(
      async (s) => {
        const dirs = (await s.list(root)).filter((d) => d.dir && DAY_RE.test(d.name));
        const out = [];
        for (const d of dirs) {
          const files = await csvFiles(s, d.path);
          const local = readDay(d.name);
          const st = !local ? 'new' : local.sig === sigOf(files) ? 'done' : 'changed';
          const byName = new Map((local?.files ?? []).map((f) => [f.name, f]));
          out.push({
            day: slash(d.name),
            path: d.path,
            state: st,
            events: local?.events.length ?? null,
            importedAt: local?.importedAt ?? null,
            files: files.map((f) => ({ name: f.name, size: f.size, modified: f.modified, channel: channelOf(f.name) as string, rows: byName.get(f.name)?.rows ?? null, error: byName.get(f.name)?.error ?? '' })),
          });
        }
        // 已匯入、但 FTP 上已經沒有資料夾的日期,列出來才能刪除
        const onFtp = new Set(dirs.map((d) => d.name));
        for (const day of store.listDays()) {
          if (onFtp.has(day)) continue;
          const local = readDay(day);
          if (!local) continue;
          out.push({
            day: slash(day),
            path: '',
            state: 'orphan',
            events: local.events.length,
            importedAt: local.importedAt,
            files: local.files.map((x) => ({ name: x.name, size: x.size, modified: x.modified, channel: x.channel ?? '', rows: x.rows, error: x.error ?? '' })),
          });
        }
        return out.sort((a, b) => b.day.localeCompare(a.day));
      },
    );
    return { dir: root, days };
  }

  /** 刪除指定日期的匯入結果(FTP 上的檔案不動;之後同步會重新匯入) */
  function forget(list: string[]) {
    let n = 0;
    for (const d of list) {
      const key = toKey(d);
      if (!DAY_RE.test(key)) continue;
      if (store.removeDay(key)) {
        cache.delete(key);
        n++;
      }
    }
    return n;
  }

  /**
   * 同步:每個日期資料夾比對檔案大小 / 時間,有變才重新匯入
   *   days:只處理這些日期('yyyy/MM/dd' 或 yyyyMMdd);force:不比對,一律重新匯入
   */
  async function sync({ days: want = null as string[] | null, force = false } = {}) {
    if (state.running) return { busy: true as const };
    state.running = true;
    const imported: { day: string; events: number }[] = [];
    const only = want ? new Set(want.map(toKey)) : null;
    try {
      const root = ftp.safePath(ftpConfig?.adDir ?? '/');
      const result = await ftp.withSession(async (s) => {
        const dirs = (await s.list(root)).filter((d) => d.dir && DAY_RE.test(d.name) && (!only || only.has(d.name)));
        for (const d of dirs) {
          const files = await csvFiles(s, d.path);
          const sig = sigOf(files);
          if (!force && readDay(d.name)?.sig === sig) continue;
          imported.push({ day: slash(d.name), events: await importDay(s, d.name, d.path, files, sig) });
        }
        return { days: dirs.length, imported };
      });
      state.lastResult = result;
      state.lastSyncError = '';
      return result;
    } catch (err) {
      state.lastSyncError = errorText(err);
      throw err;
    } finally {
      state.lastSyncAt = new Date().toISOString();
      state.running = false;
    }
  }

  const timers: NodeJS.Timeout[] = [];
  function start() {
    if (!ftpConfig || ftpConfig.syncMinutes <= 0 || !ftpConfig.adDir) return;
    const tick = () =>
      sync().then(
        (r) => 'imported' in r && r.imported.length && log.info({ imported: r.imported }, '[AD 自動同步] 匯入'),
        (err) => log.error({ err }, '[AD 自動同步] 失敗'),
      );
    timers.push(setTimeout(tick, 20000).unref(), setInterval(tick, ftpConfig.syncMinutes * 60000).unref());
  }
  function stop() {
    for (const t of timers.splice(0)) clearTimeout(t);
  }

  /* ───────── 查詢 ───────── */

  /** 期間內的事件(from / to:'yyyy/MM/dd',可帶 HH:mm),新的在前 */
  function eventsInRange(from: string, to: string): AdEvent[] {
    const a = toKey(from);
    const b = toKey(to) || a;
    const fromT = String(from ?? '').length > 10 ? from : '';
    const toT = String(to ?? '').length > 10 ? `${to}:59` : '';
    const out: AdEvent[] = [];
    for (const day of store.listDays()) {
      if (day < a || day > b) continue;
      for (const e of readDay(day)?.events ?? []) if ((!fromT || e.time >= fromT) && (!toT || e.time <= toT)) out.push(e);
    }
    return out.sort((x, y) => y.time.localeCompare(x.time));
  }

  /** 期間內已匯入的天數(少於期間天數表示有日期沒有資料) */
  const daysInRange = (from: string, to: string) => store.listDays().filter((d) => d >= toKey(from) && d <= (toKey(to) || toKey(from))).length;

  const summary = (from: string, to: string) => summarizeAd(eventsInRange(from, to));

  /** 篩選後的事件與篩選前的總數 */
  function search(from: string, to: string, filters: AdFilter) {
    const all = eventsInRange(from, to);
    const test = buildAdFilter(filters);
    return { rows: all.filter(test) as AdEvent[], scanned: all.length };
  }

  /** AI 分析 / 問答用:期間的 AD 事件 → 給模型的文字(沒有資料回 '';同舊版 adContext) */
  const adContext = (from: string, to: string, opts: { ips?: string[]; eventIds?: number[]; accounts?: string[]; full?: boolean } = {}): string =>
    adContextText(eventsInRange(from, to), days(), from, to, opts);

  /** 是否有設定 FTP(沒有時同步、匯入直接回 503,不在背景才失敗) */
  const configured = () => Boolean(ftpConfig);

  /**
   * 某一天('yyyy/MM/dd')的匯入狀態(AC1 每日同步):done 已匯入;error 已匯入但有檔案讀取失敗;
   * pending 還沒匯入、正在同步;none 還沒匯入(FTP 上還沒有這天的資料夾或還沒同步)
   */
  function dayState(day: string): 'done' | 'pending' | 'error' | 'none' {
    const d = readDay(toKey(day));
    if (d) return d.files.some((f) => f.error) ? 'error' : 'done';
    return state.running ? 'pending' : 'none';
  }

  /** 有沒有匯入過任何一天(每日同步依此判斷要不要對過期的日子記 warn) */
  const hasAnyDay = () => store.listDays().length > 0;

  return { status, configured, days, listRemote, forget, sync, start, stop, summary, daysInRange, search, eventsInRange, adContext, dayState, hasAnyDay };
}
