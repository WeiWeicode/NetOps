<script setup lang="ts">
/**
 * 左右對照橫向長條圖(V-b2;HANDOFF-GEMINI-VIZ §3.3、§4.2):
 *   - 左欄(left):發起威脅最多內網 IP → emit('pick', { chart: 'topInternalSrc', name: ip, ... })
 *   - 右欄(right):被攻擊最多伺服器 → right === null 時顯示 notes 說明(例如「伺服器網段尚未設定」),不畫假 0;
 *     有資料時 emit('pick', { chart: 'topServerDst', name: ip, ... })
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtNum } from '@/api/format';
import type { TopIp } from '@/api/insight';
import GEChart from './GEChart.vue';
import type { ChartPick, GTopCompareProps } from './viz-types';

const props = defineProps<GTopCompareProps>();
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

function buildOption(items: TopIp[], primaryVar: string): Record<string, unknown> {
  const list = [...items].slice(0, 10).reverse();
  const baseColor = token(primaryVar, '#0369a1');
  const highColor = token('--c-danger', '#e0483e');

  return {
    grid: { top: 28, right: 20, bottom: 22, left: 112, containLabel: false },
    legend: { top: 0, data: ['高風險以上', '其他威脅'] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const first = arr[0] as { dataIndex?: number } | undefined;
        const item = list[first?.dataIndex ?? 0];
        if (!item) return '';
        return [
          `<div><strong>${esc(item.ip)}</strong></div>`,
          `<div>總威脅數：<strong>${esc(fmtNum(item.count))}</strong></div>`,
          `<div>高風險以上：<strong>${esc(fmtNum(item.high))}</strong></div>`,
        ].join('');
      },
    },
    xAxis: { type: 'value' },
    yAxis: {
      type: 'category',
      data: list.map((x) => x.ip),
    },
    series: [
      {
        name: '高風險以上',
        type: 'bar',
        stack: 'ip',
        barMaxWidth: 16,
        itemStyle: { color: highColor },
        data: list.map((x) => ({ name: x.ip, value: x.high })),
      },
      {
        name: '其他威脅',
        type: 'bar',
        stack: 'ip',
        barMaxWidth: 16,
        itemStyle: { color: baseColor, borderRadius: [0, 4, 4, 0] },
        data: list.map((x) => ({ name: x.ip, value: Math.max(0, x.count - x.high) })),
      },
    ],
  };
}

const leftOption = computed(() => buildOption(props.left, '--c-warning'));
const rightOption = computed(() => (props.right ? buildOption(props.right, '--c-info') : {}));
</script>

<template>
  <div class="g-top-compare">
    <div class="g-top-compare__col">
      <h4 class="g-top-compare__title">{{ leftTitle }}</h4>
      <GEChart
        v-if="left.length"
        chart="topInternalSrc"
        height="260px"
        :option="leftOption"
        :ariaLabel="leftTitle"
        @pick="emit('pick', { ...$event, chart: 'topInternalSrc' })"
      />
      <GEmpty v-else compact title="此期間無內網來源威脅紀錄" />
    </div>

    <div class="g-top-compare__col">
      <h4 class="g-top-compare__title">{{ rightTitle }}</h4>
      <div v-if="right === null" class="g-top-compare__notes">
        <GAlert tone="info" title="尚未設定伺服器網段">
          <ul v-if="notes?.length" class="g-top-compare__note-list">
            <li v-for="n in notes" :key="n">{{ n }}</li>
          </ul>
          <span v-else>伺服器網段將於偵測設定（V-c）開放設定，設定完成前暫不提供此排行。</span>
        </GAlert>
      </div>
      <GEChart
        v-else-if="right.length"
        chart="topServerDst"
        height="260px"
        :option="rightOption"
        :ariaLabel="rightTitle"
        @pick="emit('pick', { ...$event, chart: 'topServerDst' })"
      />
      <GEmpty v-else compact title="此期間無伺服器遭受威脅紀錄" />
    </div>
  </div>
</template>

<style scoped>
.g-top-compare {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
@media (max-width: 860px) {
  .g-top-compare {
    grid-template-columns: minmax(0, 1fr);
  }
}
.g-top-compare__col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.g-top-compare__title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 700;
  color: var(--text);
}
.g-top-compare__notes {
  flex: 1;
  display: flex;
  align-items: center;
}
.g-top-compare__note-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
