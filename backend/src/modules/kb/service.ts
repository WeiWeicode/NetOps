/**
 * 知識庫(由舊版 server/lib/kb.js 搬移,IMPL-PLAN B2):筆記查詢、新增、修改、刪除與匯整檔
 *   筆記檔有變動才重新讀;新增 / 修改 / 刪除時重新產生匯整檔,筆記檔被手動修改時下次讀取也會重新產生
 *   讀寫只經 store.kb(ARCHITECTURE D8)
 */
import crypto from 'node:crypto';
import { AppError } from '../../errors.js';
import type { KbStore } from '../../infra/store/index.js';
import { buildAll, buildNote, ID_RE, parse, searchNotes, serialize } from './core/notes.js';

export interface Note {
  id: string;
  title: string;
  ips: string[];
  tags: string[];
  author: string;
  created: string;
  updated: string;
  updatedBy: string;
  source: string;
  content: string;
}

export interface NoteInput {
  title?: string;
  ips?: string[] | string;
  tags?: string[] | string;
  content: string;
  source?: string;
}

export type KbService = ReturnType<typeof createKbService>;

/** 筆記總數上限(避免塞爆磁碟;每次寫入都要重產匯整檔) */
export const KB_MAX_NOTES = 5000;

const notFound = () => new AppError(404, 'NETOPS_KB_NOTE_NOT_FOUND', '找不到這則筆記');
const checkId = (id: string) => {
  if (!ID_RE.test(String(id))) throw new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field: 'id', message: '筆記代號不正確' }]);
};

export function createKbService(store: KbStore, log?: { warn(obj: object, msg: string): void }) {
  let cache: { sig: string; notes: Note[] } | null = null;
  let all: { sig: string; text: string; order: string[]; updated: string; count: number } | null = null;

  /** 全部筆記(新的在前);檔案有變動才重新讀 */
  function listNotes(): { sig: string; notes: Note[] } {
    const files = store.listNotes();
    const sig = files.map((f) => `${f.id}:${f.version}`).join('|');
    if (cache?.sig !== sig) {
      // 列舉後才被刪除的檔案略過
      const notes = files.flatMap((f) => {
        const text = store.readNote(f.id);
        return text === null ? [] : [parse(f.id, text) as Note];
      });
      notes.sort((a, b) => b.updated.localeCompare(a.updated));
      cache = { sig, notes };
    }
    return cache;
  }

  function getNote(id: string): Note {
    checkId(id);
    const text = store.readNote(id);
    if (text === null) throw notFound();
    return parse(id, text) as Note;
  }

  /** 匯整檔(筆記有變動或檔案不存在時重新產生):{ text, updated, count } */
  function compilation() {
    const { sig, notes } = listNotes();
    if (all?.sig !== sig || store.readCompilation() === null) {
      const b = buildAll(notes);
      store.writeCompilation(b.text);
      all = { sig, ...b, count: notes.length };
    }
    return all;
  }

  /** 新增(id 省略)或修改;author 為「工號 姓名」 */
  function saveNote(input: NoteInput, author: string, id?: string): Note {
    if (!String(input.content ?? '').trim()) throw new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field: 'content', message: '筆記內容不可空白' }]);
    const old = id ? getNote(id) : null;
    if (!old && store.listNotes().length >= KB_MAX_NOTES) throw new AppError(409, 'NETOPS_KB_LIMIT', `筆記已達上限 ${KB_MAX_NOTES} 則`);
    // 新增時代號(分鐘 + 亂數)萬一重複就重新產生,不覆蓋既有筆記
    const newId = (now: string) => {
      for (let i = 0; i < 10; i++) {
        const candidate = `${now.replace(/\D/g, '').slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}`;
        if (store.readNote(candidate) === null) return candidate;
      }
      throw new Error('無法產生不重複的筆記代號');
    };
    const note = buildNote(input as Parameters<typeof buildNote>[0], author, old, newId) as Note;
    store.writeNote(note.id, serialize(note));
    refresh();
    return note;
  }

  /** 刪除;本來就沒有回 false(路由視為成功,冪等) */
  function deleteNote(id: string): boolean {
    checkId(id);
    const removed = store.deleteNote(id);
    if (removed) refresh();
    return removed;
  }

  /** 寫入後清快取並重產匯整檔;重產失敗不影響已寫入的筆記(下次讀取時再重產) */
  function refresh() {
    cache = null;
    all = null;
    try {
      compilation();
    } catch (err) {
      all = null;
      log?.warn({ err }, '重新產生知識庫匯整檔失敗,下次讀取時再試');
    }
  }

  const search = (q?: string) => searchNotes(listNotes().notes, q) as Note[];

  /** 原始 .md(下載用) */
  function markdown(id: string) {
    checkId(id);
    const text = store.readNote(id);
    if (text === null) throw notFound();
    return { title: (parse(id, text) as Note).title, text };
  }

  return { listNotes: () => listNotes().notes, getNote, saveNote, deleteNote, compilation, search, markdown };
}
