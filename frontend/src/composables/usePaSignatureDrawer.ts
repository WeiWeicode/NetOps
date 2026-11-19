/**
 * 跨頁「點威脅名稱開特徵碼說明抽屜」(安全事件、Log 明細、戰情室抽屜、威脅特徵碼頁;docs/THREAT-SIGNATURE-PLAN.md §5.4)。
 * 仿 usePolicyRuleDrawer:只做邏輯,畫面接線留給 TS-4。
 *
 *   const d = usePaSignatureDrawer();           // reactive 物件(不要解構)
 *   d.linkable(nameOrId)   威脅名稱要不要顯示成可點(需要 netops.pa-signature.read 且能擷取出純數字 ID)
 *   d.show(nameOrId)       先查 GET /api/netops/pa-signatures/{id}:
 *                          - 200 found:直接開抽屜(d.detail,d.open = true)
 *                          - 202 queued:開抽屜並自動輪詢 GET /api/netops/pa-signature-lookups/{lookupId}(按需查 show threat id)
 *                          - 查無 / 限流 / 不可用:原因放在 d.notice
 *                          回傳 'ok' | 'forbidden' | 'invalid' | 'not-found' | 'cooldown' | 'rejected' | 'unavailable' | 'error' | 'stale'
 *   d.open / d.close()     抽屜開關(關閉時中止輪詢並清狀態)
 *   d.threatId / d.detail / d.loading / d.polling / d.notice
 */
import { computed, getCurrentScope, onScopeDispose, reactive, ref, shallowRef } from 'vue';
import { can, type ApiError } from '@/api/gateway';
import { API } from '@/api/perms';
import {
  isSignatureLookupQueued,
  PA_SIGNATURE_ERRORS,
  paSignatureApi,
  type SignatureDetailFound,
  type SignatureGetResponse,
  type SignatureLookupJob,
} from '@/api/paSignature';

const PURE_ID_RE = /^\d{1,10}$/;
const PAREN_ID_RE = /\((\d{1,10})\)$/;

/** 從威脅名稱「名稱(ID)」或純數字 ID 擷取特徵 ID;擷取不到回 null */
export function extractThreatId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (PURE_ID_RE.test(s)) return s;
  const m = PAREN_ID_RE.exec(s);
  return m ? m[1]! : null;
}

export type SignatureDrawerResult =
  | 'ok'
  | 'forbidden'
  | 'invalid'
  | 'not-found'
  | 'cooldown'
  | 'rejected'
  | 'unavailable'
  | 'error'
  | 'stale';

export interface UsePaSignatureDrawerOptions {
  backend?: Pick<typeof paSignatureApi, 'get' | 'lookup'>;
  /** 權限判斷(測試注入) */
  can?: (code: string) => boolean;
  /** 202 按需查詢輪詢間隔(ms,預設 1000;測試可縮短) */
  pollMs?: number;
  /** 202 按需查詢最多輪詢次數(預設 20) */
  maxPolls?: number;
}

const NOT_FOUND_FALLBACK = '本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)';

export function usePaSignatureDrawer(options: UsePaSignatureDrawerOptions = {}) {
  const backend = options.backend ?? paSignatureApi;
  const allowed = options.can ?? can;
  const pollMs = options.pollMs ?? 1000;
  const maxPolls = options.maxPolls ?? 20;

  const canOpen = computed(() => allowed(API.paSignatureRead));
  const open = ref(false);
  const loading = ref(false);
  const polling = ref(false);
  const threatId = ref<string | null>(null);
  const detail = shallowRef<SignatureDetailFound | null>(null);
  const lookupJob = shallowRef<SignatureLookupJob | null>(null);
  const notice = ref<string | null>(null);
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  const linkable = (nameOrId: string | null | undefined): boolean =>
    canOpen.value && extractThreatId(nameOrId) !== null;

  async function show(nameOrId: string | null | undefined): Promise<SignatureDrawerResult> {
    if (!canOpen.value) return 'forbidden';
    const id = extractThreatId(nameOrId);
    if (!id) return 'invalid';

    clearTimer();
    const my = ++seq;
    threatId.value = id;
    loading.value = true;
    polling.value = false;
    detail.value = null;
    lookupJob.value = null;
    notice.value = null;

    let res: SignatureGetResponse;
    try {
      res = await backend.get(id);
    } catch (e) {
      if (my !== seq) return 'stale';
      loading.value = false;
      open.value = false;
      const err = e as ApiError & { code?: string; status?: number };
      if (err?.code === PA_SIGNATURE_ERRORS.cooldown || err?.status === 429) {
        notice.value = err.message || '單筆特徵按需查詢限流中,請稍後再試';
        return 'cooldown';
      }
      if (err?.code === PA_SIGNATURE_ERRORS.unavailable || err?.status === 424) {
        notice.value = err.message || '目前無法連線特徵碼資料來源,請稍後再試';
        return 'unavailable';
      }
      if (err?.status === 403) {
        notice.value = '沒有檢視威脅特徵碼的權限';
        return 'forbidden';
      }
      notice.value = err?.message || '讀取威脅特徵碼失敗';
      return 'error';
    }

    if (my !== seq) return 'stale';

    // 202:快照沒有,已送收集器按需查 show threat id → 開啟抽屜並輪詢結果
    if (isSignatureLookupQueued(res)) {
      open.value = true;
      polling.value = true;
      const lookupId = res.lookupId;
      return await new Promise<SignatureDrawerResult>((resolve) => {
        let polls = 0;
        const step = async () => {
          if (my !== seq) {
            resolve('stale');
            return;
          }
          polls++;
          try {
            const job = await backend.lookup(lookupId);
            if (my !== seq) {
              resolve('stale');
              return;
            }
            lookupJob.value = job;
            if (job.status === 'done' && job.result) {
              detail.value = {
                found: true,
                source: 'lookup',
                checkedAt: job.finishedAt,
                item: {
                  ...job.result,
                  firstVersion: null,
                  isNew: false,
                  changes: [],
                  hits30d: null,
                  vault: null,
                },
              };
              loading.value = false;
              polling.value = false;
              resolve('ok');
              return;
            }
            if (job.status === 'not_found') {
              loading.value = false;
              polling.value = false;
              notice.value = job.message || NOT_FOUND_FALLBACK;
              resolve('not-found');
              return;
            }
            if (job.status === 'rejected') {
              loading.value = false;
              polling.value = false;
              notice.value = job.message || '防火牆管理平面 CPU 過高,暫停按需查詢';
              resolve('rejected');
              return;
            }
            if (job.status === 'failed') {
              loading.value = false;
              polling.value = false;
              notice.value = job.message || '按需查詢失敗';
              resolve('error');
              return;
            }
          } catch (e) {
            if (my !== seq) {
              resolve('stale');
              return;
            }
            loading.value = false;
            polling.value = false;
            const err = e as ApiError & { code?: string };
            notice.value = err?.message || '查詢按需結果失敗';
            resolve(err?.code === PA_SIGNATURE_ERRORS.unavailable ? 'unavailable' : 'error');
            return;
          }
          if (polls >= maxPolls) {
            loading.value = false;
            polling.value = false;
            notice.value = '按需查詢等待逾時,請稍後再試';
            resolve('error');
            return;
          }
          timer = setTimeout(() => void step(), pollMs);
        };
        timer = setTimeout(() => void step(), pollMs);
      });
    }

    loading.value = false;
    if (res.found) {
      detail.value = res;
      open.value = true;
      return 'ok';
    }
    open.value = false;
    notice.value = res.message || NOT_FOUND_FALLBACK;
    return 'not-found';
  }

  function close(): void {
    seq++;
    clearTimer();
    open.value = false;
    loading.value = false;
    polling.value = false;
    threatId.value = null;
    detail.value = null;
    lookupJob.value = null;
    notice.value = null;
  }

  if (getCurrentScope()) onScopeDispose(close);

  return reactive({
    canOpen,
    linkable,
    show,
    close,
    open,
    loading,
    polling,
    threatId,
    detail,
    lookupJob,
    notice,
  });
}
