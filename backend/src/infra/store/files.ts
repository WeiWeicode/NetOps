/**
 * 資料檔的底層讀寫(只給 infra/store 內部使用,模組不直接 import;ARCHITECTURE D8、AGENT.md §7.2)。
 * 寫入一律先寫暫存檔再改名,程序中斷時不會留下寫一半的檔案。
 * 讀取:檔案不存在回 null;其他錯誤(權限、內容損壞)一律丟出 DataFileError,不當成「沒有資料」(AGENT.md §5)。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ensureDir = (dir: string): void => void fs.mkdirSync(dir, { recursive: true });

export function writeAtomic(file: string, data: string | Buffer): void {
  // 暫存檔名不重複:同一個檔案同時有兩個寫入者時不會互相覆蓋
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export const writeJson = (file: string, value: unknown): void => writeAtomic(file, JSON.stringify(value));
export const writeGzipJson = (file: string, value: unknown): void => writeAtomic(file, zlib.gzipSync(JSON.stringify(value)));
export const writeGzipText = (file: string, text: string): void => writeAtomic(file, zlib.gzipSync(text, { level: 6 }));

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

/** 資料檔損壞或讀不到(不是不存在);訊息只含檔名,不含資料目錄路徑 */
export class DataFileError extends Error {
  constructor(file: string, cause: unknown) {
    super(`資料檔無法讀取:${path.basename(file)}(${(cause as NodeJS.ErrnoException).code ?? (cause as Error).name})`, { cause });
  }
}

function read<T>(file: string, parse: (buf: Buffer) => T): T | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw new DataFileError(file, err);
  }
  try {
    return parse(buf);
  } catch (err) {
    throw new DataFileError(file, err);
  }
}

/** 檔案不存在回 null;損壞丟 DataFileError */
export const readJson = <T>(file: string): T | null => read(file, (b) => JSON.parse(b.toString('utf8')) as T);
export const readGzipJson = <T>(file: string): T | null => read(file, (b) => JSON.parse(zlib.gunzipSync(b).toString('utf8')) as T);
export const readText = (file: string): string | null => read(file, (b) => b.toString('utf8'));
export async function readGzipText(file: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw new DataFileError(file, err);
  }
  try {
    return zlib.gunzipSync(buf).toString('utf8');
  } catch (err) {
    throw new DataFileError(file, err);
  }
}

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
  } catch (err) {
    if (isMissing(err)) return [];
    throw new DataFileError(dir, err);
  }
};

/** 檔名只允許安全字元,避免組出資料目錄以外的路徑 */
export function safeJoin(dir: string, name: string): string {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error(`不合法的資料檔名稱:${name}`);
  const base = path.resolve(dir);
  const p = path.join(base, name);
  if (path.dirname(p) !== base) throw new Error(`不合法的資料檔名稱:${name}`);
  return p;
}
