/**
 * 防火牆 › 安全規則頁的狀態與邏輯(PR-3;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3、§3.6)。畫面(PR-4,Gemini)只用這裡,不直接呼叫 api/paPolicy。
 *
 *   const p = usePaPolicy();                    // reactive 物件:模板直接用 p.rules、p.loading(不要解構)
 *   清單分頁
 *     p.filters(q / zone / ip / includeAny / application / action / unusedDays / disabled)→ p.load()
 *     p.rules(依 PA 順序,position 為原編號)、p.total、p.defaults(預設規則命中數)、p.info(fetchedAt、stale、status、available、message)
 *     p.ipError:ip 篩選格式不符(不送出)
 *     p.openRule(name) → p.detail / p.detailLoading / p.detailError(規則詳細,含物件展開與命中數)
 *     p.canRefresh / p.refresh() / p.refreshNotice / p.cooldownSec(冷卻 5 分鐘;結果約 1 分鐘後重新 load 才看得到)
 *   IP 對照(§3.6;沒有 netops.ip-name.read 時 p.canNames false、不呼叫 API、畫面只顯示 IP)
 *     p.resolveNames(rule) → p.nameOf(value):{ status: 'ip', label } | { status: 'range', items, total, truncated } | { status: 'none' } | { status: 'unresolvable' } | { status: 'pending' }
 *     p.findByName(keyword):姓名 / 部門 / 設備 → 對照表 IP → 設定 filters.ip 並 load(姓名不進網址)
 *   變更紀錄分頁
 *     p.loadVersions() → p.versions;p.openDiff(id, base?) → p.diff / p.diffLoading / p.diffError
 *   規則圖分頁:全部規則(不篩選)p.loadAll() → p.allRules、p.allDefaults,交給 usePaPolicyViz
 */
import { computed, reactive, ref, shallowRef } from 'vue';
import { ApiError, can } from '@/api/gateway';
import { ipNames } from '@/api/ipNames';
import type { IpNameLabel } from '@/api/ipNames';
import { API, UI } from '@/api/perms';
import {
  paPolicyApi,
  PA_POLICY_ERRORS,
  PA_POLICY_LIMITS,
  type DefaultRuleHits,
  type PolicyDetail,
  type PolicyDiff,
  type PolicyFilter,
  type PolicyList,
  type PolicyRule,
  type PolicyVersion,
  type RangeLookup,
} from '@/api/paPolicy';

export type PaPolicyBackend = typeof paPolicyApi & { searchNames: (q: string) => Promise<{ items: { ip: string }[]; total: number }> };

export interface UsePaPolicyOptions {
  backend?: PaPolicyBackend;
  /** 權限判斷(測試注入) */
  can?: (code: string) => boolean;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** 清單最多讀幾頁(5000 條上限 / 100) */
const MAX_PAGES = 50;

/** 展開值的種類:ip(單一 IPv4 或 /32)、range(CIDR 或 a-b)、unresolvable(FQDN、動態群組、地區、IPv6 等,§3.6「無法對照」) */
export function classifyValue(v: string): { kind: 'ip'; ip: string } | { kind: 'range'; range: string } | { kind: 'unresolvable' } {
  const s = v.trim();
  if (IPV4.test(s)) return { kind: 'ip', ip: s };
  const [a = '', bits, extra] = s.split('/');
  if (extra === undefined && IPV4.test(a) && bits !== undefined && /^\d{1,2}$/.test(bits) && Number(bits) <= 32)
    return Number(bits) === 32 ? { kind: 'ip', ip: a } : { kind: 'range', range: s };
  const d = s.split('-');
  if (d.length === 2 && IPV4.test(d[0]!.trim()) && IPV4.test(d[1]!.trim())) return { kind: 'range', range: s };
  return { kind: 'unresolvable' };
}

/** ip 篩選格式檢查(同後端 parseIpFilter);空字串視為沒有篩選 */
export function checkIpFilter(text: string): string | null {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length > PA_POLICY_LIMITS.ipFilters) return `最多 ${PA_POLICY_LIMITS.ipFilters} 個`;
  return parts.every((p) => classifyValue(p).kind !== 'unresolvable') ? null : 'IPv4、CIDR 或 a-b 範圍,逗號分隔(第一版只支援 IPv4)';
}

export type NameView =
  | { status: 'ip'; label: IpNameLabel }
  | { status: 'range'; items: (IpNameLabel & { ip: string })[]; total: number; truncated: boolean }
  | { status: 'none' }
  | { status: 'unresolvable' }
  | { status: 'pending' };

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function usePaPolicy(options: UsePaPolicyOptions = {}) {
  const backend: PaPolicyBackend = options.backend ?? { ...paPolicyApi, searchNames: (q) => ipNames.list(q, 1, 100) };
  const allowed = options.can ?? can;

  const filters = reactive<PolicyFilter>({});
  const rules = shallowRef<PolicyRule[]>([]);
  const total = ref(0);
  const defaults = shallowRef<DefaultRuleHits[]>([]);
  const info = shallowRef<Omit<PolicyList, 'items' | 'total' | 'page' | 'pageSize' | 'defaults'> | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  let seq = 0;

  const ipError = computed(() => (filters.ip ? checkIpFilter(filters.ip) : null));

  /** 讀完所有符合的頁(規則數少,畫面自行分頁 / 捲動) */
  async function fetchAll(f: PolicyFilter, retry = 1): Promise<PolicyList> {
    const first = await backend.list(f, 1, PA_POLICY_LIMITS.pageSize);
    const items = [...first.items];
    const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PA_POLICY_LIMITS.pageSize));
    const hashOf = (r: PolicyList) => (r.available ? r.hash : null);
    for (let p = 2; p <= pages; p++) {
      const r = await backend.list(f, p, PA_POLICY_LIMITS.pageSize);
      // 分頁讀取期間快照更新了:各頁會混到不同版本(重複或漏列),從第一頁重讀一次
      if (hashOf(r) !== hashOf(first)) {
        if (retry > 0) return fetchAll(f, retry - 1);
        throw new Error('規則在讀取期間更新了,請重新載入');
      }
      items.push(...r.items);
    }
    return { ...first, items };
  }

  const clean = (f: PolicyFilter): PolicyFilter =>
    Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '' && v !== null)) as PolicyFilter;

  async function load(): Promise<boolean> {
    if (ipError.value) return false;
    const my = ++seq;
    loading.value = true;
    error.value = null;
    try {
      const r = await fetchAll(clean(filters));
      if (my !== seq) return false;
      const { items, total: t, page: _p, pageSize: _s, defaults: d, ...rest } = r;
      rules.value = items;
      total.value = t;
      defaults.value = d;
      info.value = rest;
      return true;
    } catch (e) {
      if (my === seq) error.value = e as Error;
      return false;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  /* 規則圖用:全部規則 */
  const allRules = shallowRef<PolicyRule[]>([]);
  const allDefaults = shallowRef<DefaultRuleHits[]>([]);
  const allLoading = ref(false);
  const allError = ref<Error | null>(null);
  let allSeq = 0;
  async function loadAll(): Promise<boolean> {
    const my = ++allSeq;
    allLoading.value = true;
    allError.value = null;
    try {
      const r = await fetchAll({});
      if (my !== allSeq) return false;
      allRules.value = r.items;
      allDefaults.value = r.defaults;
      if (!info.value) {
        const { items: _i, total: _t, page: _p, pageSize: _s, defaults: _d, ...rest } = r;
        info.value = rest;
      }
      return true;
    } catch (e) {
      if (my === allSeq) allError.value = e as Error;
      return false;
    } finally {
      if (my === allSeq) allLoading.value = false;
    }
  }

  /* 規則詳細 */
  const detail = shallowRef<PolicyDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref<Error | null>(null);
  let detailSeq = 0;
  async function openRule(name: string): Promise<void> {
    const my = ++detailSeq;
    detailLoading.value = true;
    detailError.value = null;
    try {
      const d = await backend.get(name);
      if (my === detailSeq) detail.value = d;
    } catch (e) {
      if (my === detailSeq) {
        detail.value = null;
        detailError.value = e as Error;
      }
    } finally {
      if (my === detailSeq) detailLoading.value = false;
    }
  }
  const closeRule = () => {
    detailSeq++;
    detail.value = null;
    detailError.value = null;
    detailLoading.value = false;
  };

  /* 手動重新整理 */
  const canRefresh = computed(() => allowed(UI.paPolicyRefresh));
  const refreshing = ref(false);
  const refreshNotice = ref<string | null>(null);
  const cooldownSec = computed(() => (info.value?.status?.refreshCooldownSec ?? 0));
  async function refresh(): Promise<boolean> {
    refreshing.value = true;
    refreshNotice.value = null;
    try {
      await backend.refresh();
      refreshNotice.value = '已請收集器重新讀取,約 1 分鐘後重新載入即可看到(管理平面 CPU 過高時不讀,結果看收集狀態)';
      return true;
    } catch (e) {
      const err = e as ApiError & { code?: string; details?: { retryAfter?: number } };
      if (err.code === PA_POLICY_ERRORS.cooldown) refreshNotice.value = err.message;
      else if (err.code === PA_POLICY_ERRORS.disabled) refreshNotice.value = err.message;
      else throw e;
      return false;
    } finally {
      refreshing.value = false;
    }
  }

  /* IP 對照(§3.6) */
  const canNames = computed(() => allowed(API.ipNameRead));
  const ipLabels = reactive(new Map<string, IpNameLabel | null>());
  const rangeLabels = reactive(new Map<string, RangeLookup>());
  const namesError = ref<Error | null>(null);

  async function resolveValues(values: string[]): Promise<void> {
    if (!canNames.value) return;
    const ips = new Set<string>();
    const ranges = new Set<string>();
    for (const v of values) {
      const c = classifyValue(v);
      if (c.kind === 'ip' && !ipLabels.has(c.ip)) ips.add(c.ip);
      if (c.kind === 'range' && !rangeLabels.has(c.range)) ranges.add(c.range);
    }
    namesError.value = null;
    // 查詢失敗時這批標成「查不到」,不要永遠停在 pending(錯誤另看 namesError)
    const giveUp = () => {
      for (const ip of ips) if (!ipLabels.has(ip)) ipLabels.set(ip, null);
      for (const r of ranges) if (!rangeLabels.has(r)) rangeLabels.set(r, { items: [], total: 0, truncated: false });
    };
    try {
      for (const part of chunks([...ips], PA_POLICY_LIMITS.lookups)) {
        const r = await backend.lookupIps(part);
        for (const ip of part) ipLabels.set(ip, r.names[ip] ?? null);
      }
      for (const part of chunks([...ranges], PA_POLICY_LIMITS.lookups)) {
        const r = await backend.lookupRanges(part);
        for (const range of part) rangeLabels.set(range, r.results[range] ?? { items: [], total: 0, truncated: false });
      }
    } catch (e) {
      // 對照失敗不影響規則顯示(只顯示 IP)
      namesError.value = e as Error;
      giveUp();
    }
  }
  /** 查一條規則來源 / 目的的所有展開值 */
  const resolveNames = (rule: PolicyRule) => resolveValues([...rule.expanded.sources, ...rule.expanded.destinations].flatMap((a) => a.values));

  function nameOf(value: string): NameView {
    const c = classifyValue(value);
    if (c.kind === 'unresolvable') return { status: 'unresolvable' };
    if (c.kind === 'ip') {
      if (!ipLabels.has(c.ip)) return { status: 'pending' };
      const l = ipLabels.get(c.ip);
      return l ? { status: 'ip', label: l } : { status: 'none' };
    }
    const r = rangeLabels.get(c.range);
    if (!r) return { status: 'pending' };
    if ('invalid' in r || !r.total) return { status: 'none' };
    return { status: 'range', items: r.items, total: r.total, truncated: r.truncated };
  }

  /** 用名稱找規則(§3.6 選配):對照表符合的 IP(最多 50 個)→ ip 篩選。回 { matched, truncated };沒有權限回 null */
  async function findByName(keyword: string): Promise<{ matched: number; truncated: boolean } | null> {
    if (!canNames.value || !keyword.trim()) return null;
    const my = ++seq;
    const r = await backend.searchNames(keyword.trim());
    // 等待期間有新的查詢(load / findByName)就不套用這次結果
    if (my !== seq) return null;
    const ips = [...new Set(r.items.map((e) => e.ip))];
    const used = ips.slice(0, PA_POLICY_LIMITS.ipFilters);
    if (!used.length) {
      // 篩選條件與清單一致:清掉 ip 篩選,清單為空(對照表沒有符合的名稱)
      filters.ip = undefined;
      rules.value = [];
      total.value = 0;
      error.value = null;
      return { matched: 0, truncated: false };
    }
    filters.ip = used.join(',');
    await load();
    return { matched: r.total, truncated: r.total > used.length };
  }

  /* 變更紀錄 */
  const versions = shallowRef<PolicyVersion[]>([]);
  const versionsLoading = ref(false);
  const versionsError = ref<Error | null>(null);
  async function loadVersions(): Promise<void> {
    versionsLoading.value = true;
    versionsError.value = null;
    try {
      versions.value = (await backend.versions()).items;
    } catch (e) {
      versionsError.value = e as Error;
    } finally {
      versionsLoading.value = false;
    }
  }
  const diff = shallowRef<PolicyDiff | null>(null);
  const diffLoading = ref(false);
  const diffError = ref<Error | null>(null);
  let diffSeq = 0;
  async function openDiff(id: string, base?: string): Promise<void> {
    const my = ++diffSeq;
    diffLoading.value = true;
    diffError.value = null;
    try {
      const d = await backend.diff(id, base);
      if (my === diffSeq) diff.value = d;
    } catch (e) {
      if (my === diffSeq) {
        diff.value = null;
        diffError.value = e as Error;
      }
    } finally {
      if (my === diffSeq) diffLoading.value = false;
    }
  }

  return reactive({
    filters,
    rules,
    total,
    defaults,
    info,
    loading,
    error,
    ipError,
    load,
    allRules,
    allDefaults,
    allLoading,
    allError,
    loadAll,
    detail,
    detailLoading,
    detailError,
    openRule,
    closeRule,
    canRefresh,
    refreshing,
    refreshNotice,
    cooldownSec,
    refresh,
    canNames,
    namesError,
    resolveNames,
    nameOf,
    findByName,
    versions,
    versionsLoading,
    versionsError,
    loadVersions,
    diff,
    diffLoading,
    diffError,
    openDiff,
  });
}
