/**
 * AD 事件的存取(ARCHITECTURE §4.1;位置與格式同舊版 uploads/adlogs,切換時直接複製,D14)
 *   adlogs/yyyyMMdd.json   一天的全部事件 { day, sig, importedAt, files, events }
 */
import path from 'node:path';
import { listFiles, mtimeMs, readJson, removeFile, safeJoin, writeJson } from './files.js';

const DAY_KEY = /^\d{8}$/;

export interface AdStore {
  /** 已匯入的日期(yyyyMMdd) */
  listDays(): string[];
  /** 資料的版本(檔案修改時間);不存在回 null,給呼叫端判斷快取是否過期 */
  dayVersion(day: string): number | null;
  readDay<T>(day: string): T | null;
  saveDay(day: string, data: unknown): void;
  /** 刪除;本來就沒有回 false */
  removeDay(day: string): boolean;
}

export function createAdStore(root: string): AdStore {
  const dir = path.join(root, 'adlogs');
  const file = (day: string) => {
    if (!DAY_KEY.test(day)) throw new Error(`不合法的日期:${day}`);
    return safeJoin(dir, `${day}.json`);
  };
  return {
    listDays: () => listFiles(dir).filter((f) => /^\d{8}\.json$/.test(f)).map((f) => f.slice(0, 8)),
    dayVersion: (day) => mtimeMs(file(day)),
    readDay: (day) => readJson(file(day)),
    saveDay: (day, data) => writeJson(file(day), data),
    removeDay(day) {
      if (mtimeMs(file(day)) === null) return false;
      removeFile(file(day));
      return true;
    },
  };
}
