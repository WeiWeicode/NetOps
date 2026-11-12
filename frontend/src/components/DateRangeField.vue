<script setup lang="ts">
/**
 * 日期區間欄位(單一欄位選起訖;流量總覽、安全事件、Log 明細共用)。
 *   點欄位打開面板:快捷選項 + 開始 / 結束輸入,按「套用」才更新 v-model(輸入過程不觸發查詢)。
 *   邏輯在 composables/dateRange.ts;樣式用主題 token(深淺主題),窄螢幕面板佔滿寬度;
 *   動畫依全域 prefers-reduced-motion 規則關閉(ui/styles/base.css)。
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
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
/** 打開面板時更新「現在」(頁面開著跨午夜時,快捷選項不會停在舊的一天) */
const now = ref(new Date());
const presets = computed(() => rangePresets(now.value, props.mode, props.maxDays, props.coverage));
const draftError = computed(() => rangeError(draft.value, props.maxDays));
const text = computed(() => rangeLabel({ from: from.value, to: to.value }, props.mode) || '請選擇期間');
// 只設最早可選的日期:「今天」可能還沒進 coverage(資料晚到),不設上限
const minMax = computed(() => (props.mode === 'date' && props.coverage ? { min: props.coverage.from } : {}));
const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

function toggle() {
  if (props.disabled) return;
  if (open.value) return close();
  draft.value = { from: from.value, to: to.value };
  now.value = new Date();
  place();
  open.value = true;
  // 鍵盤使用者:打開後焦點移到面板第一個可操作的元素(程式碼審查 #1)
  void nextTick(() => panel.value?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
}
/** 關閉;焦點原本在面板內時回到欄位按鈕 */
function close() {
  const inPanel = !!panel.value && panel.value.contains(document.activeElement);
  open.value = false;
  if (inPanel) void nextTick(() => control.value?.focus());
}
function apply(r: DateRange = draft.value) {
  if (rangeError(r, props.maxDays)) return;
  from.value = r.from;
  to.value = r.to;
  close();
}
/** 面板內 Tab 循環(對話框不讓焦點跑到頁面後面);Esc 關閉 */
function onPanelKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    return close();
  }
  if (e.key !== 'Tab' || !panel.value) return;
  const list = [...panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = list[0];
  const last = list.at(-1);
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first?.focus();
  }
}
function onDoc(e: Event) {
  const t = e.target as Node;
  if (open.value && !root.value?.contains(t) && !panel.value?.contains(t)) open.value = false;
}
/** 捲動或改變視窗大小:重新定位 */
const onMove = (e?: Event) => {
  // 面板自己捲動不用重新定位
  if (open.value && !(e?.target instanceof Node && panel.value?.contains(e.target))) place();
};
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
  <div ref="root" class="drf" :class="{ invalid: !!error, disabled }" @keydown.esc="close">
    <span class="lbl" :id="`${id}-l`">{{ label }}</span>
    <button
      ref="control"
      type="button"
      class="control"
      :aria-labelledby="`${id}-l ${id}-v`"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="open ? `${id}-p` : undefined"
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
      <div v-if="open" :id="`${id}-p`" ref="panel" class="drf-panel" :style="pos" role="dialog" :aria-label="`選擇${label}`" @keydown="onPanelKey">
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
          <GButton size="sm" @click="close">取消</GButton>
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
  max-height: calc(100dvh - 32px);
  overflow: auto;
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
