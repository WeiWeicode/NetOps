/**
 * 安全規則頁(PR-4)元件共用型別與顯示對照表。
 * 純顯示用途,不含 API 呼叫或商業邏輯。
 */
import type { CheckCode, CheckSeverity, ExpandedAddress, ObjectChange, RuleChange } from '@/api/paPolicy';
import type { usePaPolicy } from '@/composables/usePaPolicy';
import type { usePaPolicyCheck } from '@/composables/usePaPolicyCheck';
import type { usePaPolicyViz } from '@/composables/usePaPolicyViz';

export type PaPolicyStore = ReturnType<typeof usePaPolicy>;
export type PaPolicyCheckStore = ReturnType<typeof usePaPolicyCheck>;
export type PaPolicyVizStore = ReturnType<typeof usePaPolicyViz>;

export type PolicyTab = 'list' | 'versions' | 'checks' | 'viz';

export const ACTION_META: Record<string, { label: string; tone: string }> = {
  allow: { label: '允許 (allow)', tone: 'success' },
  deny: { label: '拒絕 (deny)', tone: 'danger' },
  drop: { label: '丟棄 (drop)', tone: 'danger' },
  'reset-client': { label: '重設用戶端 (reset-client)', tone: 'danger' },
  'reset-server': { label: '重設伺服器 (reset-server)', tone: 'danger' },
  'reset-both': { label: '雙向重設 (reset-both)', tone: 'danger' },
};

export function actionMeta(action: string): { label: string; tone: string } {
  return ACTION_META[action] ?? { label: action, tone: action === 'allow' ? 'success' : 'danger' };
}

export const RULE_TYPE_LABELS: Record<string, string> = {
  universal: '通用 (universal)',
  intrazone: '同區 (intrazone)',
  interzone: '跨區 (interzone)',
};

export const ADDRESS_KIND_LABELS: Record<ExpandedAddress['kind'], string> = {
  any: '不限',
  address: '位址物件',
  group: '位址群組',
  literal: '直接輸入',
  'dynamic-group': '動態群組',
  region: '地區',
  unknown: '未知物件',
};

export const COLLECTOR_STATE_META: Record<string, { label: string; tone: string }> = {
  ok: { label: '正常', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  rejected: { label: '管理平面 CPU 過高(略過)', tone: 'warning' },
  paused: { label: '已暫停', tone: 'neutral' },
};

export const SEVERITY_TONES: Record<CheckSeverity, string> = {
  high: 'danger',
  medium: 'warning',
  low: 'info',
  info: 'neutral',
};

export const CHECK_CODES_ORDER: CheckCode[] = [
  'conflict',
  'shadowed',
  'broad-early',
  'redundant',
  'unused',
  'disabled',
  'no-profile',
  'no-log-end',
  'undeterminable',
];

export const RULE_CHANGE_META: Record<RuleChange['kind'], { label: string; tone: string }> = {
  added: { label: '新增', tone: 'success' },
  removed: { label: '刪除', tone: 'danger' },
  moved: { label: '移動位置', tone: 'info' },
  changed: { label: '修改', tone: 'warning' },
};

export const OBJECT_KIND_LABELS: Record<ObjectChange['kind'], string> = {
  addresses: '位址物件 (Address)',
  addressGroups: '位址群組 (Address Group)',
  services: '服務物件 (Service)',
  serviceGroups: '服務群組 (Service Group)',
  applicationGroups: '應用群組 (Application Group)',
  tags: '標籤 (Tag)',
};

export const escHtml = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
