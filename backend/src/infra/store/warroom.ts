/**
 * 戰情室設定檔(WARROOM-PLAN §6 Q3、Q5;SEGMENT-SETTINGS-PLAN §4):warroom/warroom.json 一份,由網段設定頁(SG-1)整份寫入,也可人工放檔。
 * 另存 AI 每小時分析的最新一筆 warroom/ai-hourly.json(WR-3,Q4 只留最新)。
 * 內容:內部網段對照(CIDR → 名稱、類型、圖示)與儀表滿格值。這裡只讀寫原始 JSON,驗證在 modules/pa-live/warroom.ts。
 * 寫入前把舊檔存到 warroom/history/warroom-<時間>-v<版本>.json,保留最近 HISTORY_KEEP 份(SEGMENT-SETTINGS-PLAN §7 Q7)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, listFiles, mtimeMs, readJson, removeFile, writeAtomic, writeJson } from './files.js';

/** 歷史檔保留份數(§7 Q7) */
export const HISTORY_KEEP = 20;
const HISTORY_RE = /^warroom-\d{8}T\d{9}Z-v\d+\.json$/;

export interface WarroomStore {
  /** 設定檔原始內容;沒有檔案回 null,損壞丟 DataFileError */
  readConfig(): unknown;
  /** 檔案修改時間(快取判斷;沒有檔案回 null) */
  mtime(): number | null;
  /**
   * 整份寫入設定檔(SG-1 saveWarroomConfig):原本有檔案時先把舊檔原樣存進歷史(檔名帶時間與舊版本號),再改名寫入新檔;
   * 歷史超過 HISTORY_KEEP 份時刪最舊的。prevVersion 只用於歷史檔名。
   */
  saveConfig(value: unknown, prevVersion: number, at?: Date): void;
  /** 歷史檔數量(測試、狀態用;不回檔名) */
  historyCount(): number;
  /** AI 每小時分析(WR-3):只留最新一筆,整份覆寫;沒有回 null */
  readHourlyInsight(): unknown;
  saveHourlyInsight(value: unknown): void;
}

export function createWarroomStore(root: string): WarroomStore {
  const dir = path.join(root, 'warroom');
  const file = path.join(dir, 'warroom.json');
  const hourly = path.join(dir, 'ai-hourly.json');
  const historyDir = path.join(dir, 'history');
  const histories = () =>
    listFiles(historyDir)
      .filter((n) => HISTORY_RE.test(n))
      .sort();
  return {
    readConfig: () => readJson<unknown>(file),
    mtime: () => mtimeMs(file),
    saveConfig(value, prevVersion, at = new Date()) {
      ensureDir(dir);
      let old: Buffer | null = null;
      try {
        old = fs.readFileSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (old) {
        ensureDir(historyDir);
        // 20261118T093015123Z:檔名可排序、不含冒號(Windows / SMB 也可用)
        const stamp = at.toISOString().replace(/[-:.]/g, '');
        const v = Number.isSafeInteger(prevVersion) && prevVersion >= 0 ? prevVersion : 0;
        writeAtomic(path.join(historyDir, `warroom-${stamp}-v${v}.json`), old);
      }
      writeJson(file, value);
      const list = histories();
      for (const n of list.slice(0, Math.max(0, list.length - HISTORY_KEEP))) removeFile(path.join(historyDir, n));
    },
    historyCount: () => histories().length,
    readHourlyInsight: () => readJson<unknown>(hourly),
    saveHourlyInsight: (value) => writeJson(hourly, value),
  };
}
