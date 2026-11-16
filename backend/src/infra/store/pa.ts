/**
 * PA 分析結果的存取(ARCHITECTURE §4.1;位置與格式同舊版 uploads/palogs,切換時直接複製,D14)
 *   palogs/index.json                 TRAFFIC 每個 FTP 檔案的分析狀態
 *   palogs/summaries/{name}.json      TRAFFIC 摘要
 *   palogs/flows/{name}.tsv.gz        連線組合統計
 *   palogs/events/index.json          其他類型 log 的分析狀態
 *   palogs/events/{type}/{name}.json.gz  其他類型 log 的摘要(index 內記成 "{type}/{name}")
 *   palogs/iplearn.json               外部 IP 自動學習查過的 IP、網段與分組(A1;同舊版位置)
 *   palogs/ch/index.json、ch/{kind}/{YYYYMMDDHH}.json.gz   ClickHouse 每小時摘要(C3;新版才有)
 *   palogs/ch/recon/{YYYYMMDD}.json   FTP 與 ClickHouse 每日對帳結果(C3)
 *   palogs/ai-daily/{YYYYMMDD}.json   AI 每日摘要(AC7;內容含 IP 與姓名,視同機密)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readGzipJson, readGzipText, readJson, removeFile, safeJoin, writeGzipJson, writeGzipText, writeJson } from './files.js';

export interface PaIndex<T = unknown> {
  files: Record<string, T>;
}

export interface PaStore {
  loadIndex<T>(): PaIndex<T>;
  saveIndex(index: PaIndex): void;
  saveSummary(name: string, summary: unknown): void;
  /** 不存在回 null(呼叫端要算進「缺少的檔案」) */
  readSummary<T>(name: string): T | null;
  removeSummary(name: string): void;
  saveFlows(name: string, text: string): void;
  /** 連線組合統計(解壓後的文字);不存在回 null(AI 問答改掃 FTP) */
  readFlows(name: string): Promise<string | null>;
  removeFlows(name: string): void;
  loadEventIndex<T>(): PaIndex<T>;
  saveEventIndex(index: PaIndex): void;
  /** key 為 "{type}/{name}"(同舊版 index 內的 summary 欄位) */
  saveEventSummary(key: string, summary: unknown): void;
  readEventSummary<T>(key: string): T | null;
  removeEventSummary(key: string): void;
  /** 外部 IP 自動學習的狀態;不存在回 null */
  loadIpLearnState<T>(): T | null;
  saveIpLearnState(state: unknown): void;
  /**
   * ClickHouse 每小時摘要(C3):kind 為 traffic 或威脅類類型,hour 為台灣時間 'YYYYMMDDHH'。
   * 由 ClickHouse 原始 log 算出、格式同 FTP 摘要,總覽的排行用;跟著 ClickHouse 保留期限清除(不適用 D16)
   */
  loadChSummaryIndex<T>(): T | null;
  saveChSummaryIndex(index: unknown): void;
  saveChSummary(kind: string, hour: string, summary: unknown): void;
  readChSummary<T>(kind: string, hour: string): T | null;
  removeChSummary(kind: string, hour: string): void;
  /** FTP 與 ClickHouse 每日對帳結果(C3;day 為 'YYYYMMDD');不存在回 null */
  saveRecon(day: string, result: unknown): void;
  readRecon<T>(day: string): T | null;
  removeRecon(day: string): void;
  /** AI 每日摘要(AC7;day 為 'YYYYMMDD'):摘要內容含 IP 與姓名(AQ2),只經本服務 API 給有權限的人看;不存在回 null */
  saveAiDaily(day: string, value: unknown): void;
  readAiDaily<T>(day: string): T | null;
  /** 有存檔的日子('YYYYMMDD',新的在前) */
  listAiDaily(): string[];
}

const CH_KINDS = ['traffic', 'threat', 'url', 'data', 'wildfire'];

export function createPaStore(root: string, eventTypes: readonly string[]): PaStore {
  const base = path.join(root, 'palogs');
  const sumDir = path.join(base, 'summaries');
  const flowDir = path.join(base, 'flows');
  const evDir = path.join(base, 'events');
  for (const d of [sumDir, flowDir, evDir, ...eventTypes.map((t) => path.join(evDir, t))]) ensureDir(d);
  const indexFile = path.join(base, 'index.json');
  const evIndexFile = path.join(evDir, 'index.json');
  const chDir = path.join(base, 'ch');
  for (const k of CH_KINDS) ensureDir(path.join(chDir, k));
  const reconDir = path.join(chDir, 'recon');
  ensureDir(reconDir);
  const reconFile = (day: string) => {
    if (!/^\d{8}$/.test(day)) throw new Error(`不合法的對帳日期:${day}`);
    return safeJoin(reconDir, `${day}.json`);
  };
  const aiDailyDir = path.join(base, 'ai-daily');
  ensureDir(aiDailyDir);
  const aiDailyFile = (day: string) => {
    if (!/^\d{8}$/.test(day)) throw new Error(`不合法的每日摘要日期:${day}`);
    return safeJoin(aiDailyDir, `${day}.json`);
  };
  const chFile = (kind: string, hour: string) => {
    if (!CH_KINDS.includes(kind) || !/^\d{10}$/.test(hour)) throw new Error(`不合法的 ClickHouse 摘要代號:${kind}/${hour}`);
    return safeJoin(path.join(chDir, kind), `${hour}.json.gz`);
  };

  const loadIdx = <T>(file: string): PaIndex<T> => {
    const idx = readJson<PaIndex<T>>(file) ?? { files: {} };
    idx.files ??= {};
    return idx;
  };
  const eventFile = (key: string) => {
    const [type, name, ...rest] = key.split('/');
    if (!type || !name || rest.length || !eventTypes.includes(type)) throw new Error(`不合法的事件摘要代號:${key}`);
    return safeJoin(path.join(evDir, type), name);
  };

  return {
    loadIndex: <T>() => loadIdx<T>(indexFile),
    saveIndex: (index) => writeJson(indexFile, index),
    saveSummary: (name, summary) => writeJson(safeJoin(sumDir, name), summary),
    readSummary: (name) => readJson(safeJoin(sumDir, name)),
    removeSummary: (name) => removeFile(safeJoin(sumDir, name)),
    saveFlows: (name, text) => writeGzipText(safeJoin(flowDir, name), text),
    readFlows: (name) => readGzipText(safeJoin(flowDir, name)),
    removeFlows: (name) => removeFile(safeJoin(flowDir, name)),
    loadEventIndex: <T>() => loadIdx<T>(evIndexFile),
    saveEventIndex: (index) => writeJson(evIndexFile, index),
    saveEventSummary: (key, summary) => writeGzipJson(eventFile(key), summary),
    readEventSummary: (key) => readGzipJson(eventFile(key)),
    removeEventSummary: (key) => removeFile(eventFile(key)),
    loadIpLearnState: () => readJson(path.join(base, 'iplearn.json')),
    saveIpLearnState: (state) => writeJson(path.join(base, 'iplearn.json'), state),
    loadChSummaryIndex: () => readJson(path.join(chDir, 'index.json')),
    saveChSummaryIndex: (index) => writeJson(path.join(chDir, 'index.json'), index),
    saveChSummary: (kind, hour, summary) => writeGzipJson(chFile(kind, hour), summary),
    readChSummary: (kind, hour) => readGzipJson(chFile(kind, hour)),
    removeChSummary: (kind, hour) => removeFile(chFile(kind, hour)),
    saveRecon: (day, result) => writeJson(reconFile(day), result),
    readRecon: (day) => readJson(reconFile(day)),
    removeRecon: (day) => removeFile(reconFile(day)),
    saveAiDaily: (day, value) => writeJson(aiDailyFile(day), value),
    readAiDaily: (day) => readJson(aiDailyFile(day)),
    listAiDaily: () =>
      fs
        .readdirSync(aiDailyDir)
        .map((f) => /^(\d{8})\.json$/.exec(f)?.[1])
        .filter((d): d is string => Boolean(d))
        .sort()
        .reverse(),
  };
}
