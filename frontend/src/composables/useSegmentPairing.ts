/**
 * 網段設定 × IP 對照表搭配(SG-4;docs/SEGMENT-SETTINGS-PLAN.md §3 A–D)的前端邏輯。畫面(Gemini)只用這裡,不直接呼叫 API。
 * 名稱(含姓名、部門屬個資)只給 netops.ip-name.read:沒有權限時不呼叫 lookup,畫面只顯示 IP;BFF 也會以 403 擋(真正的安全機制)。
 * 名稱只放記憶體,不存瀏覽器(AGENT.md §7.1)。
 *
 *   A 未分類 IP 協助分類(網段設定頁預覽區):
 *     const a = useUnmatchedAssist(settings)     // settings = useSegmentSettings()
 *     a.rows                                     // [{ ip, count, slash24, label: { name, department, device } | null }]
 *     a.addToSegment(ip, segmentIndex)           // 把 ip/32 加進某網段(草稿)
 *     a.createSlash24(ip, label?)                // 依此 IP 建 /24 網段(草稿);回新網段索引,已被涵蓋回 -1
 *   B 從 IP 對照表的網段列建立(網段設定頁的對話框):
 *     const b = useIpNameCidrImport(settings)
 *     await b.load()                             // 讀對照表中 CIDR(/8–/31)的列
 *     b.candidates                               // [{ key, cidr, label, coveredBy, entry }];coveredBy = 已被哪個網段涵蓋
 *     b.selected(Set)/b.toggle(key)/b.importSelected()   // 加進草稿(名稱:部門 > 備註 > 設備 > 姓名 > CIDR;已涵蓋的略過,畫面請停用其勾選);回新增數
 *   C IP 對照表顯示所屬網段(IP 對照表頁加一欄,唯讀):
 *     const c = useSegmentLookup()               // 掛載時讀網段設定(沒有 netops.segment.read 時 available false,不顯示欄)
 *     c.available / c.segmentOf(ipOrCidr)        // → { id, label } | null
 *   D 戰情室滑過右側網段節點時 Top 內部 IP 帶設備名稱:
 *     const d = useSegmentDeviceNames()
 *     d.ensure(segment.topIps.map(t => t.key))   // 滑過時呼叫(去重、快取;沒有權限不呼叫)
 *     d.deviceOf(ip)                             // → 設備名稱(沒有則名稱 / 部門),沒有權限或查不到 → null(只顯示 IP)
 */
import { computed, onMounted, reactive, ref, shallowReactive, shallowRef, watch } from 'vue';
import { ApiError, can } from '@/api/gateway';
import { ipNames, type IpNameEntry, type IpNameLabel } from '@/api/ipNames';
import { API } from '@/api/perms';
import { segmentsApi, SEGMENT_LIMITS, type SegmentDef } from '@/api/segments';
import { createSegmentMatcher, normalizeCidr, parseCidr, slash24Of, suggestId } from './segmentRules';
import type { SegmentSettingsState } from './useSegmentSettings';

/** lookup 一次最多幾個 IP(後端上限) */
export const LOOKUP_MAX = 200;
/** 名稱快取上限(超過清空) */
const CACHE_MAX = 5000;

export type IpNameLookup = (ips: string[]) => Promise<{ names: Record<string, IpNameLabel> }>;

/** 有名稱權限才查;去重、分批、快取(查不到的也記住,避免每次滑過都送) */
export function createNameCache(lookup: IpNameLookup = ipNames.lookup, allowed: () => boolean = () => can(API.ipNameRead)) {
  const names = shallowReactive(new Map<string, IpNameLabel | null>());
  const pending = new Set<string>();
  const error = ref<Error | null>(null);
  /** 收到 403(沒有或被收回對照表權限)後不再查詢,只顯示 IP */
  let denied = false;
  async function ensure(ips: Iterable<string>): Promise<void> {
    if (!allowed() || denied) return;
    const want = [...new Set(ips)].filter((ip) => !names.has(ip) && !pending.has(ip) && parseCidr(ip)?.bits === 32);
    if (!want.length) return;
    if (names.size + want.length > CACHE_MAX) names.clear();
    for (const ip of want) pending.add(ip);
    try {
      for (let i = 0; i < want.length; i += LOOKUP_MAX) {
        const part = want.slice(i, i + LOOKUP_MAX);
        const r = await lookup(part);
        for (const ip of part) names.set(ip, r.names[ip] ?? null);
      }
      error.value = null;
    } catch (e) {
      // 403:停止查詢;其他錯誤:這批記成查不到(不在每次滑過時重送),畫面照常只看 IP
      error.value = e as Error;
      if (e instanceof ApiError && e.status === 403) denied = true;
      for (const ip of want) if (!names.has(ip)) names.set(ip, null);
    } finally {
      for (const ip of want) pending.delete(ip);
    }
  }
  return { names, ensure, error, allowed, label: (ip: string): IpNameLabel | null => (allowed() ? (names.get(ip) ?? null) : null) };
}

// ---------- A ----------
export function useUnmatchedAssist(settings: SegmentSettingsState, cache = createNameCache()) {
  // 預覽結果換了就查名稱(有權限才查)
  watch(
    () => [settings.preview, cache.allowed()] as const,
    ([p]) => void cache.ensure((p?.unmatched.top ?? []).map((t) => t.ip)),
    { immediate: true },
  );
  const rows = computed(() => {
    const top = settings.preview?.unmatched.top ?? [];
    return top.map((t) => ({ ip: t.ip, count: t.count, slash24: slash24Of(t.ip), label: cache.label(t.ip) }));
  });
  function addToSegment(ip: string, segmentIndex: number): boolean {
    const cidr = normalizeCidr(ip);
    const s = settings.draft.segments[segmentIndex];
    if (!cidr || !s || s.cidrs.includes(cidr) || s.cidrs.length >= SEGMENT_LIMITS.cidrs) return false;
    // 空白的第一格(剛新增的網段)直接填入
    if (s.cidrs.length === 1 && s.cidrs[0] === '') s.cidrs[0] = cidr;
    else s.cidrs.push(cidr);
    return true;
  }
  /** 回新網段索引;-1 = 不是 IPv4、這個 /24 已整個被某網段涵蓋,或已達網段上限 */
  function createSlash24(ip: string, label?: string): number {
    const cidr = slash24Of(ip);
    if (!cidr) return -1;
    if (createSegmentMatcher(settings.draft.segments)(cidr)) return -1;
    const l = cache.label(ip);
    const name = (label ?? (l?.department || `網段 ${cidr}`)).slice(0, SEGMENT_LIMITS.label);
    return settings.addSegment({ label: name, cidrs: [cidr] });
  }
  return reactive({ rows, addToSegment, createSlash24, canSeeNames: computed(() => cache.allowed()), nameError: cache.error });
}

// ---------- B ----------
export interface CidrCandidate {
  key: string;
  cidr: string;
  label: string;
  /** 已涵蓋這個網段的現有網段(草稿) */
  coveredBy: { id: string; label: string } | null;
  entry: IpNameEntry;
}

const PAGE = 100;
/** 最多讀幾頁(對照表上限內;避免無限迴圈) */
const MAX_PAGES = 200;

export function useIpNameCidrImport(settings: SegmentSettingsState, list = ipNames.list) {
  const loading = ref(false);
  const error = ref<Error | null>(null);
  const entries = shallowRef<IpNameEntry[]>([]);
  const selected = reactive(new Set<string>());

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      const out: IpNameEntry[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await list('', page, PAGE);
        for (const e of r.items) {
          const p = parseCidr(e.ip);
          // /0–/7 太大(幾乎涵蓋全部流量),不列為候選
          if (e.ip.includes('/') && p && p.bits >= 8 && p.bits < 32) out.push(e);
        }
        if (page * PAGE >= r.total || !r.items.length) break;
      }
      entries.value = out;
      selected.clear();
    } catch (e) {
      error.value = e as Error;
    } finally {
      loading.value = false;
    }
  }

  const candidates = computed<CidrCandidate[]>(() => {
    const match = createSegmentMatcher(settings.draft.segments);
    return entries.value.map((e) => {
      const cidr = normalizeCidr(e.ip)!;
      const label = (e.department || e.note || e.device || e.name || cidr).trim().slice(0, SEGMENT_LIMITS.label);
      return { key: e.id, cidr, label, coveredBy: match(cidr), entry: e };
    });
  });
  const toggle = (key: string) => (selected.has(key) ? selected.delete(key) : selected.add(key));

  /** 選取的列各建一個網段(同名稱的併成同一個網段);回新增網段數 */
  function importSelected(kind: SegmentDef['kind'] = 'vlan'): number {
    const byLabel = new Map<string, string[]>();
    for (const c of candidates.value) {
      if (!selected.has(c.key) || c.coveredBy) continue;
      const list = byLabel.get(c.label) ?? byLabel.set(c.label, []).get(c.label)!;
      if (!list.includes(c.cidr)) list.push(c.cidr);
    }
    let n = 0;
    for (const [label, cidrs] of byLabel) {
      if (settings.draft.segments.length >= SEGMENT_LIMITS.segments) break;
      settings.addSegment({ id: suggestId(label, settings.draft.segments.map((s) => s.id)), label, kind, cidrs: cidrs.slice(0, SEGMENT_LIMITS.cidrs) });
      n++;
    }
    selected.clear();
    return n;
  }
  return reactive({ loading, error, candidates, selected, toggle, load, importSelected });
}

// ---------- C ----------
export function useSegmentLookup(opts: { get?: typeof segmentsApi.get; allowed?: () => boolean; immediate?: boolean } = {}) {
  const get = opts.get ?? segmentsApi.get;
  const allowed = opts.allowed ?? (() => can(API.segmentRead));
  const segments = shallowRef<SegmentDef[] | null>(null);
  const error = ref<Error | null>(null);
  async function load() {
    if (!allowed()) return;
    try {
      const s = await get();
      // 尚未設定(範例)或設定檔壞掉時不顯示,避免把範例網段當成真的
      segments.value = s.source === 'file' ? s.segments : null;
      error.value = null;
    } catch (e) {
      error.value = e as Error;
    }
  }
  const matcher = computed(() => createSegmentMatcher(segments.value ?? []));
  if (opts.immediate !== false) onMounted(load);
  return reactive({
    available: computed(() => allowed() && segments.value !== null),
    error,
    load,
    segmentOf: (ipOrCidr: string) => matcher.value(ipOrCidr),
  });
}

// ---------- D ----------
export function useSegmentDeviceNames(cache = createNameCache()) {
  /** 顯示用:設備名稱 > 姓名 > 部門 */
  const deviceOf = (ip: string): string | null => {
    const l = cache.label(ip);
    return l ? l.device || l.name || l.department || null : null;
  };
  return reactive({ ensure: cache.ensure, deviceOf, canSeeNames: computed(() => cache.allowed()) });
}
