<script setup>
import { computed } from 'vue'
import { fmtBytes, fmtNum } from '../utils/format.js'

/**
 * 排行清單：橫條長度 = 次數（或流量），點一列帶條件到明細查詢
 * items: [{ key, n, bytes, sub? }]；byBytes: 依流量排序（父層傳 topBytes 的資料）；sub：顯示在名稱後面的補充（例如這個 IP 用了哪些 App）
 */
const props = defineProps({
  title: { type: String, required: true },
  items: { type: Array, default: () => [] },
  byBytes: { type: Boolean, default: false },
  showBytes: { type: Boolean, default: false },
  tone: { type: String, default: 'brand' }, // brand / danger / warn
  hint: { type: String, default: '' },
})
const emit = defineEmits(['pick'])

const max = computed(() => Math.max(1, ...props.items.map((x) => (props.byBytes ? x.bytes : x.n))))
const color = computed(() => ({ danger: 'var(--color-danger)', warn: 'var(--color-warn)' })[props.tone] ?? 'var(--color-brand-500)')
</script>

<template>
  <div class="glass rounded-2xl p-4 flex flex-col min-w-0">
    <h2 class="section-title !mb-2 flex justify-between gap-2">
      <span class="truncate">{{ title }}</span>
      <slot name="extra" />
    </h2>
    <p v-if="hint" class="m-0 mb-2 text-xs text-dim">{{ hint }}</p>
    <p v-if="!items.length" class="m-0 py-6 text-center text-sm text-dim">沒有資料</p>
    <ol v-else class="top-list">
      <li v-for="(x, i) in items" :key="x.key" role="button" tabindex="0" :title="`${x.key}：${fmtNum(x.n)} 次${x.bytes ? `，${fmtBytes(x.bytes)}` : ''}（點選查看明細）`"
        @click="emit('pick', x.key)" @keydown.enter="emit('pick', x.key)">
        <span class="rank">{{ i + 1 }}</span>
        <span class="label">
          <span class="bar" :style="{ width: `${((byBytes ? x.bytes : x.n) / max) * 100}%`, background: color }" />
          <span class="text">{{ x.key }}<small v-if="x.sub" class="sub-text">{{ x.sub }}</small></span>
        </span>
        <span class="value">{{ byBytes ? fmtBytes(x.bytes) : fmtNum(x.n) }}</span>
        <span v-if="showBytes && !byBytes" class="value sub">{{ fmtBytes(x.bytes) }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.top-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: calc(0.875rem * var(--font-scale));
  font-variant-numeric: tabular-nums;
}
.top-list li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
}
.top-list li:hover,
.top-list li:focus-visible {
  background: var(--color-brand-50);
}
.rank {
  width: 1.5em;
  text-align: right;
  color: var(--color-dim);
  font-size: 0.85em;
  flex-shrink: 0;
}
.label {
  position: relative;
  flex: 1;
  min-width: 0;
  padding: 1px 6px;
}
.bar {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
  opacity: 0.18;
}
.text {
  position: relative;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-ink);
}
.sub-text {
  margin-left: 6px;
  color: var(--color-dim);
  font-size: 0.85em;
}
.value {
  flex-shrink: 0;
  min-width: 4.5em;
  text-align: right;
  color: var(--color-ink);
}
.value.sub {
  color: var(--color-dim);
  min-width: 5em;
}
</style>
