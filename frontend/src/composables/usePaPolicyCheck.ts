/**
 * 安全規則「排序檢查」分頁的狀態與邏輯(PR-5;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3 PR-5)。
 *
 *   const c = usePaPolicyCheck();             // reactive 物件(不要解構)
 *   c.unusedDays(預設 90)→ c.load()          // 程式檢查(確定性)
 *   c.items / c.summary / c.imprecise / c.info(fetchedAt、stale、available、message)
 *   c.byCode(code) / c.bySeverity(sev)        // 分組顯示
 *   c.marks                                     // Map<規則編號, 檢查標記>:傳給 usePaPolicyViz 的第三個參數(順序條的檢查標記)
 *                                               //   還沒 load 時為 null(順序條不顯示「無問題」,§3.5)
 *   c.canAi / c.ai(useAiExplain)/ c.runAi()   // AI 判讀(netops.pa-policy-page.ai);結果標「AI 建議,需網通確認」,不自動改 PA
 *     c.ai.phase / text / error / meta / notices / statusText / stop()  同其他頁的 AI 解讀
 */
import { computed, reactive, ref, shallowRef } from 'vue';
import { can } from '@/api/gateway';
import { UI } from '@/api/perms';
import { paPolicyApi, type CheckCode, type CheckItem, type CheckSeverity, type PolicyChecks } from '@/api/paPolicy';
import { useAiExplain } from './useAiExplain';
import type { OrderCheckMark } from './usePaPolicyViz';

export const CHECK_LABELS: Record<CheckCode, string> = {
  conflict: '衝突遮蔽',
  shadowed: '遮蔽(永遠不會命中)',
  redundant: '冗餘 / 可合併',
  'broad-early': '過寬規則位置過前',
  unused: '長期未命中',
  disabled: '停用',
  'no-profile': '沒有 Security Profile',
  'no-log-end': '沒有 Log at Session End',
  undeterminable: '無法判定(需人工確認)',
};
export const SEVERITY_LABELS: Record<CheckSeverity, string> = { high: '高', medium: '中', low: '低', info: '提示' };
export const AI_DISCLAIMER = 'AI 建議,需網通確認;系統不會自動修改 PA 規則或順序';

/** 檢查項目 → 順序條標記(每條規則可有多個) */
export function marksOf(items: CheckItem[]): Map<number, OrderCheckMark[]> {
  const m = new Map<number, OrderCheckMark[]>();
  for (const i of items) {
    const list = m.get(i.position) ?? [];
    list.push({ code: i.code, severity: i.severity, related: i.related.map((r) => r.position) });
    m.set(i.position, list);
  }
  return m;
}

export interface UsePaPolicyCheckOptions {
  backend?: Pick<typeof paPolicyApi, 'checks'>;
  can?: (code: string) => boolean;
}

export function usePaPolicyCheck(options: UsePaPolicyCheckOptions = {}) {
  const backend = options.backend ?? paPolicyApi;
  const allowed = options.can ?? can;
  const unusedDays = ref(90);
  const result = shallowRef<PolicyChecks | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  let seq = 0;

  async function load(): Promise<boolean> {
    const my = ++seq;
    loading.value = true;
    error.value = null;
    try {
      const r = await backend.checks(unusedDays.value);
      if (my === seq) result.value = r;
      return true;
    } catch (e) {
      if (my === seq) error.value = e as Error;
      return false;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  const items = computed(() => result.value?.items ?? []);
  const marks = computed(() => (result.value?.available ? marksOf(items.value) : null));
  const ai = useAiExplain();
  const canAi = computed(() => allowed(UI.paPolicyAi));
  const runAi = () => ai.start({ kind: 'pa-policy', params: { unusedDays: unusedDays.value } });

  return reactive({
    unusedDays,
    load,
    loading,
    error,
    info: computed(() => {
      const r = result.value;
      if (!r) return null;
      const { items: _i, summary: _s, imprecise: _m, ...rest } = r;
      return rest;
    }),
    items,
    summary: computed(() => result.value?.summary ?? null),
    imprecise: computed(() => result.value?.imprecise ?? 0),
    byCode: (code: CheckCode) => items.value.filter((i) => i.code === code),
    bySeverity: (sev: CheckSeverity) => items.value.filter((i) => i.severity === sev),
    marks,
    canAi,
    ai,
    runAi,
  });
}
