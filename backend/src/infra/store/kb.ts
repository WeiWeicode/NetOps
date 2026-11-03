/**
 * 知識庫的存取(ARCHITECTURE §4.1;位置與格式同舊版 uploads/knowledge,切換時直接複製,D14)
 *   knowledge/{id}.md             一則筆記
 *   knowledge/_knowledge-all.md   匯整檔(_ 開頭是系統產生的檔案,不是筆記)
 * 知識庫不可重建,要備份(Q3,D1)。
 */
import path from 'node:path';
import { listFiles, mtimeMs, readText, removeFile, safeJoin, writeAtomic } from './files.js';

const ID_RE = /^[\w-]{6,64}$/;
const ALL = '_knowledge-all.md';

export interface KbStore {
  /** 全部筆記的代號與修改時間(給呼叫端判斷快取是否過期) */
  listNotes(): { id: string; version: number }[];
  readNote(id: string): string | null;
  writeNote(id: string, text: string): void;
  /** 刪除;本來就沒有回 false */
  deleteNote(id: string): boolean;
  readCompilation(): string | null;
  writeCompilation(text: string): void;
}

export function createKbStore(root: string): KbStore {
  const dir = path.join(root, 'knowledge');
  const file = (id: string) => {
    if (!ID_RE.test(id)) throw new Error(`不合法的筆記代號:${id}`);
    return safeJoin(dir, `${id}.md`);
  };
  return {
    listNotes: () =>
      listFiles(dir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('_') && ID_RE.test(f.slice(0, -3)))
        .map((f) => ({ id: f.slice(0, -3), version: mtimeMs(path.join(dir, f)) ?? 0 })),
    readNote: (id) => readText(file(id)),
    writeNote: (id, text) => writeAtomic(file(id), text),
    deleteNote(id) {
      if (mtimeMs(file(id)) === null) return false;
      removeFile(file(id));
      return true;
    },
    readCompilation: () => readText(path.join(dir, ALL)),
    writeCompilation: (text) => writeAtomic(path.join(dir, ALL), text),
  };
}
