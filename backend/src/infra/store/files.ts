/**
 * 資料檔的底層讀寫(只給 infra/store 內部使用,模組不直接 import;ARCHITECTURE D8、AGENT.md §7.2)。
 * 寫入一律先寫 .tmp 再改名,程序中斷時不會留下寫一半的檔案。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ensureDir = (dir: string): void => void fs.mkdirSync(dir, { recursive: true });

export function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export const writeJson = (file: string, value: unknown): void => writeAtomic(file, JSON.stringify(value));
export const writeGzipJson = (file: string, value: unknown): void => writeAtomic(file, zlib.gzipSync(JSON.stringify(value)));
export const writeGzipText = (file: string, text: string): void => writeAtomic(file, zlib.gzipSync(text, { level: 6 }));

/** 檔案不存在或內容損壞時回傳 null(呼叫端決定是否視為缺資料) */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readGzipJson<T>(file: string): T | null {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export const readGzipText = async (file: string): Promise<string> => zlib.gunzipSync(await fs.promises.readFile(file)).toString('utf8');

export const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

export const removeFile = (file: string): void => fs.rmSync(file, { force: true });
export const exists = (file: string): boolean => fs.existsSync(file);
export const mtimeMs = (file: string): number | null => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};
export const listFiles = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** 檔名只允許安全字元,避免組出資料目錄以外的路徑 */
export function safeJoin(dir: string, name: string): string {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error(`不合法的資料檔名稱:${name}`);
  const p = path.join(dir, name);
  if (path.dirname(p) !== dir) throw new Error(`不合法的資料檔名稱:${name}`);
  return p;
}
