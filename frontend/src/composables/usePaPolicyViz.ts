/**
 * 安全規則「規則圖」分頁的資料(PR-3;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.5,Q5)。輸出純資料,不依賴 ECharts 型別;畫面(PR-4)自行轉成圖表 option。
 *
 * 資料規則(§3.5,逐條):
 *   - any zone 獨立成一列 / 一欄,不攤到每一格
 *   - 規則有多個 zone 時每個(來源, 目的)組合各算一次;矩陣「規則數」是出現次數,不能加總成總規則數(總數看 ruleCount)
 *   - Sankey 命中數:多 zone 規則依組合數平均分攤(estimated true,tooltip 標「多 zone 規則平均分攤,為估算值」)
 *   - 停用規則不進矩陣與 Sankey,只在順序條淡色顯示
 *   - intrazone-default / interzone-default 只有命中數:順序條放最後並標「預設規則」;Sankey 以「預設規則」節點呈現,不歸到任何 zone 組合
 *   - PR-5 尚未提供檢查結果時,順序條 checks 為 null(不顯示「無問題」)
 *   - 篩選(動作、zone、長期未命中 N 天)三張圖共用
 *
 *   const v = usePaPolicyViz(() => p.allRules, () => p.allDefaults, () => checksByPosition /* PR-5,可省略 *\/);
 *   v.filters.action / zone / unusedDays;v.matrix、v.order、v.sankey
 *   v.select({ kind: 'cell', from, to }) / v.select({ kind: 'link', source, target }) / v.select(null) → v.highlighted(順序條要標出的 position)
 */
import { computed, reactive, ref, type Ref } from 'vue';
import type { DefaultRuleHits, PolicyRule } from '@/api/paPolicy';

export type Tone = 'allow' | 'deny' | 'mixed';
/** 允許以外(deny、drop、reset-*)都算擋 */
export const toneOf = (action: string): 'allow' | 'deny' => (action === 'allow' ? 'allow' : 'deny');

export interface MatrixCell {
  from: string;
  to: string;
  /** 規則出現次數(多 zone 規則在多格各算一次) */
  count: number;
  allow: number;
  deny: number;
  tone: Tone;
  /** tooltip 用的規則編號(依順序) */
  positions: number[];
}
export interface ZoneMatrix {
  /** 列(來源 zone);any 固定放最後 */
  rows: string[];
  /** 欄(目的 zone);any 固定放最後 */
  cols: string[];
  cells: MatrixCell[];
  /** 最大 count(色階) */
  max: number;
}

/** PR-5 排序檢查在順序條上的標記(PR-5 提供;key 為規則 position) */
export interface OrderCheckMark {
  /** 檢查項目代碼(shadowed / conflict / broad-early / redundant / unused / disabled / no-profile / no-log-end / undeterminable) */
  code: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  /** 相關規則編號 */
  related: number[];
}

export interface OrderRow {
  /** 規則編號;預設規則為 null */
  position: number | null;
  name: string;
  action: string;
  tone: 'allow' | 'deny';
  disabled: boolean;
  isDefault: boolean;
  /** null = 沒有命中數資料 */
  hitCount: number | null;
  /** log10(hitCount + 1),長條長度;0 次 / 沒資料為 0 */
  logHits: number;
  /** 命中 0 次(畫面用記號) */
  zeroHits: boolean;
  lastHit: string | null;
  /** PR-5 檢查標記;沒有檢查結果時為 null(不是「無問題」) */
  checks: OrderCheckMark[] | null;
}

export interface VizSankeyNode {
  /** z:來源 zone、a:動作、d:目的 zone、p:預設規則 */
  id: string;
  name: string;
  layer: 0 | 1 | 2;
}
export interface VizSankeyLink {
  source: string;
  target: string;
  /** 命中數(多 zone 規則平均分攤) */
  value: number;
  /** 有分攤(估算值) */
  estimated: boolean;
  positions: number[];
}

export interface VizFilter {
  /** allow / deny(deny 含 drop、reset-*) */
  action?: 'allow' | 'deny' | null;
  zone?: string | null;
  unusedDays?: number | null;
}

export type VizSelection = { kind: 'cell'; from: string; to: string } | { kind: 'link'; source: string; target: string } | null;

const zonesOf = (zs: string[]) => (zs.length ? zs : ['any']);
const zoneOrder = (set: Set<string>) => [...set].filter((z) => z !== 'any').sort((a, b) => a.localeCompare(b)).concat(set.has('any') ? ['any'] : []);

/** 長期未命中(同後端 isUnused):沒有命中數資料不算(無法判定) */
export function isUnused(hitCount: number | null, lastHit: string | null, days: number, now: number): boolean {
  if (hitCount === null) return false;
  if (hitCount === 0) return true;
  const t = lastHit ? Date.parse(lastHit) : NaN;
  return !Number.isNaN(t) && now - t > days * 86400_000;
}

export function filterForViz(rules: PolicyRule[], f: VizFilter, now = Date.now()): PolicyRule[] {
  const zone = f.zone?.trim().toLowerCase();
  return rules.filter((r) => {
    if (f.action && toneOf(r.action) !== f.action) return false;
    // 同清單 API:規則 zone 為 any 也符合任何 zone
    if (zone && ![...zonesOf(r.fromZones), ...zonesOf(r.toZones)].some((z) => z.toLowerCase() === zone || z === 'any')) return false;
    if (f.unusedDays && !isUnused(r.hits?.hitCount ?? null, r.hits?.lastHit ?? null, f.unusedDays, now)) return false;
    return true;
  });
}

export function buildMatrix(rules: PolicyRule[]): ZoneMatrix {
  const map = new Map<string, MatrixCell>();
  const rows = new Set<string>();
  const cols = new Set<string>();
  for (const r of rules) {
    if (r.disabled) continue;
    const t = toneOf(r.action);
    for (const from of new Set(zonesOf(r.fromZones)))
      for (const to of new Set(zonesOf(r.toZones))) {
        rows.add(from);
        cols.add(to);
        const k = `${from}\u0000${to}`;
        let c = map.get(k);
        if (!c) map.set(k, (c = { from, to, count: 0, allow: 0, deny: 0, tone: t, positions: [] }));
        c.count++;
        c[t]++;
        c.positions.push(r.position);
        c.tone = c.allow && c.deny ? 'mixed' : c.allow ? 'allow' : 'deny';
      }
  }
  const cells = [...map.values()];
  return { rows: zoneOrder(rows), cols: zoneOrder(cols), cells, max: cells.reduce((m, c) => Math.max(m, c.count), 0) };
}

export function buildOrder(rules: PolicyRule[], defaults: DefaultRuleHits[], checks?: Map<number, OrderCheckMark[]> | null): OrderRow[] {
  const row = (x: { position: number | null; name: string; action: string; disabled: boolean; isDefault: boolean; hitCount: number | null; lastHit: string | null }): OrderRow => ({
    ...x,
    tone: toneOf(x.action),
    logHits: x.hitCount && x.hitCount > 0 ? Math.log10(x.hitCount + 1) : 0,
    zeroHits: x.hitCount === 0,
    checks: checks && x.position !== null ? (checks.get(x.position) ?? []) : null,
  });
  return [
    ...rules
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((r) => row({ position: r.position, name: r.name, action: r.action, disabled: r.disabled, isDefault: false, hitCount: r.hits?.hitCount ?? null, lastHit: r.hits?.lastHit ?? null })),
    // PA 的預設:intrazone-default 允許、interzone-default 拒絕(可在 PA 改寫,快照沒有內容;畫面標「預設規則」)
    ...defaults.map((d) => row({ position: null, name: d.name, action: d.name === 'intrazone-default' ? 'allow' : 'deny', disabled: false, isDefault: true, hitCount: d.hitCount, lastHit: d.lastHit })),
  ];
}

export const DEFAULT_NODE = 'p:預設規則';

export function buildSankey(rules: PolicyRule[], defaults: DefaultRuleHits[]): { nodes: VizSankeyNode[]; links: VizSankeyLink[] } {
  const nodes = new Map<string, VizSankeyNode>();
  const links = new Map<string, VizSankeyLink>();
  const node = (id: string, name: string, layer: 0 | 1 | 2) => nodes.has(id) || nodes.set(id, { id, name, layer });
  const add = (source: string, target: string, value: number, estimated: boolean, position: number | null) => {
    const k = `${source}>${target}`;
    let l = links.get(k);
    if (!l) links.set(k, (l = { source, target, value: 0, estimated: false, positions: [] }));
    l.value += value;
    l.estimated ||= estimated;
    if (position !== null && !l.positions.includes(position)) l.positions.push(position);
  };
  for (const r of rules) {
    if (r.disabled) continue;
    const hits = r.hits?.hitCount ?? 0;
    const from = [...new Set(zonesOf(r.fromZones))];
    const to = [...new Set(zonesOf(r.toZones))];
    const share = hits / (from.length * to.length);
    const est = from.length * to.length > 1;
    const a = `a:${toneOf(r.action)}`;
    node(a, toneOf(r.action) === 'allow' ? '允許' : '拒絕', 1);
    for (const f of from)
      for (const t of to) {
        node(`z:${f}`, f, 0);
        node(`d:${t}`, t, 2);
        add(`z:${f}`, a, share, est, r.position);
        add(a, `d:${t}`, share, est, r.position);
      }
  }
  for (const d of defaults) {
    if (!d.hitCount) continue;
    const tone = d.name === 'intrazone-default' ? 'allow' : 'deny';
    node(DEFAULT_NODE, '預設規則', 0);
    node(`a:${tone}`, tone === 'allow' ? '允許' : '拒絕', 1);
    add(DEFAULT_NODE, `a:${tone}`, d.hitCount, false, null);
  }
  // 沒有命中的連線不畫(Sankey 寬度 0 沒有意義)
  return { nodes: [...nodes.values()], links: [...links.values()].filter((l) => l.value > 0) };
}

/** 選取 → 要在順序條標出的規則編號 */
export function highlightOf(sel: VizSelection, matrix: ZoneMatrix, sankey: { links: VizSankeyLink[] }): Set<number> | null {
  if (!sel) return null;
  // 選取的格子 / 連線被篩選掉時當成沒有選取(不把整條順序條變成全部不標)
  if (sel.kind === 'cell') {
    const c = matrix.cells.find((x) => x.from === sel.from && x.to === sel.to);
    return c ? new Set(c.positions) : null;
  }
  const l = sankey.links.find((x) => x.source === sel.source && x.target === sel.target);
  return l ? new Set(l.positions) : null;
}

export function usePaPolicyViz(rules: () => PolicyRule[], defaults: () => DefaultRuleHits[], checks?: () => Map<number, OrderCheckMark[]> | null, now: () => number = Date.now) {
  const filters = reactive<VizFilter>({ action: null, zone: null, unusedDays: null });
  const selection: Ref<VizSelection> = ref(null);
  const filtered = computed(() => filterForViz(rules(), filters, now()));
  // 預設規則只看動作與未命中篩選(沒有 zone)
  const filteredDefaults = computed(() =>
    filters.zone
      ? []
      : defaults().filter(
          (d) =>
            (!filters.action || (d.name === 'intrazone-default' ? 'allow' : 'deny') === filters.action) &&
            (!filters.unusedDays || isUnused(d.hitCount, d.lastHit, filters.unusedDays, now())),
        ),
  );
  const matrix = computed(() => buildMatrix(filtered.value));
  const order = computed(() => buildOrder(filtered.value, filteredDefaults.value, checks?.() ?? null));
  const sankey = computed(() => buildSankey(filtered.value, filteredDefaults.value));
  const highlighted = computed(() => highlightOf(selection.value, matrix.value, sankey.value));
  /** 所有圖出現過的 zone(篩選下拉用) */
  const zones = computed(() => zoneOrder(new Set(rules().flatMap((r) => [...zonesOf(r.fromZones), ...zonesOf(r.toZones)]))));
  return reactive({
    filters,
    selection,
    matrix,
    order,
    sankey,
    highlighted,
    zones,
    ruleCount: computed(() => filtered.value.length),
    select: (s: VizSelection) => {
      selection.value = s;
    },
  });
}
