/**
 * PA 安全規則排序檢查(PR-5;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3 PR-5 第 1 層):先用程式確定性地算,AI 只解釋結果。純函式。
 *
 * 項目(每項都標出相關規則編號):
 *   conflict      衝突遮蔽:被前面某條完全涵蓋且動作不同(最需要處理)                          high
 *   shadowed      遮蔽:被前面某條完全涵蓋、動作相同,永遠不會命中                              medium
 *   redundant     冗餘:相鄰(只看啟用的)兩條動作相同、只差來源或只差目的,可合併;或條件完全相同  low
 *   broad-early   過寬規則位置過前:來源或目的 any 且應用或服務 any 的 allow,排在和它重疊的較具體規則之前 medium
 *   unused        長期未命中:命中數 0 或最後命中超過 N 天(預設 90)                            low
 *   disabled      停用規則                                                                        info
 *   no-profile    沒有 Security Profile 的 allow                                                  medium
 *   no-log-end    沒有 Log at Session End                                                         low
 *   undeterminable 無法判定:可能被前面的規則涵蓋,但涉及應用群組 / 動態位址群組 / FQDN / 使用者 / negate 等無法精準比對的條件
 *                  (不當成沒問題,也不當成遮蔽)                                                 info
 * 「涵蓋」= zone、展開後的位址(IPv4 範圍)、使用者、應用、服務、URL 類別都是子集;停用規則不參與遮蔽比對。
 */
import { coveredBy, isUnused, overlaps, type RuleView } from './core.js';

export type CheckCode = 'conflict' | 'shadowed' | 'redundant' | 'broad-early' | 'unused' | 'disabled' | 'no-profile' | 'no-log-end' | 'undeterminable';
export type Severity = 'high' | 'medium' | 'low' | 'info';

export const CHECK_SEVERITY: Record<CheckCode, Severity> = {
  conflict: 'high',
  shadowed: 'medium',
  'broad-early': 'medium',
  'no-profile': 'medium',
  redundant: 'low',
  unused: 'low',
  'no-log-end': 'low',
  disabled: 'info',
  undeterminable: 'info',
};
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export interface CheckItem {
  code: CheckCode;
  severity: Severity;
  position: number;
  name: string;
  /** 相關規則(遮蔽它的、被它擋住的、可合併的另一條);最多 MAX_RELATED */
  related: { position: number; name: string }[];
  /** 中文說明(畫面直接顯示) */
  message: string;
  /** undeterminable:無法精準比對的原因 */
  reasons?: string[];
}

export const DEFAULT_UNUSED_DAYS = 90;
const MAX_RELATED = 10;

/** 規則的 any 判斷 */
const isAny = (xs: string[]) => !xs.length || xs.includes('any');
const subset = (inner: string[], outer: string[]) => isAny(outer) || (!isAny(inner) && inner.every((x) => outer.includes(x)));
const sameSet = (a: string[], b: string[]) => (isAny(a) && isAny(b)) || (!isAny(a) && !isAny(b) && a.length === b.length && a.every((x) => b.includes(x)));

/** 無法精準比對的條件(這條規則參與遮蔽判斷時結果只能是「可能」) */
export function imprecision(v: RuleView): string[] {
  const r = v.rule;
  const out: string[] = [];
  if (r.negateSource || r.negateDestination) out.push('negate');
  if (v.src.unresolved || v.dst.unresolved) out.push('位址含 FQDN / 動態群組 / 地區等無法展開的物件');
  if (!isAny(r.sourceUsers)) out.push('使用者 / 使用者群組');
  if (r.expanded.applications.some((a) => a.kind === 'group')) out.push('應用群組');
  if (r.expanded.services.some((s) => s.kind === 'unknown')) out.push('找不到定義的服務');
  if (!isAny(r.sourceDevices) || !isAny(r.destinationDevices)) out.push('裝置條件');
  if (r.schedule) out.push('排程');
  if (r.type !== 'universal') out.push(`規則類型 ${r.type}(intrazone / interzone 的比對範圍和 zone 欄位不同)`);
  return out;
}

/** 服務的比對值:any、application-default 或展開後的 protocol/port */
function serviceSet(v: RuleView): { any: boolean; appDefault: boolean; ports: string[] } {
  const s = v.rule.expanded.services;
  if (s.some((x) => x.kind === 'any')) return { any: true, appDefault: false, ports: [] };
  return { any: false, appDefault: s.some((x) => x.kind === 'application-default'), ports: s.flatMap((x) => x.values) };
}
function servicesCovered(inner: RuleView, outer: RuleView): boolean {
  const o = serviceSet(outer);
  if (o.any) return true;
  const i = serviceSet(inner);
  if (i.any) return false;
  if (i.appDefault !== o.appDefault && i.appDefault) return false;
  return i.ports.every((p) => o.ports.includes(p));
}

function addressCovered(inner: RuleView['src'], outer: RuleView['src']): boolean {
  if (outer.any) return true;
  if (inner.any) return false;
  return coveredBy(inner.ranges, outer.ranges);
}

/** outer(前)是否涵蓋 inner(後)。不看無法精準比對的部分(由呼叫端另外標 undeterminable) */
export function covers(outer: RuleView, inner: RuleView): boolean {
  const a = outer.rule;
  const b = inner.rule;
  return (
    subset(b.fromZones, a.fromZones) &&
    subset(b.toZones, a.toZones) &&
    addressCovered(inner.src, outer.src) &&
    addressCovered(inner.dst, outer.dst) &&
    subset(b.sourceUsers, a.sourceUsers) &&
    subset(b.applications, a.applications) &&
    subset(b.categories, a.categories) &&
    servicesCovered(inner, outer)
  );
}

/** 兩條規則的條件可能有交集(過寬檢查用;zone 與位址) */
function mayOverlap(a: RuleView, b: RuleView): boolean {
  const z = (x: string[], y: string[]) => isAny(x) || isAny(y) || x.some((v) => y.includes(v));
  const addr = (x: RuleView['src'], y: RuleView['src']) => x.any || y.any || x.unresolved || y.unresolved || x.ranges.some((r) => y.ranges.some((s) => overlaps(r, s)));
  return z(a.rule.fromZones, b.rule.fromZones) && z(a.rule.toZones, b.rule.toZones) && addr(a.src, b.src) && addr(a.dst, b.dst);
}

const isBroadAllow = (v: RuleView) => {
  const r = v.rule;
  const svc = serviceSet(v);
  return r.action === 'allow' && (v.src.any || v.dst.any) && (isAny(r.applications) || svc.any);
};

/** 動作分類:allow 以外(deny、drop、reset-*)都是擋;衝突只看分類不同 */
const verdict = (a: string) => (a === 'allow' ? 'allow' : 'block');

const ref = (v: RuleView) => ({ position: v.rule.position, name: v.rule.name });

export interface CheckResult {
  items: CheckItem[];
  /** 各項目數量 */
  summary: Record<CheckCode, number>;
  /** 有無法精準比對條件的規則數(這些規則的遮蔽判斷可能不完整) */
  imprecise: number;
}

export function checkRules(views: RuleView[], opts: { unusedDays?: number; now?: number } = {}): CheckResult {
  const days = opts.unusedDays ?? DEFAULT_UNUSED_DAYS;
  const now = opts.now ?? Date.now();
  const items: CheckItem[] = [];
  const push = (code: CheckCode, v: RuleView, related: RuleView[], message: string, reasons?: string[]) =>
    items.push({ code, severity: CHECK_SEVERITY[code], position: v.rule.position, name: v.rule.name, related: related.slice(0, MAX_RELATED).map(ref), message, ...(reasons ? { reasons } : {}) });

  const ordered = views.slice().sort((a, b) => a.rule.position - b.rule.position);
  const enabled = ordered.filter((v) => !v.rule.disabled);
  const imp = new Map(enabled.map((v) => [v.rule.position, imprecision(v)]));

  // 遮蔽 / 衝突 / 無法判定 / 完全相同的冗餘
  for (let j = 0; j < enabled.length; j++) {
    const b = enabled[j]!;
    const sure: RuleView[] = [];
    const maybe: RuleView[] = [];
    for (let i = 0; i < j; i++) {
      const a = enabled[i]!;
      if (!covers(a, b)) continue;
      if (imp.get(a.rule.position)!.length || imp.get(b.rule.position)!.length) maybe.push(a);
      else sure.push(a);
    }
    if (sure.length) {
      const first = sure[0]!;
      const identical = covers(b, first) && first.rule.action === b.rule.action;
      const sameClassOtherAction = first.rule.action !== b.rule.action;
      if (verdict(first.rule.action) !== verdict(b.rule.action))
        push('conflict', b, sure, `被第 ${first.rule.position} 條「${first.rule.name}」完全涵蓋且動作不同(${first.rule.action} → 本條 ${b.rule.action} 永遠不會生效)`);
      else if (identical) push('redundant', b, [first], `和第 ${first.rule.position} 條「${first.rule.name}」條件與動作完全相同,永遠不會命中,可刪除`);
      else
        push('shadowed', b, sure, `被第 ${first.rule.position} 條「${first.rule.name}」完全涵蓋${sameClassOtherAction ? `(同樣是擋,但擋法不同:${first.rule.action} / 本條 ${b.rule.action})` : '(動作相同)'},永遠不會命中`);
    } else if (maybe.length) {
      const reasons = [...new Set([b, ...maybe].flatMap((v) => imp.get(v.rule.position)!))];
      push('undeterminable', b, maybe, `可能被第 ${maybe.map((v) => v.rule.position).slice(0, 5).join('、')} 條涵蓋,但含無法精準比對的條件,需人工確認`, reasons);
    }
  }

  // 相鄰可合併(啟用的相鄰兩條;只差來源或只差目的)
  for (let j = 1; j < enabled.length; j++) {
    const a = enabled[j - 1]!.rule;
    const b = enabled[j]!.rule;
    if (a.action !== b.action) continue;
    if (items.some((x) => x.position === b.position && (x.code === 'redundant' || x.code === 'shadowed' || x.code === 'conflict'))) continue;
    const same = (k: 'fromZones' | 'toZones' | 'applications' | 'services' | 'sourceUsers' | 'categories') => sameSet(a[k], b[k]);
    if (!(same('fromZones') && same('toZones') && same('applications') && same('services') && same('sourceUsers') && same('categories'))) continue;
    // 其他會改變行為的欄位都要相同才建議合併(排程、裝置、個別 Profile、Log 設定、規則類型)
    const opt = (r: typeof a) => JSON.stringify([r.type, r.profileGroup, r.profiles, r.logStart, r.logEnd, r.logSetting, r.schedule, r.negateSource, r.negateDestination, r.sourceDevices, r.destinationDevices]);
    if (opt(a) !== opt(b)) continue;
    const srcSame = sameSet(a.sources, b.sources);
    const dstSame = sameSet(a.destinations, b.destinations);
    if (srcSame !== dstSame) push('redundant', enabled[j]!, [enabled[j - 1]!], `和第 ${a.position} 條「${a.name}」只差${srcSame ? '目的' : '來源'}位址、動作相同,可考慮合併`);
  }

  // 過寬規則位置過前
  for (let i = 0; i < enabled.length; i++) {
    const a = enabled[i]!;
    if (!isBroadAllow(a)) continue;
    // 只看順序會影響結果的:後面較具體、和它重疊,而且動作不同(會被它先放行)或 Security Profile 不同
    const later = enabled.slice(i + 1).filter((b) => !isBroadAllow(b) && mayOverlap(a, b) && (verdict(b.rule.action) !== 'allow' || b.rule.profileGroup !== a.rule.profileGroup || JSON.stringify(b.rule.profiles) !== JSON.stringify(a.rule.profiles)));
    if (later.length)
      push('broad-early', a, later, `來源或目的為 any 且應用或服務為 any 的 allow,排在 ${later.length} 條和它重疊、動作或 Profile 不同的較具體規則之前(第 ${later.slice(0, 5).map((v) => v.rule.position).join('、')} 條…),那些流量會先被這條放行`);
  }

  for (const v of ordered) {
    const r = v.rule;
    if (r.disabled) {
      push('disabled', v, [], '停用中的規則');
      continue;
    }
    if (isUnused(r.hits, days, now) === true)
      push('unused', v, [], r.hits?.hitCount === 0 ? '命中數為 0(從上次重設命中數以來)' : `最後命中超過 ${days} 天(${r.hits?.lastHit?.slice(0, 10)})`);
    if (r.action === 'allow' && !r.profileGroup && !Object.values(r.profiles).some((x) => x.length)) push('no-profile', v, [], 'allow 規則沒有設定 Security Profile(防毒、弱點、間諜軟體等不會檢查)');
    if (!r.logEnd) push('no-log-end', v, [], '沒有勾選 Log at Session End,這條規則的流量不會留下 TRAFFIC log');
  }

  items.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || x.position - y.position);
  const summary = Object.fromEntries(Object.keys(CHECK_SEVERITY).map((c) => [c, 0])) as Record<CheckCode, number>;
  for (const it of items) summary[it.code]++;
  return { items, summary, imprecise: [...imp.values()].filter((x) => x.length).length };
}

/** AI 判讀送出的項目(依嚴重度;info 只送「無法判定」(「需要人工確認」章節的依據),停用不送;太多時只送前面的) */
export const AI_MAX_ITEMS = 40;
export const AI_MAX_CHARS = 30_000;

/**
 * AI 判讀的資料(§3.3 PR-5 第 2 層):只有檢查項目 + 相關規則的正規化內容(名稱、zone、物件名稱與展開後網段、應用、服務、動作、命中數)。
 * 不送整份規則、不送 IP 對照表的姓名 / 部門(§3.6),也不送說明欄(description 可能有人名)與使用者 / 群組名稱(AD 帳號,只送數量)。
 */
export function checkContext(views: RuleView[], result: CheckResult, meta: { fetchedAt: string; unusedDays: number }): { text: string; clipped: boolean; sent: number; ref: AiRef } {
  const forAi = result.items.filter(sentToAi);
  const picked = forAi.slice(0, AI_MAX_ITEMS);
  const byPos = new Map(views.map((v) => [v.rule.position, v]));
  const positions = [...new Set(picked.flatMap((i) => [i.position, ...i.related.map((r) => r.position)]))].sort((a, b) => a - b);
  const addr = (xs: RuleView['rule']['expanded']['sources']) =>
    xs.map((x) => (x.kind === 'any' ? 'any' : `${x.name}${x.values.length ? `[${x.values.slice(0, 8).join(', ')}${x.values.length > 8 ? ` …共 ${x.values.length}` : ''}]` : ''}${x.unresolved ? '(含無法對應 IP)' : ''}`)).join('; ');
  const ruleLine = (p: number) => {
    const v = byPos.get(p);
    if (!v) return '';
    const r = v.rule;
    const svc = r.expanded.services.map((s) => (s.values.length ? `${s.name}[${s.values.join(', ')}]` : s.name)).join('; ');
    const app = r.expanded.applications.map((a) => (a.values.length ? `${a.name}[${a.values.join(', ')}]` : a.name)).join('; ');
    const hits = r.hits ? `命中 ${r.hits.hitCount ?? '?'} 次,最後 ${r.hits.lastHit?.slice(0, 10) ?? '無'}` : '命中數不明';
    return `#${r.position} ${r.name}${r.disabled ? '(停用)' : ''}|${r.fromZones.join(',') || 'any'} → ${r.toZones.join(',') || 'any'}|來源 ${addr(r.expanded.sources)}${r.negateSource ? '(negate)' : ''}|目的 ${addr(r.expanded.destinations)}${r.negateDestination ? '(negate)' : ''}|使用者 ${isAny(r.sourceUsers) ? 'any' : `有使用者條件(${r.sourceUsers.length} 個,名稱不送)`}|應用 ${app}|服務 ${svc}|動作 ${r.action}|Profile ${r.profileGroup ?? (Object.keys(r.profiles).join(',') || '無')}|${hits}`;
  };
  const findings = picked.map((i) => `- [${i.severity}] ${i.code} #${i.position} ${i.name}:${i.message}${i.reasons ? `(原因:${i.reasons.join('、')})` : ''}`);
  const sum = Object.entries(result.summary).filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join('、');
  let text =
    `規則快照時間:${meta.fetchedAt};長期未命中門檻 ${meta.unusedDays} 天;規則總數 ${views.length} 條。\n` +
    `程式檢查統計:${sum || '無'}(info 類不列;含無法精準比對條件的規則 ${result.imprecise} 條)。\n\n` +
    `## 檢查項目(依嚴重度,最多 ${AI_MAX_ITEMS} 項)\n${findings.join('\n') || '(沒有需要處理的項目)'}\n\n` +
    `## 相關規則(依 PA 比對順序;# 為 PA 規則編號)\n${positions.map(ruleLine).filter(Boolean).join('\n')}`;
  let clipped = forAi.length > picked.length;
  if (text.length > AI_MAX_CHARS) {
    text = `${text.slice(0, AI_MAX_CHARS)}\n…(資料太長,後面省略)`;
    clipped = true;
  }
  // 驗證 AI 回答用:只算真的留在 text 裡的(截斷後被切掉的規則不算送出)
  const sentLines = new Set((text.split('## 相關規則')[1] ?? '').split('\n').map((l) => /^#(\d+) /.exec(l)?.[1]).filter(Boolean).map(Number));
  const inText = (p: number) => sentLines.has(p);
  const codes: Record<number, CheckCode[]> = {};
  for (const i of picked) {
    if (!inText(i.position)) continue;
    for (const p of [i.position, ...i.related.map((r) => r.position)]) {
      const list = (codes[p] ??= []);
      if (!list.includes(i.code)) list.push(i.code);
    }
  }
  const ref: AiRef = {
    positions: positions.filter(inText),
    codes,
    users: positions.filter((p) => inText(p) && !isAny(byPos.get(p)?.rule.sourceUsers ?? [])),
  };
  return { text, clipped, sent: picked.length, ref };
}

/** 送給 AI 的檢查項目:非 info,加上「無法判定」 */
const sentToAi = (i: CheckItem) => i.severity !== 'info' || i.code === 'undeterminable';

/** 送給 AI 的內容索引(回答驗證用,不送 AI) */
export interface AiRef {
  /** 資料內出現的規則編號 */
  positions: number[];
  /** 規則編號 → 它出現在哪些檢查項目(當主規則或相關規則) */
  codes: Record<number, CheckCode[]>;
  /** 資料標「有使用者條件」的規則編號 */
  users: number[];
}
