/**
 * 假 Gateway:知識庫(docs/API.md §7)。資料只在記憶體;內容含一段惡意 HTML,用來確認畫面有經 DOMPurify。
 */
import type { MockCtx } from './types.ts';

interface Note {
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

const now = () => new Date().toISOString().replace('Z', '').slice(0, 19) + '+08:00';
const notes: Note[] = [
  {
    id: '202611021030-a1b2c3',
    title: '10.10.130.66 FTP 伺服器',
    ips: ['10.10.130.66'],
    tags: ['FTP'],
    author: 'S112009 測試人員',
    created: '2026-11-02T10:30:00+08:00',
    updated: '2026-11-02T10:30:00+08:00',
    updatedBy: '',
    source: '',
    content:
      '# FTP 伺服器\n\nPA-560 與 DC 每天把 log 匯出到這台。\n\n| 目錄 | 內容 |\n| --- | --- |\n| `/` | TRAFFIC |\n| `/AD_Log_Backup` | AD 事件 |\n\n[說明文件](https://example.com/ftp)\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>',
  },
  {
    id: '202611011500-d4e5f6',
    title: 'Microsoft 365 寄信伺服器',
    ips: ['40.92.0.0/15'],
    tags: ['自動學習', 'Microsoft'],
    author: '系統',
    created: '2026-11-01T15:00:00+08:00',
    updated: '2026-11-01T15:00:00+08:00',
    updatedBy: '',
    source: 'RDAP:MSFT;DNS:mail-*.outbound.protection.outlook.com',
    content: '- 屬於 Microsoft Exchange Online\n- 寄信到公司的正常流量',
  },
];

const compilation = () => {
  const text = `# 網通知識庫匯整\n\n${notes.map((n) => `## ${n.title}\n\n${n.content}`).join('\n\n')}`;
  return { text, info: { count: notes.length, updated: notes[0]?.updated ?? null, chars: text.length } };
};

const ID = /^[\w-]{6,64}$/;
const list = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,,、]/))
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, max);

export function handleKb({ method, path, url, body, need, send, fail, sendFile, user }: MockCtx): boolean {
  if (!path.startsWith('/api/netops/kb/')) return false;
  const p = path.slice('/api/netops/kb'.length);
  const read = () => need('netops.kb.read');
  const write = () => need('netops.kb.write');

  if (method === 'GET' && p === '/notes') {
    if (!read()) return true;
    const words = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const hit = notes.filter((n) => words.every((w) => `${n.title} ${n.content} ${n.ips.join(' ')} ${n.tags.join(' ')} ${n.author}`.toLowerCase().includes(w)));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 50));
    send(200, { items: hit.slice((page - 1) * pageSize, page * pageSize), total: hit.length, page, pageSize, compilation: compilation().info });
    return true;
  }
  if (method === 'GET' && p === '/compilation') {
    if (!read()) return true;
    sendFile('text/markdown; charset=utf-8', '網通知識庫匯整.md', compilation().text);
    return true;
  }
  if (method === 'POST' && p === '/notes') {
    if (!write()) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    if (!String(b.content ?? '').trim()) return (fail(400, 'VALIDATION_FAILED', 'content 必填'), true);
    const t = now();
    const n: Note = {
      id: `${t.replace(/\D/g, '').slice(0, 12)}-${Math.random().toString(16).slice(2, 8)}`,
      title:
        String(b.title ?? '').trim() ||
        String(b.content)
          .split('\n')[0]!
          .replace(/^#+\s*/, '')
          .slice(0, 60),
      ips: list(b.ips, 30),
      tags: list(b.tags, 10),
      author: user,
      created: t,
      updated: t,
      updatedBy: '',
      source: String(b.source ?? ''),
      content: String(b.content),
    };
    notes.unshift(n);
    send(201, n);
    return true;
  }
  const m = p.match(/^\/notes\/([^/]+)(\/markdown)?$/);
  if (!m) return false;
  if (!ID.test(m[1]!)) return (fail(400, 'VALIDATION_FAILED', 'id 格式錯誤'), true);
  const i = notes.findIndex((n) => n.id === m[1]);
  if (method === 'DELETE') {
    if (!write()) return true;
    if (i >= 0) notes.splice(i, 1);
    send(204, null);
    return true;
  }
  if (!read()) return true;
  if (i < 0) return (fail(404, 'NETOPS_KB_NOTE_NOT_FOUND', '找不到筆記'), true);
  const n = notes[i]!;
  if (method === 'GET' && m[2]) return (sendFile('text/markdown; charset=utf-8', `${n.title}.md`, n.content), true);
  if (method === 'GET') return (send(200, n), true);
  if (method === 'PUT') {
    if (!write()) return true;
    const b = (body ?? {}) as Record<string, unknown>;
    if (!String(b.content ?? '').trim()) return (fail(400, 'VALIDATION_FAILED', 'content 必填'), true);
    Object.assign(n, {
      title: String(b.title ?? n.title),
      ips: list(b.ips, 30),
      tags: list(b.tags, 10),
      content: String(b.content),
      source: String(b.source ?? n.source),
      updated: now(),
      updatedBy: user,
    });
    send(200, n);
    return true;
  }
  return false;
}
