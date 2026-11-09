/**
 * AI 問答的對話與事件處理(由舊版 src/views/PaAsk.vue、stores/chat.js 搬移;IMPL-PLAN A1)
 *   對話放在模組層級的 reactive:切換頁面回來還在,PA 與 AD 分開;重新整理就清空(同舊版,不存 localStorage)
 *   applyEvent:SSE 事件 → 訊息狀態(純函式,可測試)
 */
import { reactive } from 'vue';
import type { HistoryItem, SseEvent } from '@/api/ai';

export type Source = 'pa' | 'ad';

export interface Evidence {
  label: string;
  summary?: boolean;
  matched?: number;
  allow?: number;
  block?: number;
  flows?: number;
  filesScanned?: number;
  files?: number;
  flowFiles?: number;
  rows?: number;
  seconds?: number;
  partial?: boolean;
  cached?: boolean;
  missing?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  error?: string;
  ips?: string[];
  ports?: number[];
  evidence?: Evidence | null;
  events?: { summary?: boolean; hits?: { type: string; label: string; total: number; kinds: number }[] } | null;
  ad?: { label: string; total: number } | null;
  notes?: { id: string; title: string; related: boolean }[];
  notesOmitted?: { id: string; title: string }[];
  vectorError?: boolean;
  truncated?: boolean;
  /** 送出時的期間(datetime-local);看原始紀錄用 */
  from?: string;
  to?: string;
}

const store = reactive<Record<Source, ChatMessage[]>>({ pa: [], ad: [] });
export const messagesOf = (source: Source) => store[source];
export function clearMessages(source: Source) {
  store[source].splice(0);
}

/** 對話紀錄(不含錯誤與停止的回答;同舊版 historyOf) */
export const historyOf = (messages: ChatMessage[]): HistoryItem[] =>
  messages
    .filter((m) => m.content && !m.error)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }))
    // 後端只送最近 6 則給模型;請求最多 100 則(API.md §10.1)
    .slice(-20);

const fmt = (n: number | undefined) => (Number(n) || 0).toLocaleString('en-US');

/** SSE 事件 → 更新回覆訊息(同舊版 PaAsk.vue 的事件處理);isAd:AD 問答 */
export function applyEvent(r: ChatMessage, e: SseEvent, isAd: boolean) {
  const p = e.data as Record<string, unknown>;
  switch (e.event) {
    case 'meta': {
      const ips = (p.ips as string[]) ?? [];
      const ports = (p.ports as number[]) ?? [];
      r.ips = ips;
      r.ports = ports;
      r.status = isAd ? '整理 AD 事件記錄...' : ips.length || ports.length ? `查詢 ${[...ips, ...ports.map((x) => `Port ${x}`)].join('、')} 的 log...` : '整理期間統計...';
      break;
    }
    case 'scan':
      r.status = p.mode === 'flows' ? '查詢連線組合統計...' : `掃描 log ${fmt(p.filesScanned as number)} / ${fmt(p.files as number)} 個檔,找到 ${fmt(p.matched as number)} 筆...`;
      break;
    case 'evidence':
      r.evidence = p as unknown as Evidence;
      r.status = 'AI 分析中...';
      break;
    case 'events':
      r.events = p as ChatMessage['events'];
      break;
    case 'ad':
      r.ad = p as unknown as ChatMessage['ad'];
      if (!r.evidence) r.status = 'AI 分析中...';
      break;
    case 'notes':
      r.notes = p.used as ChatMessage['notes'];
      r.notesOmitted = p.omitted as ChatMessage['notesOmitted'];
      r.vectorError = p.vectorError === true;
      break;
    case 'thinking':
      r.status = `AI 思考中...(${fmt(p.chars as number)} 字)`;
      break;
    case 'content':
      r.status = 'AI 撰寫中...';
      r.content += String(p.text ?? '');
      break;
    case 'done':
      r.truncated = p.truncated === true;
      break;
  }
}

/** 到明細查詢看原始紀錄(同舊版 openSearch):1 個 IP 用「任一方 IP」,2 個 IP 再加關鍵字;AD 到 AD 的明細查詢 */
export function searchLink(m: ChatMessage, from: string, to: string, isAd: boolean): { path: string; query: Record<string, string> } {
  const q: Record<string, string> = { from, to };
  if (isAd || m.ad) {
    if (m.ips?.[0] && !m.ips[0].includes('/')) q.ip = m.ips[0];
    return { path: '/ad/search', query: q };
  }
  if (m.ips?.[0]) q.ip = m.ips[0];
  if (m.ips?.[1]) q.q = m.ips[1].replace(/\/\d+$/, '');
  if (m.ports?.length) q.port = m.ports.join(',');
  if (m.evidence?.block && !m.evidence?.allow) q.action = 'block';
  return { path: '/firewall/search', query: q };
}

/** 問答頁的連結:從其他頁帶問題進來(同舊版 ?q=&from=&to=,由使用者送出);from / to 為 YYYY-MM-DD */
export function askLink(q: string, from: string, to: string, source: Source = 'pa') {
  return { path: source === 'ad' ? '/ad/ask' : '/firewall/ask', query: { q, ...(from ? { from, to: to || from } : {}) } };
}
