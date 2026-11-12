<script setup lang="ts">
/**
 * 世界地圖與國家 Top N 威脅排行(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2):
 *   - 左側:ECharts map: 'world'(Natural Earth 1:110m 內建 GeoJSON,資料 name 用 ISO2)
 *   - 右側:前 top 名(預設 10)國家清單(含嚴重 / 高風險數;未知國家顯示但不帶篩選條件)
 *   - 點擊地圖或排行項目皆 emit('pick', { chart: 'country', name: iso2, value: count, data: countryCount })
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtNum } from '@/api/format';
import type { CountryCount } from '@/api/insight';
import GEChart from './GEChart.vue';
import type { ChartPick, GWorldMapProps } from './viz-types';

const props = withDefaults(defineProps<GWorldMapProps>(), { top: 10 });
const emit = defineEmits<{ (e: 'pick', p: ChartPick): void }>();

const themeTick = ref(0);
let mo: MutationObserver | null = null;

onMounted(() => {
  if (typeof document !== 'undefined') {
    mo = new MutationObserver(() => {
      themeTick.value++;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style'] });
  }
});

onBeforeUnmount(() => mo?.disconnect());

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function token(name: string, fallback: string): string {
  void themeTick.value;
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const topList = computed(() => props.countries.slice(0, props.top));
const maxCount = computed(() => Math.max(1, ...props.countries.map((c) => c.count)));
const byIso2 = computed(() => new Map(props.countries.filter((c) => c.iso2).map((c) => [c.iso2!, c])));

const option = computed<Record<string, unknown>>(() => {
  const c1 = token('--heat-threat-1', '#2574d9');
  const c2 = token('--heat-threat-2', '#b86e00');
  const c3 = token('--heat-threat-3', '#c93328');
  const c4 = token('--heat-threat-4', '#7f1111');
  const emptyColor = token('--heat-empty', 'rgba(11,34,51,0.1)');
  const borderColor = token('--bg', '#ffffff');

  const mapData = props.countries
    .filter((c) => c.iso2)
    .map((c) => ({
      name: c.iso2!,
      value: c.count,
      country: c.country,
      iso2: c.iso2,
      critical: c.critical,
      high: c.high,
    }));

  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const item = p as { name?: string; data?: CountryCount };
        const c = item.data ?? byIso2.value.get(item.name ?? '');
        if (!c) return `<div><strong>${esc(item.name)}</strong><br/>威脅數：0</div>`;
        return [
          `<div><strong>${esc(c.country)} (${esc(c.iso2)})</strong></div>`,
          `<div>總威脅數：<strong>${esc(fmtNum(c.count))}</strong></div>`,
          `<div>嚴重：<strong>${esc(fmtNum(c.critical))}</strong> · 高風險：<strong>${esc(fmtNum(c.high))}</strong></div>`,
        ].join('');
      },
    },
    visualMap: {
      min: 0,
      max: maxCount.value,
      left: 12,
      bottom: 12,
      orient: 'horizontal',
      itemWidth: 12,
      itemHeight: 80,
      text: ['高', '低'],
      inRange: {
        color: [c1, c2, c3, c4],
      },
    },
    series: [
      {
        name: '來源國家威脅',
        type: 'map',
        map: 'world',
        roam: true,
        scaleLimit: { min: 1, max: 6 },
        itemStyle: {
          areaColor: emptyColor,
          borderColor,
          borderWidth: 0.6,
        },
        emphasis: {
          label: { show: false },
          itemStyle: { areaColor: c3 },
        },
        data: mapData,
      },
    ],
  };
});

function onMapPick(p: ChartPick) {
  const c = (p.data as CountryCount | undefined) ?? byIso2.value.get(p.name);
  if (!c) return;
  emit('pick', {
    chart: 'country',
    name: c.iso2 ?? '',
    value: c.count,
    data: c,
  });
}

function onRowClick(c: CountryCount) {
  emit('pick', {
    chart: 'country',
    name: c.iso2 ?? '',
    value: c.count,
    data: c,
  });
}
</script>

<template>
  <div class="g-world-map">
    <div class="g-world-map__canvas">
      <GEChart chart="country" height="320px" :option="option" ariaLabel="全球威脅來源國家分布地圖" @pick="onMapPick" />
    </div>
    <div class="g-world-map__list" role="list" :aria-label="`前 ${top} 名威脅國家排行`">
      <button
        v-for="(c, idx) in topList"
        :key="c.iso2 ?? c.country"
        type="button"
        role="listitem"
        class="g-world-map__row"
        :class="{ 'is-unknown': !c.iso2 }"
        :disabled="!c.iso2"
        :title="c.iso2 ? `點擊查看 ${c.country} 時段明細` : '未知國家無明細篩選條件'"
        @click="onRowClick(c)"
      >
        <span class="g-world-map__rank num">{{ idx + 1 }}</span>
        <div class="g-world-map__main">
          <div class="g-world-map__meta">
            <span class="g-world-map__name">{{ c.country }}</span>
            <span v-if="c.iso2" class="g-world-map__iso mono">{{ c.iso2 }}</span>
            <span class="spacer" />
            <span v-if="c.critical > 0" class="g-world-map__tag is-crit">嚴重 {{ fmtNum(c.critical) }}</span>
            <span v-if="c.high > 0" class="g-world-map__tag is-high">高 {{ fmtNum(c.high) }}</span>
            <strong class="g-world-map__cnt num">{{ fmtNum(c.count) }}</strong>
          </div>
          <div class="g-world-map__bar-bg">
            <span class="g-world-map__bar" :style="{ width: `${Math.max(4, (c.count / maxCount) * 100)}%` }" />
          </div>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.g-world-map {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 960px) {
  .g-world-map {
    grid-template-columns: minmax(0, 1fr);
  }
}
.g-world-map__canvas {
  min-width: 0;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  overflow: hidden;
}
.g-world-map__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  padding-right: 4px;
}
.g-world-map__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  background: var(--glass-soft);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.g-world-map__row:hover:not(:disabled) {
  background: var(--glass-hover);
  border-color: var(--field-focus);
}
.g-world-map__row.is-unknown {
  cursor: default;
  opacity: 0.72;
}
.g-world-map__rank {
  width: 22px;
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--text-3);
  text-align: center;
}
.g-world-map__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.g-world-map__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
}
.g-world-map__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.g-world-map__iso {
  font-size: 11px;
  color: var(--text-3);
}
.g-world-map__tag {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
}
.g-world-map__tag.is-crit {
  color: color-mix(in srgb, var(--c-danger) 75%, var(--text));
  background: color-mix(in srgb, var(--c-danger) 15%, transparent);
}
.g-world-map__tag.is-high {
  color: color-mix(in srgb, var(--c-warning) 70%, var(--text));
  background: color-mix(in srgb, var(--c-warning) 15%, transparent);
}
.g-world-map__cnt {
  font-weight: 750;
}
.g-world-map__bar-bg {
  height: 5px;
  border-radius: 99px;
  background: var(--line);
  overflow: hidden;
}
.g-world-map__bar {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--c-warning), var(--c-danger));
}
</style>
