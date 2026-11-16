/**
 * IP 對照表的存取(IMPL-PLAN AC3):ipnames/ip-names.json 一份,整份寫入(以最新為準,不記歷史)。
 * 內容含姓名、部門(個資),視同機密:不寫日誌、不外送;API 回應不帶檔名與路徑(§4.2)。
 */
import path from 'node:path';
import { mtimeMs, readJson, writeJson } from './files.js';

export interface IpNamesFile<T> {
  /** 每次寫入加 1(匯入預覽與確認之間被改過時拒絕確認) */
  version: number;
  entries: T[];
}

export interface IpNameStore {
  /** 全部對照表;還沒有資料時 version 0 */
  listIpNames<T>(): IpNamesFile<T>;
  saveIpNames<T>(data: IpNamesFile<T>): void;
  /** 檔案修改時間(快取判斷;沒有檔案回 null) */
  mtime(): number | null;
}

export function createIpNameStore(root: string): IpNameStore {
  const file = path.join(root, 'ipnames', 'ip-names.json');
  return {
    listIpNames: <T>() => readJson<IpNamesFile<T>>(file) ?? { version: 0, entries: [] },
    saveIpNames: (data) => writeJson(file, data),
    mtime: () => mtimeMs(file),
  };
}
