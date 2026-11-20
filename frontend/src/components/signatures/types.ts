/**
 * 防火牆 › 威脅特徵碼頁(TS-4)元件共用型別與顯示對照表。
 * 純顯示用途,不含 API 呼叫或商業邏輯。
 */
import type { RouteLocationRaw } from 'vue-router';
import { PA_SEARCH_MAX_DAYS } from '@/api/pa';
import type { SignatureDays, SignatureKind } from '@/api/paSignature';
import type { usePaSignature } from '@/composables/usePaSignature';
import type { usePaSignatureDrawer } from '@/composables/usePaSignatureDrawer';

export type PaSignatureStore = ReturnType<typeof usePaSignature>;
export type PaSignatureDrawerStore = ReturnType<typeof usePaSignatureDrawer>;

export type SignatureTab = 'list' | 'versions' | 'hits' | 'coverage' | 'ai';

export const SIG_DAYS_OPTIONS: { label: string; value: string }[] = [
  { label: '7 天', value: '7' },
  { label: '30 天', value: '30' },
  { label: '90 天', value: '90' },
];

export const SIG_KIND_META: Record<SignatureKind, { label: string; tone: string }> = {
  vulnerability: { label: '弱點', tone: 'danger' },
  spyware: { label: '間諜軟體', tone: 'warning' },
};

export const SIG_SEVERITY_META: Record<string, { label: string; tone: string }> = {
  critical: { label: '嚴重', tone: 'danger' },
  high: { label: '高', tone: 'warning' },
  medium: { label: '中', tone: 'info' },
  low: { label: '低', tone: 'neutral' },
  informational: { label: '資訊', tone: 'neutral' },
};

export function severityMeta(sev: string | null | undefined): { label: string; tone: string } {
  const k = (sev ?? '').trim().toLowerCase();
  return SIG_SEVERITY_META[k] ?? { label: sev || '未知', tone: 'neutral' };
}

export const DIFF_KIND_META: Record<'added' | 'changed' | 'removed' | 'rebuilt', { label: string; tone: string }> = {
  added: { label: '新增', tone: 'success' },
  changed: { label: '變更', tone: 'warning' },
  removed: { label: '停用 / 移除', tone: 'danger' },
  rebuilt: { label: '差異無法計算', tone: 'warning' },
};

export const COLLECTOR_STATE_META: Record<string, { label: string; tone: string }> = {
  ok: { label: '正常', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  rejected: { label: '管理平面 CPU 過高(略過)', tone: 'warning' },
  paused: { label: '已暫停', tone: 'neutral' },
};

export const DIFF_FIELD_LABELS: Record<string, string> = {
  name: '名稱',
  severity: '嚴重度',
  category: '類別',
  defaultAction: '預設動作',
  disabled: '預設停用',
  cves: 'CVE',
};

/** TS-2 審查結論:firstVersion 為 null 時顯示「未知」,不顯示空白 */
export function formatFirstVersion(v: string | null | undefined): string {
  return v && v.trim() ? v : '未知';
}

export function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '無';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(', ') : '無';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const pad = (n: number) => String(n).padStart(2, '0');
function toLocalMinute(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 產生前往 Log 明細查詢(/firewall/search,type=THREAT)的連結;期間上限依 PA_SEARCH_MAX_DAYS(30 天)截齊 */
export function searchLinkForSignature(opts: {
  id: string;
  name?: string;
  ip?: string;
  fromIso?: string;
  toIso?: string;
  days?: SignatureDays;
}): RouteLocationRaw {
  const nowMs = Date.now();
  const parsedTo = opts.toIso ? Date.parse(opts.toIso) : Number.NaN;
  const toMs = Number.isNaN(parsedTo) ? nowMs : parsedTo;
  const maxSpanMs = (PA_SEARCH_MAX_DAYS - 1) * 86_400_000;
  const parsedFrom = opts.fromIso ? Date.parse(opts.fromIso) : Number.NaN;
  const rawFromMs = Number.isNaN(parsedFrom) ? toMs - Math.min(opts.days ?? 30, PA_SEARCH_MAX_DAYS - 1) * 86_400_000 : parsedFrom;
  const fromMs = Math.max(rawFromMs, toMs - maxSpanMs);

  const query: Record<string, string> = {
    type: 'THREAT',
    threat: opts.name?.trim() ? opts.name.trim() : opts.id,
    from: toLocalMinute(fromMs),
    to: toLocalMinute(toMs),
  };
  if (opts.ip?.trim()) query.ip = opts.ip.trim();
  return { path: '/firewall/search', query };
}
