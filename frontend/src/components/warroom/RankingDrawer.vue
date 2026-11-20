<script setup lang="ts">
/**
 * 戰情室「即時排行」收摺抽屜(需求方 2026-11-17 決定加回舊即時監控頁的排行卡):
 *   - 類型下拉、5 / 15 / 60 分鐘切換;資料與狀態全部來自 useLiveTop()(頁面傳入),本元件不自行查詢
 *   - 接收端點停止時標示「停止更新」,沒有來源時不寫成「這段期間沒有資料」
 */
import { computed } from 'vue';
import { describeError } from '@/api/gateway';
import { fmtNum, fmtSize } from '@/api/format';
import { LOG_TYPES, type LogType, type PaLiveTop } from '@/api/paLive';
import { BAD_VALUE, TOP_MINUTES, type TopListView, type TopMinutes } from '@/composables/useLiveTop';
import TopList from '@/components/TopList.vue';
import GDrawer from '@/ui/components/GDrawer.vue';

const props = defineProps<{
  modelValue: boolean;
  type: LogType;
  minutes: TopMinutes;
  top: PaLiveTop | null;
  lists: readonly TopListView[];
  kpis: readonly { key: string; title: string; items: [string, number][] }[];
  error: Error | null;
  loading: boolean;
  /** logSource(collector):接收端點是否在線與說明文字 */
  source: { live: boolean; empty: string; stale: string };
  /** TS-4:威脅名稱是否可點開特徵碼說明抽屜 */
  sigLinkable?: (nameOrId: string) => boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'update:type', v: LogType): void;
  (e: 'update:minutes', v: TopMinutes): void;
  (e: 'open-signature', name: string): void;
}>();

const typeOptions = LOG_TYPES.map((t) => ({ label: t.label, value: t.value }));
const minuteOptions = TOP_MINUTES.map((m) => ({ label: `${m} 分鐘`, value: String(m) }));
const minutesStr = computed({
  get: () => String(props.minutes),
  set: (v: string) => emit('update:minutes', Number(v) as TopMinutes),
});
const typeModel = computed({
  get: () => props.type,
  set: (v: LogType) => emit('update:type', v),
});
</script>

<template>
  <GDrawer :model-value="modelValue" title="即時排行" @update:model-value="emit('update:modelValue', $event)">
    <div class="stack" style="--gap: 12px">
      <div class="rk-row">
        <GSelect v-model="typeModel" :options="typeOptions" size="sm" aria-label="排行類型" />
        <GSegmented v-model="minutesStr" size="sm" :options="minuteOptions" />
      </div>

      <GAlert v-if="error" tone="danger">{{ describeError(error) }}</GAlert>
      <GSkeleton v-else-if="!top && loading" :lines="4" />
      <template v-else-if="top">
        <GAlert v-if="!source.live && lists.length" tone="warning">{{ source.stale }}</GAlert>
        <p class="small muted">
          最近 {{ top.minutes }} 分鐘：{{ fmtNum(top.totals.count ?? 0) }} 筆<template v-if="top.totals.bytes">、{{ fmtSize(top.totals.bytes) }}</template>
          <template v-if="top.type !== 'traffic'">（已乘上重複次數）</template>；每分鐘只保留前 200 名，排行為近似值。
        </p>
        <div v-if="kpis.length" class="rk-grid">
          <div v-for="k in kpis" :key="k.key" class="rk-kpi">
            <strong class="small">{{ k.title }}</strong>
            <ul>
              <li v-for="[key, n] in k.items" :key="key">
                <span class="ellipsis" :class="BAD_VALUE.test(key) ? 'c-danger strong' : ''">{{ key }}</span><span class="num muted">{{ fmtNum(n) }}</span>
              </li>
            </ul>
          </div>
        </div>
        <div v-if="lists.length" class="rk-grid">
          <TopList
            v-for="t in lists"
            :key="t.dim"
            :title="t.title"
            :items="t.items"
            :by-bytes="t.byBytes"
            :show-bytes="t.byBytes"
            :pickable="top.type === 'threat' && t.dim === 'name' ? (k) => Boolean(sigLinkable?.(k)) : () => false"
            :pick-hint="top.type === 'threat' && t.dim === 'name' ? '檢視威脅特徵碼說明' : undefined"
            @pick="(k) => top?.type === 'threat' && t.dim === 'name' && emit('open-signature', k)"
          />
        </div>
        <GEmpty v-else icon="activity" :title="source.live ? '這段期間沒有資料' : '沒有 log 來源'" :description="source.empty" />
      </template>
    </div>
  </GDrawer>
</template>

<style scoped>
.rk-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.rk-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}
.rk-kpi ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}
.rk-kpi li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
</style>
