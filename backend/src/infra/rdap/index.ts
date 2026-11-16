/**
 * IP 註冊資料(RDAP)與 DNS 反查(由舊版 server/lib/iplearn.js 搬移,IMPL-PLAN A1、ARCHITECTURE D10)
 *   外部 IP 自動學習用;回應的解析在 modules/iplearn/core/iplearn.js(parseRdap,由呼叫端傳入)
 *   登記處與逾時同舊版(rdap.org 會回 403,直接查各區登記處;ARIN 查不到的會轉址到負責的登記處)
 * 與舊版不同(審查修正):轉址只跟到五個登記處的 https 網址(最多 3 次);DNS 反查名稱只接受主機名稱格式
 *   (PTR 由 IP 擁有者設定,內容會進模型提示與知識庫)。
 * 2026-11-05 主機 2 容器內實測:ARIN、APNIC、RIPE 可連;LACNIC、AFRINIC 逾時(每次查詢最多多等 2 × 10 秒,同舊版依序嘗試)
 */
import dns from 'node:dns/promises';

const RDAP = ['https://rdap.arin.net/registry/ip/', 'https://rdap.apnic.net/ip/', 'https://rdap.db.ripe.net/ip/', 'https://rdap.lacnic.net/rdap/ip/', 'https://rdap.afrinic.net/rdap/ip/'];
const HOSTS = new Set(RDAP.map((u) => new URL(u).host));
const MAX_REDIRECTS = 3;

/** IPv4 才查(呼叫端已用 isLearnable 篩過;這裡再擋一次,避免組出奇怪的 URL) */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
/** PTR 名稱:主機名稱格式才接受 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.?$/i;

/** parse(j):回應 JSON 沒有網段資料時丟出錯誤(改查下一個登記處,同舊版) */
export function createRdap(fetchImpl: typeof fetch, parse: (j: unknown) => unknown) {
  /** 只跟隨登記處之間的 https 轉址 */
  async function get(url: string): Promise<Response> {
    let u = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await fetchImpl(u, { headers: { Accept: 'application/rdap+json' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (res.status < 300 || res.status >= 400) return res;
      const next = new URL(res.headers.get('location') ?? '', u);
      if (next.protocol !== 'https:' || !HOSTS.has(next.host)) throw new Error('RDAP 轉址到登記處以外的網址');
      u = next.href;
    }
    throw new Error('RDAP 轉址次數過多');
  }

  /** 依序查各登記處,第一個有網段資料的回應就回傳;全部失敗丟出最後一個錯誤 */
  async function lookup(ip: string): Promise<unknown> {
    if (!IPV4.test(ip)) throw new Error('不是 IPv4 位址');
    let lastErr: unknown;
    for (const base of RDAP) {
      try {
        const res = await get(base + ip);
        if (!res.ok) throw new Error(`RDAP ${res.status}`);
        const j = await res.json();
        parse(j);
        return j;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('RDAP 查詢失敗');
  }

  /** DNS 反查(最多 5 秒,失敗回 '') */
  async function reverseDns(ip: string): Promise<string> {
    try {
      const names = await Promise.race([dns.reverse(ip), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000).unref())]);
      return names.filter((n) => HOSTNAME.test(n)).slice(0, 3).join(', ');
    } catch {
      return '';
    }
  }

  return { lookup, reverseDns };
}
