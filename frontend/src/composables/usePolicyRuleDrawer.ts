/**
 * 跨頁「點規則名稱開規則內容」(Log 明細查詢、戰情室抽屜等;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3)。
 * 只做邏輯:以規則名稱取單條(GET /api/netops/pa-policies/:name),畫面沿用 components/policies/PolicyRuleDrawer.vue。
 *
 *   const d = usePolicyRuleDrawer();            // reactive 物件(不要解構)
 *   d.linkable(name)   規則名稱要不要顯示成可點(沒有 netops.pa-policy.read、空值、預設規則 intrazone/interzone-default 為 false)
 *   d.show(name)       取得規則後才開抽屜(d.open = true);找不到 / 無權限 / 快照不可用時不開,原因放在 d.notice
 *                      回傳 'ok' | 'forbidden' | 'invalid' | 'not-found' | 'unavailable' | 'error' | 'stale'(被較新的 show / close 取代)
 *   d.open / d.close() 抽屜開關(v-model:open 關閉時呼叫 d.close())
 *   d.policy           傳給 <PolicyRuleDrawer :policy="d.policy" />(detail、IP 對照 nameOf 等都在裡面)
 *   d.loading / d.notice
 */
import { computed, reactive, ref } from 'vue';
import { can, type ApiError } from '@/api/gateway';
import { API } from '@/api/perms';
import { PA_POLICY_ERRORS } from '@/api/paPolicy';
import { usePaPolicy, type UsePaPolicyOptions } from './usePaPolicy';

/** PA 內建預設規則:只有命中數、沒有規則內容(單條 API 查不到) */
export const DEFAULT_RULE_NAMES: ReadonlySet<string> = new Set(['intrazone-default', 'interzone-default']);

export type ShowResult = 'ok' | 'forbidden' | 'invalid' | 'not-found' | 'unavailable' | 'error' | 'stale';

export function usePolicyRuleDrawer(options: UsePaPolicyOptions = {}) {
  const allowed = options.can ?? can;
  const policy = usePaPolicy(options);
  const canOpen = computed(() => allowed(API.paPolicyRead));
  const open = ref(false);
  const loading = ref(false);
  const notice = ref<string | null>(null);
  let seq = 0;

  const linkable = (name: string | null | undefined): boolean => {
    const n = (name ?? '').trim();
    return canOpen.value && !!n && !DEFAULT_RULE_NAMES.has(n);
  };

  async function show(name: string | null | undefined): Promise<ShowResult> {
    if (!canOpen.value) return 'forbidden';
    const n = (name ?? '').trim();
    if (!linkable(n)) return 'invalid';
    const my = ++seq;
    loading.value = true;
    notice.value = null;
    try {
      await policy.openRule(n);
      if (my !== seq) return 'stale';
      if (policy.detail) {
        open.value = true;
        return 'ok';
      }
      const err = policy.detailError as (ApiError & { code?: string; status?: number }) | null;
      policy.closeRule();
      open.value = false;
      if (err?.code === PA_POLICY_ERRORS.notFound) {
        notice.value = `找不到規則「${n}」:可能已刪除或改名(規則快照定期更新,與 Log 當時的規則可能不同)`;
        return 'not-found';
      }
      if (err?.code === PA_POLICY_ERRORS.unavailable) {
        notice.value = err.message || '目前沒有規則快照';
        return 'unavailable';
      }
      if (err?.status === 403) {
        notice.value = '沒有檢視安全規則的權限';
        return 'forbidden';
      }
      notice.value = err?.message || '讀取規則失敗';
      return 'error';
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  function close(): void {
    seq++;
    open.value = false;
    loading.value = false;
    notice.value = null;
    policy.closeRule();
  }

  return reactive({ policy, canOpen, linkable, show, open, close, loading, notice });
}
