<script setup lang="ts">
/**
 * 來源區域 → App → 目的區域桑基圖(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2、§5):
 *   - 節點以 id(z:/a:/d:)對應連線,標籤顯示 name(經 escapeHtml)
 *   - 點擊節點或連線皆 emit('pick', ChartPick),由 GEChart 正規化為節點 id 或「source>target」
 *   - 載入時 1.2s 流光 + 每 6s 輕微流光(背景分頁暫停,reduced-motion 關閉)
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtSize } from '@/api/format';
import { useReducedMotion } from '@/composables/useReducedMotion';
import GEChart from './GEChart.vue';
import type { ChartPick, GSankeyProps } from './viz-types';

const props = defineProps<GSankeyProps>();
const emit = defineEmits<{ (e: 'pick', p: ChartPick): void }>();

const { reduced } = useReducedMotion();
const pageHidden = ref(typeof document !== 'undefined' ? document.hidden : false);

function onVis() {
  pageHidden.value = document.hidden;
}

onMounted(() => {
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
});

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
});

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const nodeLabelMap = computed(() => new Map(props.nodes.map((n) => [n.id, n.name])));

/**
 * U9: 計算各節點流量並決定每一層(layer)只顯示前 Top N(且佔比達門檻)的標籤,
 * 避免小節點高度過窄時文字互相重疊;完整名稱與流量仍於 hover / tooltip 顯示。
 */
const visibleLabelIds = computed(() => {
  const inBytes = new Map<string, number>();
  const outBytes = new Map<string, number>();
  for (const l of props.links) {
    outBytes.set(l.source, (outBytes.get(l.source) ?? 0) + l.bytes);
    inBytes.set(l.target, (inBytes.get(l.target) ?? 0) + l.bytes);
  }
  const byLayer = new Map<number, { id: string; bytes: number }[]>();
  for (const n of props.nodes) {
    const b = Math.max(inBytes.get(n.id) ?? 0, outBytes.get(n.id) ?? 0);
    const list = byLayer.get(n.layer) ?? [];
    list.push({ id: n.id, bytes: b });
    byLayer.set(n.layer, list);
  }
  const keep = new Set<string>();
  const TOP_N_PER_LAYER = 5;
  const MIN_SHARE = 0.04;
  for (const [, list] of byLayer) {
    list.sort((a, b) => b.bytes - a.bytes);
    const total = list.reduce((sum, x) => sum + x.bytes, 0) || 1;
    list.slice(0, TOP_N_PER_LAYER).forEach((item, idx) => {
      if (idx === 0 || item.bytes / total >= MIN_SHARE) {
        keep.add(item.id);
      }
    });
  }
  return keep;
});

const option = computed<Record<string, unknown>>(() => {
  const map = nodeLabelMap.value;
  const keepLabels = visibleLabelIds.value;
  return {
    animationDuration: 1200,
    animationEasing: 'cubicOut',
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const item = p as { dataType?: string; name?: string; value?: number; data?: { id?: string; displayName?: string; source?: string; target?: string; value?: number } };
        if (item.dataType === 'edge' && item.data?.source && item.data?.target) {
          const sName = esc(map.get(item.data.source) ?? item.data.source);
          const tName = esc(map.get(item.data.target) ?? item.data.target);
          return `<div><strong>${sName} → ${tName}</strong><br/>流量：${esc(fmtSize(item.data.value ?? item.value ?? 0))}</div>`;
        }
        const label = esc(item.data?.displayName ?? map.get(item.name ?? '') ?? item.name ?? '');
        return `<div><strong>${label}</strong><br/>流量：${esc(fmtSize(item.value ?? 0))}</div>`;
      },
    },
    series: [
      {
        type: 'sankey',
        left: 16,
        right: 112,
        top: 16,
        bottom: 16,
        nodeWidth: 18,
        nodeGap: 10,
        emphasis: {
          focus: 'adjacency',
          label: {
            show: true,
            formatter: (p: unknown) => {
              const d = (p as { data?: { displayName?: string } }).data;
              return d?.displayName ?? '';
            },
          },
        },
        lineStyle: { color: 'gradient', curveness: 0.45, opacity: 0.36 },
        labelLayout: { hideOverlap: true },
        label: {
          formatter: (p: unknown) => {
            const d = (p as { data?: { id?: string; displayName?: string; showLabel?: boolean } }).data;
            if (!d || d.showLabel === false) return '';
            return d.displayName ?? '';
          },
        },
        data: props.nodes.map((n) => ({
          id: n.id,
          name: n.id,
          displayName: n.name,
          depth: n.layer,
          showLabel: keepLabels.has(n.id),
        })),
        links: props.links.map((l) => ({
          source: l.source,
          target: l.target,
          value: l.bytes,
        })),
      },
    ],
  };
});

function onPick(p: ChartPick) {
  emit('pick', { ...p, chart: 'sankey' });
}
</script>

<template>
  <div class="g-sankey">
    <GEChart chart="sankey" :option="option" ariaLabel="來源區域至應用程式至目的區域流量桑基圖" @pick="onPick" />
    <div v-if="!reduced" class="g-sankey__flow" :class="{ 'is-paused': pageHidden }" aria-hidden="true" />
  </div>
</template>

<style scoped>
.g-sankey {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-sm);
}
.g-sankey__flow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    105deg,
    transparent 35%,
    color-mix(in srgb, var(--c-cyan) 12%, transparent) 50%,
    transparent 65%
  );
  transform: translateX(-120%);
  animation: sankeyFlowSweep 6s ease-in-out infinite;
}
.g-sankey__flow.is-paused {
  animation-play-state: paused;
}
@keyframes sankeyFlowSweep {
  0% {
    transform: translateX(-120%);
  }
  20%,
  100% {
    transform: translateX(120%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .g-sankey__flow {
    display: none !important;
  }
}
</style>
