/**
 * 資料存取邊界(ARCHITECTURE D8、§4):核心與路由只呼叫這裡的具名函式,不自行組資料目錄路徑。
 * 第一版存檔案(位置與格式與舊版 uploads/ 相同,切換時可直接複製,D14);未來改資料庫時只換這一層,API 與核心不動。
 *
 *   palogs/index.json、summaries/、flows/、events/   PA 分析狀態、摘要、連線組合統計、其他類型 log 摘要(B2)
 *   adlogs/yyyyMMdd.json                             AD 事件(B2)
 *   knowledge/*.md、_knowledge-all.md               知識庫(B2)
 *
 * 第一版不自動清除資料(D16)。API 回應不可帶出這裡的路徑或檔案結構(§4.2 第 3 點)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_DIR_ENV } from '../../config.js';
import { ensureDir, removeFile, writeAtomic } from './files.js';
import { createAdStore, type AdStore } from './ad.js';
import { createPaStore, type PaStore } from './pa.js';

export type { AdStore } from './ad.js';
export type { PaIndex, PaStore } from './pa.js';

/** 各資料的子目錄(相對資料目錄;與舊版 uploads/ 相同) */
export const LAYOUT = {
  pa: 'palogs',
  ad: 'adlogs',
  kb: 'knowledge',
} as const;

export interface Store {
  /** 資料目錄可寫入才回 true(/readyz 使用;不回傳路徑) */
  ready(): Promise<boolean>;
  /** PA TRAFFIC 與其他類型 log 的分析結果 */
  pa: PaStore;
  /** AD 事件(一天一份) */
  ad: AdStore;
}

export function createStore(dataDir: string): Store {
  const root = path.resolve(dataDir);
  ensureDir(root);
  for (const sub of Object.values(LAYOUT)) ensureDir(path.join(root, sub));

  return {
    pa: createPaStore(root, Object.keys(EVENT_DIR_ENV)),
    ad: createAdStore(root),
    async ready() {
      const probe = path.join(root, `.ready-${process.pid}`);
      try {
        writeAtomic(probe, String(Date.now()));
        removeFile(probe);
        await fs.promises.access(root, fs.constants.R_OK | fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
