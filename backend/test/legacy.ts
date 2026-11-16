/**
 * 舊版程式原封不動執行(D4 測試基準用):讀 server/ 的原始碼,只替換 import 那幾行,以 data: URL 載入
 *   replace:原文 → 替換文字(原文找不到就丟錯,避免舊版改了而測試沒發現)
 *   其他舊版模組的相對 import(./x.js、../lib/x.js)改成絕對路徑,直接載入舊版檔案
 *   exports:追加 export 未匯出的內部函式(只加在檔尾,不改內容)
 * 需要的外部相依(設定、FTP 等)用 globalThis.__legacy 傳入:替換文字寫 `const { a, b } = globalThis.__legacy`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.resolve(here, '../../server');
export const LEGACY_LIB = path.join(SERVER, 'lib');

export const legacyText = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8').replace(/\r\n/g, '\n');

let seq = 0;
export async function loadLegacy<T = Record<string, any>>(rel: string, { replace = {}, exports = [], deps = {} }: { replace?: Record<string, string>; exports?: string[]; deps?: Record<string, unknown> } = {}): Promise<T> {
  let src = legacyText(rel);
  for (const [from, to] of Object.entries(replace)) {
    if (!src.includes(from)) throw new Error(`舊版 ${rel} 找不到要替換的內容:${from.slice(0, 60)}`);
    src = src.replace(from, to);
  }
  const dir = path.dirname(path.join(SERVER, rel));
  src = src.replace(/from '(\.\.?\/[\w./-]+\.js)'/g, (_m, spec: string) => `from '${pathToFileURL(path.resolve(dir, spec)).href}'`);
  if (exports.length) src += `\nexport { ${exports.join(', ')} }\n`;
  // 每次載入是獨立的模組實例(模組層級的狀態不共用);deps 以唯一鍵傳入
  const key = `__legacy${++seq}`;
  (globalThis as Record<string, unknown>)[key] = deps;
  src = src.replaceAll('globalThis.__legacy', `globalThis.${key}`);
  return (await import(`data:text/javascript,${encodeURIComponent(src)}`)) as T;
}
