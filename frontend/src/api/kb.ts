/**
 * 網通知識庫(docs/API.md §7;後端 B2-kb)。查詢需要 netops.kb.read,新增 / 修改 / 刪除需要 netops.kb.write
 * (畫面節點 netops.kb-page.write)。AI 相關(語意搜尋、向量同步、外部 IP 自動學習)不搬移(ARCHITECTURE D17)。
 * 內容是 Markdown,輸出前端一律經 DOMPurify(composables/markdown.ts;AGENT.md §7.4)。
 */
import { http } from './gateway';

export interface KbNote {
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

export interface KbCompilation {
  count: number;
  updated: string | null;
  chars: number;
}

export interface KbNoteBody {
  title: string;
  ips: string[];
  tags: string[];
  content: string;
  source?: string;
}

/** 單則內容上限、IP 與標籤數量上限(§7) */
export const KB_CONTENT_MAX = 20_000;
export const KB_TITLE_MAX = 300;
export const KB_IPS_MAX = 30;
export const KB_TAGS_MAX = 10;

const notePath = (id: string) => `/api/netops/kb/notes/${encodeURIComponent(id)}` as const;
export const kb = {
  /** q:空白分隔的關鍵字,全部符合;新的在前 */
  list: (q: string, page: number, pageSize: number) =>
    http.get<{ items: KbNote[]; total: number; page: number; pageSize: number; compilation: KbCompilation }>('/api/netops/kb/notes', {
      query: { q: q.trim() || undefined, page, pageSize },
    }),
  get: (id: string) => http.get<KbNote>(notePath(id)),
  /** 匯整檔(Markdown 文字) */
  compilation: () => http.get<string>('/api/netops/kb/compilation', { headers: { Accept: 'text/markdown' } }),
  create: (body: KbNoteBody) => http.post<KbNote>('/api/netops/kb/notes', body),
  update: (id: string, body: KbNoteBody) => http.put<KbNote>(notePath(id), body),
  remove: (id: string) => http.delete(notePath(id)),
  markdownPath: (id: string) => `${notePath(id)}/markdown` as const,
  compilationPath: '/api/netops/kb/compilation' as const,
};

/** 「a, b、c」→ ['a', 'b', 'c'](逗號、頓號、換行分隔;去空白與重複) */
export const splitList = (s: string): string[] => [
  ...new Set(
    s
      .split(/[,\uFF0C\u3001\n]/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];
