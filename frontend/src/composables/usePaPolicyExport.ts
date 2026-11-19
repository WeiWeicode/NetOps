/**
 * 規則圖匯出給外部 AI(2026-11-19 需求方:「規則內容,不含姓名部門」)。前端產生,不經新 API。
 *
 * 只用畫面已取得的資料(GET /v1/pa-policies,需 netops.pa-policy.read;沒有這個權限就沒有規則資料可匯出)。
 * 內容:規則編號、名稱、zone、位址物件與展開網段、應用、服務、動作、命中數、排序檢查結果。
 * 刻意不含(會送到公司外的 AI):
 *   - IP 對照表的姓名 / 部門(規則資料本身就沒有;本檔也不接受 IP 對照結果)
 *   - 說明欄 description(可能寫人名)、使用者 / 群組名稱(AD 帳號,只給數量)、uuid、Tag、Log Forwarding 設定名稱
 *
 *   const ex = usePaPolicyExport(() => viz.shownRules, () => viz.shownDefaults, () => checks.items, () => ({ fetchedAt, unusedDays, scope }));
 *   ex.markdown() / ex.json() → 字串;ex.download('md' | 'json') → 下載檔案
 */
import type { CheckItem, DefaultRuleHits, ExpandedAddress, PolicyRule } from '@/api/paPolicy';
import { CHECK_LABELS, SEVERITY_LABELS } from './usePaPolicyCheck';

export interface ExportMeta {
  /** 規則快照時間 */
  fetchedAt?: string | null;
  /** 長期未命中門檻(天) */
  unusedDays?: number | null;
  /** 篩選 / 選取說明(例:「動作 allow;選取 trust → untrust」) */
  scope?: string | null;
}

export interface ExportAddress {
  name: string;
  kind: ExpandedAddress['kind'];
  values: string[];
  /** 有成員無法對應 IP(FQDN、動態群組等) */
  unresolved: boolean;
}
export interface ExportCheck {
  code: string;
  label: string;
  severity: string;
  message: string;
  related: number[];
  reasons?: string[];
}
export interface ExportRule {
  position: number;
  name: string;
  disabled: boolean;
  fromZones: string[];
  toZones: string[];
  sources: ExportAddress[];
  negateSource: boolean;
  destinations: ExportAddress[];
  negateDestination: boolean;
  /** 只給數量(名稱是 AD 帳號,不匯出);0 = any */
  sourceUserCount: number;
  applications: { name: string; values: string[] }[];
  services: { name: string; values: string[] }[];
  categories: string[];
  action: string;
  profileGroup: string | null;
  profileTypes: string[];
  logEnd: boolean;
  hitCount: number | null;
  lastHit: string | null;
  checks: ExportCheck[];
}
export interface PolicyExport {
  generatedAt: string;
  fetchedAt: string | null;
  unusedDays: number | null;
  scope: string | null;
  note: string;
  ruleCount: number;
  rules: ExportRule[];
  defaults: { name: string; hitCount: number | null; lastHit: string | null }[];
}

const NOTE =
  'PA-560 安全規則(由上往下比對,# 為 PA 規則編號);排序檢查為系統程式比對結果;不含 IP 對照姓名 / 部門、說明欄、使用者名稱與動態群組 Tag。規則與物件名稱照 PA 原名匯出。';
/** 動態位址群組的 Tag 運算式可能含人名 / 部門(User-ID 自動 Tag),不匯出 */
const maskValue = (v: string) => (v.startsWith('dynamic:') ? 'dynamic:(省略)' : v);
const isAny = (xs: string[]) => !xs.length || xs.includes('any');

export function buildExport(rules: PolicyRule[], defaults: DefaultRuleHits[], checks: CheckItem[], meta: ExportMeta = {}, now = new Date()): PolicyExport {
  const byPos = new Map<number, CheckItem[]>();
  for (const c of checks) byPos.set(c.position, [...(byPos.get(c.position) ?? []), c]);
  const addr = (xs: ExpandedAddress[]): ExportAddress[] => xs.map((x) => ({ name: x.name, kind: x.kind, values: [...new Set(x.values.map(maskValue))], unresolved: x.unresolved }));
  return {
    generatedAt: now.toISOString(),
    fetchedAt: meta.fetchedAt ?? null,
    unusedDays: meta.unusedDays ?? null,
    scope: meta.scope ?? null,
    note: NOTE,
    ruleCount: rules.length,
    rules: rules
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        position: r.position,
        name: r.name,
        disabled: r.disabled,
        fromZones: r.fromZones.length ? [...r.fromZones] : ['any'],
        toZones: r.toZones.length ? [...r.toZones] : ['any'],
        sources: addr(r.expanded.sources),
        negateSource: r.negateSource,
        destinations: addr(r.expanded.destinations),
        negateDestination: r.negateDestination,
        sourceUserCount: isAny(r.sourceUsers) ? 0 : r.sourceUsers.length,
        applications: r.expanded.applications.map((a) => ({ name: a.name, values: [...a.values] })),
        services: r.expanded.services.map((s) => ({ name: s.name, values: [...s.values] })),
        categories: [...r.categories],
        action: r.action,
        profileGroup: r.profileGroup,
        profileTypes: Object.keys(r.profiles).filter((k) => r.profiles[k]?.length),
        logEnd: r.logEnd,
        hitCount: r.hits?.hitCount ?? null,
        lastHit: r.hits?.lastHit ?? null,
        checks: (byPos.get(r.position) ?? []).map((c) => ({
          code: c.code,
          label: CHECK_LABELS[c.code] ?? c.code,
          severity: c.severity,
          message: c.message,
          related: c.related.map((x) => x.position),
          ...(c.reasons?.length ? { reasons: [...c.reasons] } : {}),
        })),
      })),
    defaults: defaults.map((d) => ({ name: d.name, hitCount: d.hitCount, lastHit: d.lastHit })),
  };
}

/** Markdown 表格儲存格:去掉換行、跳脫 | */
const cell = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[|`<>]/g, (c) => '\\' + c);
const addrText = (xs: ExportAddress[], negate: boolean) =>
  (xs.length
    ? xs
        .map((x) => {
          if (x.kind === 'any') return 'any';
          const vals = x.values.length && !(x.values.length === 1 && x.values[0] === x.name) ? ` [${x.values.join(', ')}]` : '';
          return `${x.name}${vals}${x.unresolved ? '(含無法對應 IP 的成員)' : ''}`;
        })
        .join('; ')
    : 'any') + (negate ? '(negate)' : '');
const listText = (xs: { name: string; values: string[] }[]) => (xs.length ? xs.map((x) => (x.values.length ? `${x.name} [${x.values.join(', ')}]` : x.name)).join('; ') : 'any');

export function toMarkdown(e: PolicyExport): string {
  const head = ['#', '名稱', '來源 zone', '目的 zone', '來源位址', '目的位址', '使用者', '應用', '服務', 'URL 類別', '動作', 'Profile', 'Log at Session End', '命中數', '最後命中', '停用'];
  const row = (xs: (string | number)[]) => `| ${xs.map((x) => cell(String(x))).join(' | ')} |`;
  const lines = [
    '# PA 安全規則匯出',
    '',
    `- 說明:${e.note}`,
    `- 規則快照時間:${e.fetchedAt ?? '不明'};匯出時間:${e.generatedAt}`,
    ...(e.unusedDays ? [`- 長期未命中門檻:${e.unusedDays} 天`] : []),
    ...(e.scope ? [`- 範圍:${cell(e.scope)}`] : []),
    `- 規則數:${e.ruleCount}`,
    '',
    '## 規則(依 PA 比對順序)',
    '',
    row(head),
    row(head.map(() => '---')),
    ...e.rules.map((r) =>
      row([
        r.position,
        r.name,
        r.fromZones.join(', '),
        r.toZones.join(', '),
        addrText(r.sources, r.negateSource),
        addrText(r.destinations, r.negateDestination),
        r.sourceUserCount ? `有使用者條件(${r.sourceUserCount} 個)` : 'any',
        listText(r.applications),
        listText(r.services),
        r.categories.length ? r.categories.join(', ') : 'any',
        r.action,
        r.profileGroup ?? (r.profileTypes.join(', ') || '無'),
        r.logEnd ? '是' : '否',
        r.hitCount ?? '不明',
        r.lastHit?.slice(0, 10) ?? '無',
        r.disabled ? '是' : '',
      ]),
    ),
  ];
  const checks = e.rules.flatMap((r) => r.checks.map((c) => ({ r, c })));
  lines.push('', '## 排序檢查結果(系統程式比對)', '');
  if (!checks.length) lines.push('(沒有檢查項目,或尚未取得檢查結果)');
  for (const { r, c } of checks)
    lines.push(
      `- [${SEVERITY_LABELS[c.severity as keyof typeof SEVERITY_LABELS] ?? c.severity}] ${c.label} #${r.position} ${cell(r.name)}:${cell(c.message)}` +
        `${c.related.length ? `(相關 #${c.related.join(', #')})` : ''}${c.reasons?.length ? `(原因:${cell(c.reasons.join('、'))})` : ''}`,
    );
  if (e.defaults.length) {
    lines.push('', '## 預設規則(只有命中數)', '');
    for (const d of e.defaults) lines.push(`- ${cell(d.name)}:命中 ${d.hitCount ?? '不明'} 次,最後 ${d.lastHit?.slice(0, 10) ?? '無'}`);
  }
  return `${lines.join('\n')}\n`;
}

export function toJson(e: PolicyExport): string {
  return `${JSON.stringify(e, null, 2)}\n`;
}

/** 檔名:pa-policy-<快照時間,台灣時間 yyyyMMdd-HHmm>.<ext> */
export function exportFileName(e: PolicyExport, ext: 'md' | 'json'): string {
  const d = new Date(Date.parse(e.fetchedAt ?? e.generatedAt) + 8 * 3600_000);
  const t = Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  return `pa-policy-${t}.${ext}`;
}

export function usePaPolicyExport(rules: () => PolicyRule[], defaults: () => DefaultRuleHits[], checks: () => CheckItem[] | null | undefined, meta: () => ExportMeta = () => ({})) {
  const build = () => buildExport(rules(), defaults(), checks() ?? [], meta());
  return {
    build,
    markdown: () => toMarkdown(build()),
    json: () => toJson(build()),
    /** 瀏覽器下載(沒有任何規則時不下載,回傳 false) */
    download(format: 'md' | 'json'): boolean {
      const e = build();
      if (!e.rules.length && !e.defaults.length) return false;
      const blob = new Blob([format === 'md' ? toMarkdown(e) : toJson(e)], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = exportFileName(e, format);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
      return true;
    },
  };
}
