/**
 * 戰情室設定檔(WARROOM-PLAN §6 Q3、Q5):warroom/warroom.json 一份,由網通提供、人工放進資料目錄(畫面維護之後再說)。
 * 內容:內部網段對照(CIDR → 名稱、類型、圖示)與儀表滿格值。這裡只讀原始 JSON,驗證在 modules/pa-live/warroom.ts。
 */
import path from 'node:path';
import { mtimeMs, readJson } from './files.js';

export interface WarroomStore {
  /** 設定檔原始內容;沒有檔案回 null,損壞丟 DataFileError */
  readConfig(): unknown;
  /** 檔案修改時間(快取判斷;沒有檔案回 null) */
  mtime(): number | null;
}

export function createWarroomStore(root: string): WarroomStore {
  const file = path.join(root, 'warroom', 'warroom.json');
  return {
    readConfig: () => readJson<unknown>(file),
    mtime: () => mtimeMs(file),
  };
}
