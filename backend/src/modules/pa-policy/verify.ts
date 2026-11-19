/**
 * PA 安全規則 AI 判讀的回答驗證(2026-11-19 驗收 §3:AI 引用了程式檢查沒有的項目與規則編號)。純函式。
 *
 * 回答是串流,畫面已經看到,所以不剔除文字,改在回答結束後回傳「標註」清單,畫面在對應段落提醒:
 *   unknown   回答提到的 #編號 不在送出的資料內(資料沒有這條規則)
 *   mismatch  同一行只講一類檢查(例:Security Profile),但這條規則沒有出現在程式檢查的這一類項目
 *   user      稱規則「有使用者條件」,但資料沒有標這條規則有使用者條件
 * 「同一行講哪一類」用關鍵字判斷,是保守的提示,不是判決;一行講多類或對不到關鍵字時只做 unknown 檢查。
 */
import type { AiRef, CheckCode } from './check.js';

export interface AiFlag {
  kind: 'unknown' | 'mismatch' | 'user';
  position: number;
  /** mismatch:回答這一行講的檢查類別 */
  code?: CheckCode;
  /** 回答中的那一行(最多 200 字,畫面定位用) */
  line: string;
}

/** 一行中出現這些字 → 這一行在講這類檢查 */
const KEYWORDS: [RegExp, CheckCode][] = [
  [/衝突遮蔽|conflict/i, 'conflict'],
  [/(?<!衝突)遮蔽|shadow/i, 'shadowed'],
  [/過寬|broad/i, 'broad-early'],
  [/冗餘|可合併|redundant/i, 'redundant'],
  [/未命中|命中數\s*(?:為\s*)?0(?!\d)|unused/i, 'unused'],
  [/Security Profile|Profile Group|沒有.{0,4}Profile|缺.{0,4}Profile/i, 'no-profile'],
  [/Session End|no-log-end/i, 'no-log-end'],
  [/無法判定|無法精準|undeterminable/i, 'undeterminable'],
];
const USER_RE = /使用者條件|source.?user/i;
const NO_USER_RE = /沒有使用者條件|無使用者條件|不含使用者條件/;
const POS_RE = /#(\d{1,4})(?!\d)/g;
const MAX_FLAGS = 100;

export function verifyAnswer(answer: string, ref: AiRef): AiFlag[] {
  const sent = new Set(ref.positions);
  const users = new Set(ref.users);
  const out: AiFlag[] = [];
  const seen = new Set<string>();
  const add = (f: AiFlag) => {
    const k = `${f.kind}:${f.position}:${f.code ?? ''}`;
    if (seen.has(k) || out.length >= MAX_FLAGS) return;
    seen.add(k);
    out.push(f);
  };
  for (const raw of answer.split('\n')) {
    const line = raw.trim();
    const nums = [...line.matchAll(POS_RE)].map((m) => Number(m[1]));
    if (!nums.length) continue;
    const short = line.slice(0, 200);
    const codes = KEYWORDS.filter(([re]) => re.test(line)).map(([, c]) => c);
    const code = codes.length === 1 ? codes[0] : undefined;
    const userClaim = USER_RE.test(line) && !NO_USER_RE.test(line);
    for (const n of nums) {
      if (!sent.has(n)) {
        add({ kind: 'unknown', position: n, line: short });
        continue;
      }
      if (code && !(ref.codes[n] ?? []).includes(code)) add({ kind: 'mismatch', position: n, code, line: short });
      if (userClaim && !users.has(n)) add({ kind: 'user', position: n, line: short });
    }
  }
  return out;
}
