/**
 * 防火牆 › 威脅特徵碼頁的狀態與邏輯(TS-2;docs/THREAT-SIGNATURE-PLAN.md §5、§7)。
 * 畫面(TS-4)只用這裡,不直接呼叫 api/paSignature。
 *
 *   const s = usePaSignature();  // reactive 物件(模板直接用 s.items、s.loading,不要解構)
 *   - 特徵清單:s.filters(kind / severity / q / isNew / hasHits / days: 7|30|90)、s.page、s.pageSize → s.load()
 *     s.items、s.total、s.info(含 threatVersion、since、baselineAt、versions、counts、status)
 *   - 版本差異:s.loadVersions() → s.versions / s.baselineAt;s.loadDiff(version) → s.diff / s.diffFilters
 *   - 命中比對:s.queryHits(input?) 依 can(API.paLogRead) 自動選擇含 IP 或無 IP 路由(TS-Q8,後端 BFF 強制);
 *     202 工作自動輪詢,可用 s.cancelHits() 取消;有 can(API.ipNameRead) 時才查 IP 名稱(s.nameOfIp)
 *   - 規則覆蓋:s.canCoverage(can(API.paPolicyRead))→ s.loadCoverage() → s.coverage
 *   - 手動重新整理:s.canRefresh(can(UI.paSignatureRefresh))→ s.refresh() / s.refreshNotice / s.cooldownSec
 */
import { computed, getCurrentScope, onScopeDispose, reactive, ref, shallowRef } from 'vue';
import { ApiError, can } from '@/api/gateway';
import type { IpNameLabel } from '@/api/ipNames';
import { isFinished, JOB_ERROR } from '@/api/jobs';
import { API, UI } from '@/api/perms';
import {
  PA_SIGNATURE_DAYS,
  PA_SIGNATURE_ERRORS,
  PA_SIGNATURE_LIMITS,
  paSignatureApi,
  type HitQueryInput,
  type HitQueryJob,
  type HitQueryResult,
  type SignatureCoverage,
  type SignatureDays,
  type SignatureDiffFilter,
  type SignatureFilter,
  type SignatureInfo,
  type SignatureRow,
  type SignatureStatusResponse,
  type SignatureVersionDiffs,
  type SignatureVersionMeta,
} from '@/api/paSignature';

export type PaSignatureBackend = typeof paSignatureApi;

export interface UsePaSignatureOptions {
  backend?: PaSignatureBackend;
  /** 權限判斷(測試注入) */
  can?: (code: string) => boolean;
  /** 202 工作輪詢間隔(ms,預設 1500;測試可縮短) */
  pollMs?: number;
  /** 202 工作最多輪詢幾次(預設 60) */
  maxPolls?: number;
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const cleanObj = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)) as T;

/** P2:判斷某版本(版本清單列或差異結果)是否因精簡索引重建而「差異無法計算」 */
export function isDiffUnavailable(v: Pick<SignatureVersionMeta, 'rebuilt'> | Pick<SignatureVersionDiffs, 'rebuilt'> | null | undefined): boolean {
  return Boolean(v?.rebuilt);
}

export function usePaSignature(options: UsePaSignatureOptions = {}) {
  const backend: PaSignatureBackend = options.backend ?? paSignatureApi;
  const allowed = options.can ?? can;
  const pollMs = options.pollMs ?? 1500;
  const maxPolls = options.maxPolls ?? 60;

  /* ───────── 1. 特徵清單 ───────── */
  const filters = reactive<SignatureFilter>({ days: 30 });
  const page = ref(1);
  const pageSize = ref(50);
  const items = shallowRef<SignatureRow[]>([]);
  const total = ref(0);
  const info = shallowRef<SignatureInfo | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  let listSeq = 0;

  function setDays(d: SignatureDays): void {
    if (!PA_SIGNATURE_DAYS.includes(d)) return;
    filters.days = d;
  }

  async function load(nextPage?: number): Promise<boolean> {
    if (nextPage !== undefined) page.value = Math.max(1, nextPage);
    const my = ++listSeq;
    loading.value = true;
    error.value = null;
    try {
      const days = filters.days && PA_SIGNATURE_DAYS.includes(filters.days) ? filters.days : 30;
      const r = await backend.list(cleanObj({ ...filters, days }), page.value, Math.min(PA_SIGNATURE_LIMITS.pageSize, Math.max(1, pageSize.value)));
      if (my !== listSeq) return false;
      const { items: rows, total: t, page: p, pageSize: ps, ...rest } = r;
      items.value = rows;
      total.value = t;
      page.value = p;
      pageSize.value = ps;
      info.value = rest as SignatureInfo;
      return true;
    } catch (e) {
      if (my === listSeq) error.value = e as Error;
      return false;
    } finally {
      if (my === listSeq) loading.value = false;
    }
  }

  /* ───────── 2. 版本歷史與差異 ───────── */
  const versions = shallowRef<SignatureVersionMeta[]>([]);
  const baselineAt = ref<string | null>(null);
  const baselineVersion = ref<string | null>(null);
  const versionsLoading = ref(false);
  const versionsError = ref<Error | null>(null);

  async function loadVersions(): Promise<boolean> {
    versionsLoading.value = true;
    versionsError.value = null;
    try {
      const r = await backend.versions();
      versions.value = r.items;
      baselineAt.value = r.baselineAt;
      baselineVersion.value = r.baselineVersion;
      return true;
    } catch (e) {
      versionsError.value = e as Error;
      return false;
    } finally {
      versionsLoading.value = false;
    }
  }

  const selectedVersion = ref<string | null>(null);
  const diffFilters = reactive<SignatureDiffFilter>({});
  const diffPage = ref(1);
  const diffPageSize = ref(50);
  const diff = shallowRef<SignatureVersionDiffs | null>(null);
  const diffLoading = ref(false);
  const diffError = ref<Error | null>(null);
  let diffSeq = 0;

  /** 目前載入版本(清單)是否因索引重建而無法計算差異(P2) */
  const currentVersionRebuilt = computed(() => Boolean(info.value?.available && info.value.rebuilt));
  /** 目前檢視的差異版本是否因索引重建而無法計算差異(P2) */
  const diffUnavailable = computed(() => isDiffUnavailable(diff.value));
  const diffUnavailableMessage = computed(() =>
    diffUnavailable.value ? '此版本因精簡索引遺失或損壞而重建，無法計算相對於前一版的差異' : null,
  );

  async function loadDiff(version: string, nextPage?: number): Promise<boolean> {
    selectedVersion.value = version;
    if (nextPage !== undefined) diffPage.value = Math.max(1, nextPage);
    const my = ++diffSeq;
    diffLoading.value = true;
    diffError.value = null;
    try {
      const r = await backend.versionDiffs(
        version,
        cleanObj({ ...diffFilters }),
        diffPage.value,
        Math.min(PA_SIGNATURE_LIMITS.pageSize, Math.max(1, diffPageSize.value)),
      );
      if (my !== diffSeq) return false;
      diff.value = r;
      diffPage.value = r.page;
      diffPageSize.value = r.pageSize;
      return true;
    } catch (e) {
      if (my === diffSeq) {
        diff.value = null;
        diffError.value = e as Error;
      }
      return false;
    } finally {
      if (my === diffSeq) diffLoading.value = false;
    }
  }

  /* ───────── 3. 命中比對(依 TS-Q8 權限選路由,202 輪詢) & IP 名稱對照 ───────── */
  const canHitIps = computed(() => allowed(API.paLogRead));
  const canNames = computed(() => allowed(API.ipNameRead));
  const ipLabels = reactive(new Map<string, IpNameLabel | null>());
  const namesError = ref<Error | null>(null);

  const hitsResult = shallowRef<HitQueryResult | null>(null);
  const hitsJob = shallowRef<HitQueryJob | null>(null);
  const hitsLoading = ref(false);
  const hitsError = ref<Error | null>(null);
  let hitsSeq = 0;
  let hitsTimer: ReturnType<typeof setTimeout> | null = null;
  let activeJob: { id: string; withIps: boolean } | null = null;

  function clearHitsTimer(): void {
    if (hitsTimer !== null) {
      clearTimeout(hitsTimer);
      hitsTimer = null;
    }
  }

  async function resolveHitIpNames(result: HitQueryResult | null = hitsResult.value): Promise<void> {
    if (!canNames.value || !result?.includeIps) return;
    const ips = new Set<string>();
    for (const item of result.items) {
      for (const x of item.topSrc ?? []) if (x.ip && !ipLabels.has(x.ip)) ips.add(x.ip);
      for (const x of item.topDst ?? []) if (x.ip && !ipLabels.has(x.ip)) ips.add(x.ip);
    }
    if (!ips.size) return;
    namesError.value = null;
    try {
      for (const part of chunks([...ips], PA_SIGNATURE_LIMITS.ipLookups)) {
        const r = await backend.lookupIps(part);
        for (const ip of part) ipLabels.set(ip, r.names[ip] ?? null);
      }
    } catch (e) {
      namesError.value = e as Error;
      for (const ip of ips) if (!ipLabels.has(ip)) ipLabels.set(ip, null);
    }
  }

  function nameOfIp(ip: string): IpNameLabel | null {
    return ipLabels.get(ip) ?? null;
  }

  async function cancelHits(): Promise<void> {
    hitsSeq++;
    clearHitsTimer();
    const cur = activeJob;
    activeJob = null;
    hitsJob.value = null;
    hitsLoading.value = false;
    if (cur) {
      try {
        if (cur.withIps) await backend.cancelHitIpJob(cur.id);
        else await backend.cancelHitJob(cur.id);
      } catch {
        // 冪等取消,忽略錯誤
      }
    }
  }

  async function queryHits(input: HitQueryInput = {}): Promise<boolean> {
    clearHitsTimer();
    const my = ++hitsSeq;
    hitsLoading.value = true;
    hitsError.value = null;
    hitsJob.value = null;
    activeJob = null;

    const withIps = canHitIps.value;
    const days = input.days && PA_SIGNATURE_DAYS.includes(input.days) ? input.days : (filters.days ?? 30);
    const body: HitQueryInput = { ...input, days };

    try {
      const res = withIps ? await backend.queryHitIps(body) : await backend.queryHits(body);
      if (my !== hitsSeq) return false;
      if (res.kind === 'result') {
        hitsResult.value = res.result;
        hitsLoading.value = false;
        void resolveHitIpNames(res.result);
        return true;
      }
      const jobId = res.job.jobId ?? res.job.id;
      hitsJob.value = res.job;
      activeJob = { id: jobId, withIps };

      return await new Promise<boolean>((resolve) => {
        let polls = 0;
        const step = async () => {
          if (my !== hitsSeq) {
            resolve(false);
            return;
          }
          polls++;
          try {
            const j = withIps ? await backend.hitIpJob(jobId) : await backend.hitJob(jobId);
            if (my !== hitsSeq) {
              resolve(false);
              return;
            }
            hitsJob.value = j;
            if (isFinished(j.status)) {
              activeJob = null;
              hitsLoading.value = false;
              if (j.status === 'done' && j.result) {
                hitsResult.value = j.result;
                void resolveHitIpNames(j.result);
                resolve(true);
              } else {
                const code = j.error?.code;
                const msg = (code && JOB_ERROR[code]) || j.error?.message || (j.status === 'cancelled' ? '查詢已取消' : '命中比對查詢失敗');
                hitsError.value = new Error(msg);
                resolve(false);
              }
              return;
            }
          } catch (e) {
            if (my !== hitsSeq) {
              resolve(false);
              return;
            }
            activeJob = null;
            hitsLoading.value = false;
            const err = e as ApiError;
            hitsError.value = err.code && JOB_ERROR[err.code] ? new Error(JOB_ERROR[err.code]) : (e as Error);
            resolve(false);
            return;
          }
          if (polls >= maxPolls) {
            activeJob = null;
            hitsLoading.value = false;
            hitsError.value = new Error('命中比對等待逾時,請稍後再試');
            resolve(false);
            return;
          }
          hitsTimer = setTimeout(() => void step(), pollMs);
        };
        hitsTimer = setTimeout(() => void step(), pollMs);
      });
    } catch (e) {
      if (my === hitsSeq) {
        hitsLoading.value = false;
        hitsError.value = e as Error;
      }
      return false;
    }
  }

  /* ───────── 4. 規則覆蓋(需 netops.pa-policy.read) ───────── */
  const canCoverage = computed(() => allowed(API.paPolicyRead));
  const coverage = shallowRef<SignatureCoverage | null>(null);
  const coverageLoading = ref(false);
  const coverageError = ref<Error | null>(null);

  async function loadCoverage(): Promise<boolean> {
    if (!canCoverage.value) return false;
    coverageLoading.value = true;
    coverageError.value = null;
    try {
      coverage.value = await backend.coverage();
      return true;
    } catch (e) {
      coverageError.value = e as Error;
      return false;
    } finally {
      coverageLoading.value = false;
    }
  }

  /* ───────── 5. 手動重新整理與收集狀態 ───────── */
  const canRefresh = computed(() => allowed(UI.paSignatureRefresh));
  const canAi = computed(() => allowed(UI.paSignatureAi));
  const refreshing = ref(false);
  const refreshNotice = ref<string | null>(null);
  const status = shallowRef<SignatureStatusResponse | null>(null);
  const statusLoading = ref(false);
  const cooldownSec = computed(() => {
    if (status.value?.available) return status.value.refreshCooldownSec;
    return info.value?.status?.refreshCooldownSec ?? 0;
  });

  async function loadStatus(): Promise<boolean> {
    statusLoading.value = true;
    try {
      status.value = await backend.status();
      return true;
    } catch {
      return false;
    } finally {
      statusLoading.value = false;
    }
  }

  async function refresh(): Promise<boolean> {
    if (!canRefresh.value) return false;
    refreshing.value = true;
    refreshNotice.value = null;
    try {
      await backend.refresh();
      refreshNotice.value = '已請收集器重新讀取威脅特徵碼,約 1 分鐘後重新載入即可看到(管理平面 CPU 過高時不讀,結果看收集狀態)';
      return true;
    } catch (e) {
      const err = e as ApiError & { code?: string };
      if (
        err.code === PA_SIGNATURE_ERRORS.cooldown ||
        err.code === PA_SIGNATURE_ERRORS.disabled ||
        err.code === PA_SIGNATURE_ERRORS.unavailable
      ) {
        refreshNotice.value = err.message;
        return false;
      }
      throw e;
    } finally {
      refreshing.value = false;
    }
  }

  function dispose(): void {
    hitsSeq++;
    clearHitsTimer();
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return reactive({
    filters,
    page,
    pageSize,
    items,
    total,
    info,
    loading,
    error,
    setDays,
    load,
    versions,
    baselineAt,
    baselineVersion,
    versionsLoading,
    versionsError,
    loadVersions,
    selectedVersion,
    diffFilters,
    diffPage,
    diffPageSize,
    diff,
    diffLoading,
    diffError,
    currentVersionRebuilt,
    diffUnavailable,
    diffUnavailableMessage,
    isDiffUnavailable,
    loadDiff,
    canHitIps,
    canNames,
    namesError,
    hitsResult,
    hitsJob,
    hitsLoading,
    hitsError,
    queryHits,
    cancelHits,
    resolveHitIpNames,
    nameOfIp,
    canCoverage,
    coverage,
    coverageLoading,
    coverageError,
    loadCoverage,
    canRefresh,
    canAi,
    refreshing,
    refreshNotice,
    cooldownSec,
    refresh,
    status,
    statusLoading,
    loadStatus,
    dispose,
  });
}
