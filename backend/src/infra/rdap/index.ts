/**
 * IP 註冊資料(RDAP)與 DNS 反查(由舊版 server/lib/iplearn.js 搬移,IMPL-PLAN A1、ARCHITECTURE D10)
 *   外部 IP 自動學習用;回應的解析在 modules/iplearn/core/iplearn.js(parseRdap)
 *   登記處、逾時與轉址方式同舊版(rdap.org 會回 403,直接查各區登記處;ARIN 查不到的會轉址到負責的登記處)
 * 2026-11-05 主機 2 容器內實測:ARIN、APNIC、RIPE 可連;LACNIC、AFRINIC 逾時(每次查詢最多多等 2 × 10 秒,同舊版依序嘗試)
 */
import dns from 'node:dns/promises';

const RDAP = ['https://rdap.arin.net/registry/ip/', 'https://rdap.apnic.net/ip/', 'https://rdap.db.ripe.net/ip/', 'https://rdap.lacnic.net/rdap/ip/', 'https://rdap.afrinic.net/rdap/ip/'];

/** IPv4 才查(呼叫端已用 isLearnable 篩過;這裡再擋一次,避免組出奇怪的 URL) */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function createRdap(fetchImpl: typeof fetch = fetch, parse: (j: unknown) => unknown = (j) => j) {
  /** 依序查各登記處,第一個有網段資料的回應(parse 不丟錯)就回傳;全部失敗丟出最後一個錯誤 */
  async function lookup(ip: string): Promise<unknown> {
    if (!IPV4.test(ip)) throw new Error('不是 IPv4 位址');
    let lastErr: unknown;
    for (const base of RDAP) {
      try {
        const res = await fetchImpl(base + ip, { headers: { Accept: 'application/rdap+json' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
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
      return names.slice(0, 3).join(', ');
    } catch {
      return '';
    }
  }

  return { lookup, reverseDns };
}
