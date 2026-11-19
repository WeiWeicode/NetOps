/**
 * PA 安全規則 AI 判讀的回答驗證(2026-11-19 驗收 §3:AI 引用了程式檢查沒有的項目與規則編號)。純函式。
 *
 * 回答是串流,畫面已經看到,所以不剔除文字,改在回答結束後回傳「標註」清單,畫面在對應段落提醒:
 *   unknown   回答提到的 #編號 不在送出的資料內(資料沒有這條規則)
 *   mismatch  同一行只講一類檢查(例:Security Profile),但這條規則沒有出現在程式檢查的這一類項目
 *   user      稱規則「有使用者條件」,但資料沒有標這條規則有使用者條件
 *
 * 是保守的提示,不是判決:
 *   - 歸類只看「同一行」的關鍵字;關鍵字只在章節標題、條列行沒有時不判歸類;一行講多類時也不判
 *   - 「把 #X 移到 #Y 之前」這類句子只檢查第一個編號(後面的是參照對象)
 *   - 使用者條件以子句(逗號、分號、句號切開)判斷,否定說法(沒有 / 未設定 / 不限 / any)不算
 */
import type { AiRef, CheckCode } from './check.js';

export interface AiFlag {
  kind: 'unknown' | 'mismatch' | 'user';
  position: number;
  /** mismatch:回答這一行講的檢查類別 */
  code?: CheckCode;
  /** 回答中的那一行(最多 200 字,畫面定位用;畫面須以純文字顯示) */
  line: string;
}

/** 一行中出現這些字 → 這一行在講這類檢查 */
const KEYWORDS: [RegExp, CheckCode][] = [
  [/衝突遮蔽|conflict/i, 'conflict'],
  [/(?<!衝突)遮蔽|shadow/i, 'shadowed'],
  [/過寬|broad/i, 'broad-early'],
  [/冗餘|可合併|redundant/i, 'redundant'],
  [/未命中|命中數\s*(?:為\s*)?0(?!\d)|unused/i, 'unused'],
  [/(?:沒有|缺少?|未設定?|無)\s*(?:Security\s*)?Profile|no-profile/i, 'no-profile'],
  [/Session End|no-log-end/i, 'no-log-end'],
  [/無法判定|無法精準|undeterminable/i, 'undeterminable'],
];
/** 句中有這些字:第一個編號是主體,其他是參照 */
const REFER_RE = /移到|移至|之前|之後|前面|後面|被\s*#|合併|擋住|涵蓋/;
const USER_RE = /使用者條件|source.?user/i;
const NO_USER_RE = /(?:沒有|無|未|不|非)[^#]{0,4}使用者條件|使用者(?:條件)?\s*(?:為|是|=)\s*any/i;
const POS_RE = /#(\d{1,4})(?!\d)/g;
const MAX_FLAGS = 100;

const numsIn = (s: string) => [...s.matchAll(POS_RE)].map((m) => Number(m[1]));

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
    const nums = numsIn(line);
    if (!nums.length) continue;
    const short = line.slice(0, 200);
    for (const n of nums) if (!sent.has(n)) add({ kind: 'unknown', position: n, line: short });

    const codes = KEYWORDS.filter(([re]) => re.test(line)).map(([, c]) => c);
    if (codes.length === 1) {
      const code = codes[0]!;
      const subjects = REFER_RE.test(line) ? nums.slice(0, 1) : nums;
      for (const n of subjects) if (sent.has(n) && !(ref.codes[n] ?? []).includes(code)) add({ kind: 'mismatch', position: n, code, line: short });
    }

    for (const clause of line.split(/[,，;；。]/)) {
      if (!USER_RE.test(clause) || NO_USER_RE.test(clause)) continue;
      for (const n of numsIn(clause)) if (sent.has(n) && !users.has(n)) add({ kind: 'user', position: n, line: short });
    }
  }
  return out;
}
