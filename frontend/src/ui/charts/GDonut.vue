<script setup lang="ts">
/** 環圈圖(組成比例,分類 ≤ 8):中央顯示總數,右側圖例含數值與百分比 */
import { computed, ref } from 'vue';
import { chartColor } from './palette';

const props = withDefaults(defineProps<{ items: { label: string; value: number; color?: string }[]; size?: number; centerLabel?: string }>(), {
  size: 150,
  centerLabel: '總計',
});
const total = computed(() => props.items.reduce((s, i) => s + i.value, 0));
const R = 42;
const C = 2 * Math.PI * R;
const active = ref<number | null>(null);
const arcs = computed(() => {
  let acc = 0;
  return props.items.map((it, i) => {
    const frac = total.value ? it.value / total.value : 0;
    // 各段之間留 1.5 單位間隙
    const len = Math.max(0, frac * C - (props.items.length > 1 ? 1.5 : 0));
    const arc = { len, offset: -acc * C, color: it.color ?? chartColor(i), pct: Math.round(frac * 100) };
    acc += frac;
    return arc;
  });
});
</script>

<template>
  <div class="g-donut">
    <svg :width="size" :height="size" viewBox="0 0 100 100" role="img" :aria-label="items.map((i) => `${i.label} ${i.value}`).join('、')">
      <circle cx="50" cy="50" :r="R" class="bg" />
      <circle
        v-for="(a, i) in arcs"
        :key="i"
        cx="50"
        cy="50"
        :r="R"
        class="arc"
        :class="{ dim: active !== null && active !== i }"
        :stroke="a.color"
        :stroke-dasharray="`${a.len} ${C - a.len}`"
        :stroke-dashoffset="a.offset"
        @mouseenter="active = i"
        @mouseleave="active = null"
      />
      <text x="50" y="49" text-anchor="middle" class="big">{{ active !== null ? items[active]!.value : total }}</text>
      <text x="50" y="62" text-anchor="middle" class="small">{{ active !== null ? items[active]!.label : centerLabel }}</text>
    </svg>
    <ul class="legend">
      <li v-for="(it, i) in items" :key="it.label" :class="{ dim: active !== null && active !== i }" @mouseenter="active = i" @mouseleave="active = null">
        <i :style="{ background: arcs[i]!.color }" />
        <span class="ellipsis">{{ it.label }}</span>
        <span class="spacer" />
        <b class="num">{{ it.value }}</b>
        <span class="faint num pct">{{ arcs[i]!.pct }}%</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.g-donut {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
svg {
  flex: none;
  transform: rotate(-90deg);
}
svg text {
  transform: rotate(90deg);
  transform-origin: 50px 50px;
}
.bg {
  fill: none;
  stroke: var(--line);
  stroke-width: 11;
}
.arc {
  fill: none;
  stroke-width: 11;
  stroke-linecap: butt;
  transition:
    opacity var(--dur),
    stroke-width var(--dur);
  cursor: pointer;
}
.arc:hover {
  stroke-width: 13;
}
.dim {
  opacity: 0.35;
}
.big {
  font-size: 17px;
  font-weight: 750;
  fill: var(--text);
}
.small {
  font-size: 7.5px;
  fill: var(--text-3);
}
.legend {
  flex: 1;
  min-width: 150px;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-sm);
}
.legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  transition: opacity var(--dur);
}
.legend i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: none;
}
.pct {
  width: 36px;
  text-align: right;
}
</style>
