<script setup lang="ts">
/**
 * 日期區間欄位(單一欄位選起訖;流量總覽、安全事件、Log 明細共用)。
 *   點欄位打開面板:快捷選項 + 開始 / 結束輸入,按「套用」才更新 v-model(輸入過程不觸發查詢)。
 *   邏輯在 composables/dateRange.ts;樣式用主題 token(深淺主題),窄螢幕面板佔滿寬度;
 *   動畫依全域 prefers-reduced-motion 規則關閉(ui/styles/base.css)。
 */
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { coverageText, rangeError, rangeLabel, rangePresets, type DateRange, type RangeMode } from '@/composables/dateRange';

const props = withDefaults(
  defineProps<{
    label?: string;
    mode?: RangeMode;
    /** 最多幾天 */
    maxDays: number;
    /** ClickHouse 實際有資料的範圍(顯示在面板,並停用整個在範圍之前的快捷選項) */
    coverage?: DateRange | null;
    disabled?: boolean;
    error?: string;
  }>(),
  { label: '期間', mode: 'date' },
);
const from = defineModel<string>('from', { default: '' });
const to = defineModel<string>('to', { default: '' });

const id = useId();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const control = ref<HTMLElement | null>(null);
/** 面板放在 body(Teleport):卡片的 backdrop-filter 會形成新的堆疊,面板放在卡片裡會被後面的卡片蓋住 */
const pos = ref<Record<string, string>>({});
function place() {
  const r = control.value?.getBoundingClientRect();
  if (!r) return;
  const width = Math.min(420, window.innerWidth - 32);
  const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16));
  pos.value = { top: `${r.bottom + 6}px`, left: `${left}px`, width: `${width}px` };
}
const draft = ref<DateRange>({ from: '', to: '' });
const inputType = computed(() => (props.mode === 'date' ? 'date' : 'datetime-local'));
const presets = computed(() => rangePresets(new Date(), props.mode, props.maxDays, props.coverage));
const draftError = computed(() => rangeError(draft.value, props.maxDays));
const text = computed(() => rangeLabel({ from: from.value, to: to.value }, props.mode) || '請選擇期間');
const minMax = computed(() => (props.mode === 'date' && props.coverage ? { min: props.coverage.from, max: props.coverage.to } : {}));

function toggle() {
  if (props.disabled) return;
  if (!open.value) {
    draft.value = { from: from.value, to: to.value };
    place();
  }
  open.value = !open.value;
}
function apply(r: DateRange = draft.value) {
  if (rangeError(r, props.maxDays)) return;
  from.value = r.from;
  to.value = r.to;
  open.value = false;
}
function onDoc(e: Event) {
  const t = e.target as Node;
  if (open.value && !root.value?.contains(t) && !panel.value?.contains(t)) open.value = false;
}
/** 捲動或改變視窗大小:重新定位 */
const onMove = () => open.value && place();
watch(open, (v) => {
  const fn = v ? 'addEventListener' : 'removeEventListener';
  document[fn]('mousedown', onDoc);
  window[fn]('scroll', onMove, true);
  window[fn]('resize', onMove);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDoc);
  window.removeEventListener('scroll', onMove, true);
  window.removeEventListener('resize', onMove);
});
</script>

<template>
  <div ref="root" class="drf" :class="{ invalid: !!error, disabled }" @keydown.esc="open = false">
    <span class="lbl" :id="`${id}-l`">{{ label }}</span>
    <button
      ref="control"
      type="button"
      class="control"
      :aria-labelledby="`${id}-l ${id}-v`"
      :aria-expanded="open"
      :aria-controls="`${id}-p`"
      :disabled="disabled"
      @click="toggle"
    >
      <GIcon name="calendar" :size="17" class="lead" />
      <span :id="`${id}-v`" class="value">{{ text }}</span>
      <GIcon name="chevron-down" :size="15" class="caret" />
    </button>
    <span v-if="error" class="err">{{ error }}</span>

    <Teleport to="body">
    <Transition name="drf-pop">
      <div v-if="open" :id="`${id}-p`" ref="panel" class="drf-panel" :style="pos" role="dialog" :aria-label="`選擇${label}`" @keydown.esc="open = false">
        <div class="presets">
          <button v-for="p in presets" :key="p.key" type="button" class="chip" :disabled="p.disabled" :title="p.disabled ? '超過保留期限' : ''" @click="apply(p)">
            {{ p.label }}
          </button>
        </div>
        <div class="inputs">
          <label class="f">
            <span class="sub">開始</span>
            <input v-model="draft.from" :type="inputType" v-bind="minMax" />
          </label>
          <label class="f">
            <span class="sub">結束</span>
            <input v-model="draft.to" :type="inputType" v-bind="minMax" />
          </label>
        </div>
        <p class="small muted">{{ coverageText(coverage) }} · 最長 {{ maxDays }} 天</p>
        <p v-if="draftError && (draft.from || draft.to)" class="small c-danger">{{ draftError }}</p>
        <div class="actions">
          <GButton size="sm" @click="open = false">取消</GButton>
          <GButton size="sm" variant="primary" :disabled="!!draftError" @click="apply()">套用</GButton>
        </div>
      </div>
    </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.drf {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.lbl {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
}
.control {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--field-border);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 240px;
  transition:
    border-color var(--dur),
    box-shadow var(--dur);
}
.control:focus-visible,
.control[aria-expanded='true'] {
  outline: none;
  border-color: var(--c-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-primary) 22%, transparent);
}
.disabled .control {
  cursor: not-allowed;
  opacity: 0.6;
}
.invalid .control {
  border-color: var(--c-danger);
}
.value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.lead,
.caret {
  color: var(--text-3);
  flex: none;
}
.err {
  font-size: var(--fs-xs);
  color: var(--c-danger);
}
.drf-panel {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: var(--radius-md);
  background: var(--glass-strong);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(16px);
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--glass-soft);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur);
}
.chip:hover:not(:disabled) {
  background: color-mix(in srgb, var(--c-primary) 14%, transparent);
}
.chip:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.inputs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.sub {
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.f input {
  height: 36px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--field-border);
  background: var(--field);
  color: var(--text);
  font: inherit;
  min-width: 0;
  color-scheme: light dark;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.drf-pop-enter-active,
.drf-pop-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.drf-pop-enter-from,
.drf-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (max-width: 520px) {
  .control {
    min-width: 0;
    width: 100%;
  }
  .drf-panel {
    left: 16px !important;
    right: 16px;
    top: auto !important;
    bottom: 16px;
    width: auto !important;
  }
  .inputs {
    grid-template-columns: 1fr;
  }
}
</style>
