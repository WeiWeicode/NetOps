/**
 * 流量總覽的純函式(畫面與測試共用;規則同舊版 src/views/PaDashboard.vue):
 *   排行點選 → 明細查詢條件(query key 同 docs/API.md §4.3 的查詢欄位)、IP 排行補上用了哪些 App。
 */
import type { TopEntry } from '@/api/pa';

export type SearchCond = Record<string, string>;

/** 「tcp/443」→ { proto, port } */
export function portCond(key: string): SearchCond {
  const [proto = '', port] = key.split('/');
  return port ? { proto, port } : { proto };
}

/** 「trust → untrust」→ { fromZone, toZone }(? 表示不明,不帶該條件) */
export function zoneCond(key: string): SearchCond {
  const [fromZone = '', toZone = ''] = key.split(' → ');
  const out: SearchCond = {};
  if (fromZone && fromZone !== '?') out.fromZone = fromZone;
  if (toZone && toZone !== '?') out.toZone = toZone;
  return out;
}

/** 去掉排行名稱後的說明(「1.2.3.4(TW)」→「1.2.3.4」;全形與半形括號) */
export const stripNote = (key: string) => key.replace(/\s*[(（].*$/, '');

/** 各排行點選後帶到明細查詢的條件;沒有列出的排行不可點選 */
export const PICK: Record<string, (k: string) => SearchCond> = {
  src: (k) => ({ src: k }),
  dst: (k) => ({ dst: k }),
  dport: portCond,
  app: (k) => ({ app: k }),
  rule: (k) => ({ rule: k }),
  zone: zoneCond,
  dstCountry: (k) => ({ country: k }),
  user: (k) => ({ user: k }),
  blockSrc: (k) => ({ src: k, action: 'block' }),
  blockDst: (k) => ({ dst: k, action: 'block' }),
  blockDport: (k) => ({ ...portCond(k), action: 'block' }),
  blockRule: (k) => ({ rule: k, action: 'block' }),
  inboundBlockSrc: (k) => ({ src: stripNote(k), action: 'block' }),
  inboundAllow: (k): SearchCond => {
    const m = k.match(/^(\S+) → (\S+):(\w+)\/(\d+)$/);
    return m ? { src: m[1]!, dst: m[2]!, proto: m[3]!, port: m[4]!, action: 'allow' } : { q: k };
  },
  riskApp: (k) => ({ app: stripNote(k), action: 'allow' }),
  // 資料外流 / AI 應用
  upSrc: (k) => ({ src: k, action: 'allow' }),
  upDst: (k) => ({ dst: stripNote(k), action: 'allow' }),
  upRiskSrc: (k) => ({ src: k, action: 'allow' }),
  upRiskApp: (k) => ({ app: stripNote(k), action: 'allow' }),
  aiSrc: (k) => ({ src: k, action: 'allow' }),
  aiApp: (k) => ({ app: k, action: 'allow' }),
};

/**
 * IP 排行加上「用了哪些 App」:pairs 的 key 是「IP → App」(依次數與依上傳量各取前幾名合併),
 * 例:10.10.112.74(openai-chatgpt、google-gemini)
 */
export function withApps(items: TopEntry[], pairs: TopEntry[]): (TopEntry & { sub: string })[] {
  const apps = new Map<string, Set<string>>();
  for (const p of pairs) {
    const [ip = '', app] = p.key.split(' → ');
    if (!app) continue;
    const set = apps.get(ip) ?? new Set<string>();
    set.add(app);
    apps.set(ip, set);
  }
  return items.map((x) => ({ ...x, sub: apps.has(x.key) ? [...apps.get(x.key)!].slice(0, 3).join('、') : '' }));
}

/** 疑似掃描的研判(同舊版) */
export function scanVerdict(s: { dsts: number; ports: number }): { label: string; tone: string } {
  if (s.ports >= 50) return { label: '疑似 Port 掃描', tone: 'danger' };
  if (s.dsts >= 100) return { label: '疑似主機掃描', tone: 'warning' };
  return { label: '持續嘗試連線', tone: 'neutral' };
}
