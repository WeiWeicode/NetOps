<script setup lang="ts">
/**
 * 規則位址物件展開元件(清單表格與詳細抽屜共用):
 *   - 顯示物件名稱,可點擊展開成 expanded.values
 *   - unresolved 標「無法對應 IP」(FQDN、動態群組、地區等無法換成 IP,展開仍列出成員);kind 為 dynamic-group / region / unknown 時另標
 *   - 僅在 policy.canNames 為 true 時對展開值做 IP 對照(nameOf):
 *       ip → IP(姓名 / 部門 / 設備)
 *       range → 可展開列出 items(truncated 標註「只列前 50 筆,共 total 筆」)
 *       none → 只顯示 IP
 *       unresolvable → 標「無法對照」
 *       pending → 載入中
 */
import { reactive } from 'vue';
import type { IpNameLabel } from '@/api/ipNames';
import type { ExpandedAddress, PolicyRule } from '@/api/paPolicy';
import { ADDRESS_KIND_LABELS, type PaPolicyStore } from './types';

const props = withDefaults(
  defineProps<{
    items: ExpandedAddress[];
    rule: PolicyRule;
    policy: PaPolicyStore;
    /** 預設展開(抽屜內預設展開,表格內預設收合) */
    defaultExpanded?: boolean;
    /** 反向條件(negateSource / negateDestination) */
    negated?: boolean;
  }>(),
  { defaultExpanded: false, negated: false },
);

const expandedKeys = reactive(new Set<string>());
const expandedRanges = reactive(new Set<string>());

const isSpecialKind = (kind: ExpandedAddress['kind']) => kind === 'dynamic-group' || kind === 'region' || kind === 'unknown';
const canToggle = (a: ExpandedAddress) => a.values.length > 0 || a.unresolved || isSpecialKind(a.kind);

function isOpen(name: string): boolean {
  if (props.defaultExpanded) return !expandedKeys.has(`close:${name}`);
  return expandedKeys.has(name);
}

function toggle(a: ExpandedAddress) {
  if (!canToggle(a)) return;
  if (props.defaultExpanded) {
    const k = `close:${a.name}`;
    if (expandedKeys.has(k)) expandedKeys.delete(k);
    else expandedKeys.add(k);
  } else {
    if (expandedKeys.has(a.name)) {
      expandedKeys.delete(a.name);
    } else {
      expandedKeys.add(a.name);
      if (props.policy.canNames) void props.policy.resolveNames(props.rule);
    }
  }
}

function toggleRange(val: string) {
  if (expandedRanges.has(val)) expandedRanges.delete(val);
  else expandedRanges.add(val);
}

function formatLabel(l: IpNameLabel): string {
  return [l.name, l.department, l.device].filter(Boolean).join(' / ');
}
</script>

<template>
  <div class="obj-wrap">
    <GBadge v-if="negated" tone="warning" variant="soft" class="negate-badge">反向</GBadge>
    <div v-if="!items.length" class="muted xs">—</div>
    <div v-for="a in items" :key="a.name" class="obj-item">
      <div class="obj-head">
        <button
          v-if="canToggle(a)"
          type="button"
          class="obj-btn"
          :aria-expanded="isOpen(a.name)"
          @click.stop="toggle(a)"
        >
          <GIcon :name="isOpen(a.name) ? 'chevron-down' : 'chevron-right'" :size="13" />
          <span class="obj-name mono">{{ a.name }}</span>
        </button>
        <span v-else class="obj-name mono">{{ a.name }}</span>

        <GBadge v-if="isSpecialKind(a.kind)" tone="info" variant="outline" class="mini-badge">
          {{ ADDRESS_KIND_LABELS[a.kind] }}
        </GBadge>
        <GBadge v-if="a.unresolved" tone="warning" variant="soft" class="mini-badge">無法對應 IP</GBadge>
      </div>

      <div v-if="canToggle(a) && isOpen(a.name)" class="obj-values" @click.stop>
        <div v-if="!a.values.length" class="xs muted">無展開項目</div>
        <div v-for="val in a.values" :key="val" class="val-row">
          <template v-if="policy.canNames">
            <template v-for="nv in [policy.nameOf(val)]" :key="val">
              <div class="val-line">
                <span class="mono val-ip">{{ val }}</span>
                <span v-if="nv.status === 'ip'" class="ip-label">({{ formatLabel(nv.label) }})</span>
                <span v-else-if="nv.status === 'pending'" class="xs muted">載入中…</span>
                <GBadge v-else-if="nv.status === 'unresolvable'" tone="neutral" variant="outline" class="mini-badge">無法對照</GBadge>
                <button
                  v-else-if="nv.status === 'range'"
                  type="button"
                  class="range-toggle"
                  :aria-expanded="expandedRanges.has(val)"
                  @click="toggleRange(val)"
                >
                  <GIcon :name="expandedRanges.has(val) ? 'chevron-down' : 'chevron-right'" :size="12" />
                  對照 {{ nv.total }} 筆
                </button>
              </div>
              <div v-if="nv.status === 'range' && expandedRanges.has(val)" class="range-list">
                <p v-if="nv.truncated" class="xs c-warning range-trunc">只列前 50 筆,共 {{ nv.total }} 筆</p>
                <div v-for="item in nv.items" :key="`${item.ip}-${item.name}`" class="range-item xs">
                  <span class="mono">{{ item.ip }}</span>
                  <span class="muted">({{ formatLabel(item) || '—' }})</span>
                </div>
              </div>
            </template>
          </template>
          <div v-else class="val-line">
            <span class="mono val-ip">{{ val }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.obj-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.negate-badge {
  align-self: flex-start;
  margin-bottom: 2px;
}
.obj-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.obj-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.obj-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px 1px 2px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--glass-soft);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-xs);
  cursor: pointer;
  max-width: 100%;
  transition: background var(--dur), border-color var(--dur);
}
.obj-btn:hover {
  background: var(--glass-hover);
  border-color: var(--c-primary);
}
.obj-name {
  font-size: var(--fs-xs);
  word-break: break-all;
}
.mini-badge {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
}
.obj-values {
  margin-left: 12px;
  padding-left: 8px;
  border-left: 2px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.val-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.val-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  font-size: var(--fs-xs);
}
.val-ip {
  color: var(--text);
}
.ip-label {
  color: var(--c-primary-text);
  font-size: var(--fs-xs);
}
.range-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  height: 20px;
  border: 1px solid color-mix(in srgb, var(--c-primary) 35%, var(--line));
  border-radius: 99px;
  background: color-mix(in srgb, var(--c-primary) 8%, transparent);
  color: var(--c-primary-text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.range-toggle:hover {
  background: color-mix(in srgb, var(--c-primary) 16%, transparent);
}
.range-list {
  margin-left: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
}
.range-trunc {
  margin: 0 0 2px;
  color: var(--c-warning);
  font-weight: 600;
}
.range-item {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
