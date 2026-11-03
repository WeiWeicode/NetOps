/**
 * PA 分析結果的存取(ARCHITECTURE §4.1;位置與格式同舊版 uploads/palogs,切換時直接複製,D14)
 *   palogs/index.json                 TRAFFIC 每個 FTP 檔案的分析狀態
 *   palogs/summaries/{name}.json      TRAFFIC 摘要
 *   palogs/flows/{name}.tsv.gz        連線組合統計
 *   palogs/events/index.json          其他類型 log 的分析狀態
 *   palogs/events/{type}/{name}.json.gz  其他類型 log 的摘要(index 內記成 "{type}/{name}")
 */
import path from 'node:path';
import { ensureDir, readGzipJson, readJson, removeFile, safeJoin, writeGzipJson, writeGzipText, writeJson } from './files.js';

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
  removeFlows(name: string): void;
  loadEventIndex<T>(): PaIndex<T>;
  saveEventIndex(index: PaIndex): void;
  /** key 為 "{type}/{name}"(同舊版 index 內的 summary 欄位) */
  saveEventSummary(key: string, summary: unknown): void;
  readEventSummary<T>(key: string): T | null;
  removeEventSummary(key: string): void;
}

export function createPaStore(root: string, eventTypes: readonly string[]): PaStore {
  const base = path.join(root, 'palogs');
  const sumDir = path.join(base, 'summaries');
  const flowDir = path.join(base, 'flows');
  const evDir = path.join(base, 'events');
  for (const d of [sumDir, flowDir, evDir, ...eventTypes.map((t) => path.join(evDir, t))]) ensureDir(d);
  const indexFile = path.join(base, 'index.json');
  const evIndexFile = path.join(evDir, 'index.json');

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
    removeFlows: (name) => removeFile(safeJoin(flowDir, name)),
    loadEventIndex: <T>() => loadIdx<T>(evIndexFile),
    saveEventIndex: (index) => writeJson(evIndexFile, index),
    saveEventSummary: (key, summary) => writeGzipJson(eventFile(key), summary),
    readEventSummary: (key) => readGzipJson(eventFile(key)),
    removeEventSummary: (key) => removeFile(eventFile(key)),
  };
}
