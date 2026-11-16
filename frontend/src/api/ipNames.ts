/**
 * IP 對照表(docs/API.md §11;IMPL-PLAN AC3)。讀取 / 匯出 / 範本 netops.ip-name.read,編輯 / 匯入 netops.ip-name.write
 * (畫面節點 netops.ip-name-page.read / .write,只給網管)。PA 畫面的名稱不走這裡(見 composables/ipNames.ts)。
 */
import { download, http } from './gateway';

export const DEVICE_TYPES = ['筆電', '桌機', '伺服器', '印表機', '網路設備', '其他'] as const;
export const IP_NAME_LIMITS = { name: 50, department: 50, device: 100, note: 200 } as const;
/** 上傳檔上限(後端 IMPORT_MAX_BYTES) */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export interface IpNameEntry {
  id: string;
  ip: string;
  name: string;
  department: string;
  device: string;
  deviceType: string;
  note: string;
  updatedAt: string;
  updatedBy: string;
}
export interface IpNameList {
  items: IpNameEntry[];
  total: number;
  page: number;
  pageSize: number;
  version: number;
}
export type IpNameBody = Pick<IpNameEntry, 'ip' | 'name' | 'department' | 'device' | 'deviceType' | 'note'>;

export interface ImportPreview {
  id: string;
  fileName: string;
  total: number;
  skipped: number;
  errors: { row: number; ip: string; message: string }[];
  counts: { added: number; changed: number; removed: number; unchanged: number };
  diff: { added: IpNameEntry[]; changed: { before: IpNameEntry; after: IpNameEntry }[]; removed: IpNameEntry[]; unchanged: number };
  expiresAt: string;
}

const path = (id: string) => `/api/netops/ip-names/${encodeURIComponent(id)}` as const;

/** ArrayBuffer → base64(分段,避免大檔 String.fromCharCode 參數過多) */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 副檔名 → 匯入格式;不支援回 null */
export const importFormatOf = (fileName: string): 'csv' | 'xlsx' | null => {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'xlsx' ? 'xlsx' : ext === 'csv' ? 'csv' : null;
};

export const ipNames = {
  /** 有關鍵字時用 POST 搜尋(姓名不放進網址與存取日誌) */
  list: (q: string, page: number, pageSize: number) =>
    q.trim()
      ? http.post<IpNameList>('/api/netops/ip-name-searches', { q: q.trim(), page, pageSize })
      : http.get<IpNameList>('/api/netops/ip-names', { query: { page, pageSize } }),
  create: (body: IpNameBody) => http.post<IpNameEntry>('/api/netops/ip-names', body),
  update: (id: string, body: IpNameBody) => http.put<IpNameEntry>(path(id), body),
  remove: (id: string) => http.delete(path(id)),
  exportFile: (format: 'xlsx' | 'csv') => download('/api/netops/ip-names', { format }, `IP對照表.${format}`),
  template: (format: 'xlsx' | 'csv') => download('/api/netops/ip-name-template', { format }, `IP對照表_範本.${format}`),
  preview: (fileName: string, format: 'csv' | 'xlsx', data: string) => http.post<ImportPreview>('/api/netops/ip-name-imports', { fileName, format, data }),
  confirm: (id: string) => http.post<{ added: number; changed: number; removed: number; unchanged: number; total: number }>(`/api/netops/ip-name-imports/${encodeURIComponent(id)}/confirm`),
  discard: (id: string) => http.delete(`/api/netops/ip-name-imports/${encodeURIComponent(id)}`),
};
