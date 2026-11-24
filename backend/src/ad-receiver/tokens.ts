/**
 * DC Token 對應表(AD-1;審查 H3、docs/AD-AGENT-PLAN.md §4.1、§7 第 1 點)。
 * 檔案由主機機密腳本 deploy/host2-set-ad-secrets.sh 產生,以 Docker secret ad_agent_tokens 唯讀掛載;
 * 只存 Token 的 SHA-256,容器內沒有 Token 明文。一行一台 DC,# 開頭與空白行略過:
 *
 *   <computer> <domain> <sha256(token) 64 個小寫十六進位>
 *   GSMC-DC1 gsmc.com.tw 3f5a…
 *
 * 一台 DC 一把 Token;作廢單台 = 刪掉那一行後重啟 netops-ad-receiver(不影響其他 DC 與 netops-pa)。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface DcIdentity {
  /** DC 主機名稱(對應表的寫法;寫進 Redis 鍵與 ClickHouse 的值以它為準) */
  computer: string;
  /** AD 網域(DNS 名稱) */
  domain: string;
}

export class TokenFileError extends Error {}

const COMPUTER = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const DOMAIN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const HASH = /^[0-9a-f]{64}$/;
/** Token 本身:32 bytes 隨機值的十六進位(腳本產生 64 字);長度限制防止超長標頭耗 CPU */
const TOKEN = /^[0-9A-Za-z_-]{32,128}$/;

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface TokenTable {
  /** Token → DC;查不到回 null */
  lookup(token: string | undefined): DcIdentity | null;
  readonly size: number;
  readonly computers: readonly string[];
}

/** 解析對應表文字;格式錯誤、重複的 computer 或 Token、一台都沒有時拋 TokenFileError(錯誤訊息只帶行號,不帶內容) */
export function parseTokenTable(text: string): TokenTable {
  const byHash = new Map<string, DcIdentity>();
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) throw new TokenFileError(`DC Token 對應表第 ${i + 1} 行格式錯誤(應為:computer domain sha256)`);
    const [computer, domain, hash] = parts as [string, string, string];
    if (!COMPUTER.test(computer)) throw new TokenFileError(`DC Token 對應表第 ${i + 1} 行 computer 格式錯誤`);
    if (!DOMAIN.test(domain)) throw new TokenFileError(`DC Token 對應表第 ${i + 1} 行 domain 格式錯誤`);
    if (!HASH.test(hash)) throw new TokenFileError(`DC Token 對應表第 ${i + 1} 行 Token 雜湊格式錯誤(64 個小寫十六進位)`);
    const key = computer.toUpperCase();
    if (seen.has(key)) throw new TokenFileError(`DC Token 對應表第 ${i + 1} 行 computer 重複`);
    if (byHash.has(hash)) throw new TokenFileError(`DC Token 對應表第 ${i + 1} 行 Token 與其他 DC 相同`);
    seen.add(key);
    byHash.set(hash, { computer, domain: domain.toLowerCase() });
  });
  if (!byHash.size) throw new TokenFileError('DC Token 對應表沒有任何 DC(先執行 deploy/host2-set-ad-secrets.sh 新增)');
  const hashes = [...byHash.keys()].map((h) => Buffer.from(h, 'hex'));
  return {
    size: byHash.size,
    computers: [...byHash.values()].map((d) => d.computer),
    lookup(token) {
      if (typeof token !== 'string' || !TOKEN.test(token)) return null;
      const h = createHash('sha256').update(token, 'utf8').digest();
      // 逐一以固定時間比對(DC 台數少);比對的是雜湊,不洩漏 Token 內容
      let hit: DcIdentity | null = null;
      for (const b of hashes) if (timingSafeEqual(b, h)) hit = byHash.get(b.toString('hex')) ?? null;
      return hit;
    },
  };
}
