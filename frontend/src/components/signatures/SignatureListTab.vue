<script setup lang="ts">
/**
 * 防火牆 › 威脅特徵碼 — 分頁 1:特徵清單(TS-4)
 *   - 篩選:關鍵字(ID / 名稱 / CVE / 類別 / 廠商)、類型(弱點 / 間諜軟體)、嚴重度、新特徵範圍(7/30/90 天,預設 30)、只看新特徵、只看近 30 天有命中
 *   - TS-2 審查結論:
 *     - firstVersion 為 null 時顯示「未知」
 *     - 歷史不足時顯示「自 YYYY-MM-DD 起統計」(用 info.since)
 *     - 目前版本為 rebuilt 時標示「這一版差異無法計算」
 *   - 點選列或特徵名稱觸發 open-signature 開啟特徵碼抽屜
 */
import { computed } from 'vue';
import { fmtNum } from '@/api/format';
import { describeError } from '@/api/gateway';
import type { SignatureDays, SignatureKind, SignatureRow, SignatureSeverity } from '@/api/paSignature';
import type { Column } from '@/ui/components/GTable.vue';
import {
  formatFirstVersion,
  severityMeta,
  SIG_DAYS_OPTIONS,
  SIG_KIND_META,
  type PaSignatureStore,
} from './types';

const props = defineProps<{
  sig: PaSignatureStore;
}>();
const emit = defineEmits<{ (e: 'open-signature', id: string): void }>();

const KIND_OPTIONS = [
  { label: '弱點 (Vulnerability)', value: 'vulnerability' },
  { label: '間諜軟體 (Spyware)', value: 'spyware' },
];
const SEVERITY_OPTIONS = [
  { label: '嚴重 (critical)', value: 'critical' },
  { label: '高 (high)', value: 'high' },
  { label: '中 (medium)', value: 'medium' },
  { label: '低 (low)', value: 'low' },
  { label: '資訊 (informational)', value: 'informational' },
];

const daysModel = computed({
  get: () => String(props.sig.filters.days ?? 30),
  set: (v: string) => {
    const d = Number(v) as SignatureDays;
    props.sig.setDays(d);
    void props.sig.load(1);
  },
});

const kindModel = computed({
  get: () => props.sig.filters.kind ?? '',
  set: (v: string) => {
    props.sig.filters.kind = (v || undefined) as SignatureKind | undefined;
  },
});

const severityModel = computed({
  get: () => props.sig.filters.severity ?? '',
  set: (v: string) => {
    props.sig.filters.severity = (v || undefined) as SignatureSeverity | undefined;
  },
});

const isNewModel = computed({
  get: () => Boolean(props.sig.filters.isNew),
  set: (v: boolean) => {
    props.sig.filters.isNew = v ? true : undefined;
  },
});

const hasHitsModel = computed({
  get: () => Boolean(props.sig.filters.hasHits),
  set: (v: boolean) => {
    props.sig.filters.hasHits = v ? true : undefined;
  },
});

const hitsAvailable = computed(() => Boolean(props.sig.info?.hitsAvailable));

function onSearch() {
  void props.sig.load(1);
}

function onReset() {
  props.sig.filters.q = undefined;
  props.sig.filters.kind = undefined;
  props.sig.filters.severity = undefined;
  props.sig.filters.isNew = undefined;
  props.sig.filters.hasHits = undefined;
  props.sig.setDays(30);
  void props.sig.load(1);
}

function onPageChange(next: number) {
  void props.sig.load(next);
}

const COLUMNS: Column[] = [
  { key: 'id', label: 'ID', width: '92px', mono: true },
  { key: 'kind', label: '類型', width: '88px' },
  { key: 'severity', label: '嚴重度', width: '84px' },
  { key: 'name', label: '特徵名稱' },
  { key: 'cves', label: 'CVE', width: '170px', hideSm: true },
  { key: 'defaultAction', label: '預設動作', width: '116px', hideSm: true },
  { key: 'firstVersion', label: '首次出現版本', width: '124px', mono: true, hideSm: true },
  { key: 'hits30d', label: '近 30 天命中', width: '110px', align: 'right', mono: true },
];

const asRow = (r: unknown) => r as SignatureRow;
</script>

<template>
  <div class="sig-list-tab">
    <GCard class="filter-card">
      <form class="filter-grid" @submit.prevent="onSearch">
        <GInput
          :model-value="sig.filters.q ?? ''"
          label="關鍵字"
          placeholder="ID、名稱、CVE、類別或廠商"
          icon="search"
          clearable
          @update:model-value="(v) => (sig.filters.q = String(v) || undefined)"
        />
        <GSelect v-model="kindModel" label="類型" placeholder="全部類型" :options="KIND_OPTIONS" />
        <GSelect v-model="severityModel" label="嚴重度" placeholder="全部嚴重度" :options="SEVERITY_OPTIONS" />

        <div class="days-field">
          <span class="field-lbl xs muted">新特徵範圍</span>
          <GSegmented v-model="daysModel" size="sm" :options="SIG_DAYS_OPTIONS" aria-label="新特徵範圍天數" />
        </div>

        <div class="filter-checks">
          <GCheckbox v-model="isNewModel" :label="`只看近 ${sig.filters.days ?? 30} 天新特徵`" />
          <GCheckbox v-model="hasHitsModel" label="只看近 30 天有命中" :disabled="sig.info !== null && !hitsAvailable" />
        </div>

        <div class="btn-row">
          <GButton type="submit" variant="primary" icon="search" :loading="sig.loading">查詢</GButton>
          <GButton type="button" variant="ghost" icon="reset" :disabled="sig.loading" @click="onReset">清除</GButton>
        </div>
      </form>

      <GAlert v-if="sig.error" tone="danger" class="mt-2">{{ describeError(sig.error) }}</GAlert>
      <GAlert v-if="sig.info?.since" tone="info" class="mt-2">
        自 {{ sig.info.since }} 起統計（歷史資料不足 {{ sig.info.days }} 天，新特徵僅計算基準建立日之後的內容更新）。
      </GAlert>
      <GAlert v-if="sig.currentVersionRebuilt" tone="warning" class="mt-2">
        這一版差異無法計算（目前版本因精簡索引遺失或損壞而重建，本版特徵不計入新增）。
      </GAlert>
      <GAlert v-if="sig.info?.available && !hitsAvailable" tone="info" class="mt-2">
        ClickHouse 暫時無法連線，目前無法顯示近 30 天命中數。
      </GAlert>
    </GCard>

    <GCard padding="none">
      <div class="table-head">
        <span class="small muted">
          符合 <strong class="mono">{{ fmtNum(sig.total) }}</strong> 筆特徵碼
          <template v-if="sig.info?.available">
            （本機共 {{ fmtNum(sig.info.counts.total) }} 筆：弱點 {{ fmtNum(sig.info.counts.vulnerability) }}、間諜軟體 {{ fmtNum(sig.info.counts.spyware) }}）
          </template>
        </span>
      </div>

      <GTable
        :page="sig.page"
        :columns="COLUMNS"
        :rows="sig.items"
        :total="sig.total"
        :page-size="sig.pageSize"
        :loading="sig.loading && !sig.items.length"
        row-key="id"
        dense
        clickable
        empty-title="查無符合條件的威脅特徵碼"
        empty-description="請調整篩選條件後重新查詢。"
        @update:page="onPageChange"
        @row-click="(r) => emit('open-signature', asRow(r).id)"
      >
        <template #cell-id="{ row }">
          <button type="button" class="id-btn mono xs" @click.stop="emit('open-signature', asRow(row).id)">
            {{ asRow(row).id }}
          </button>
        </template>

        <template #cell-kind="{ row }">
          <GBadge :tone="SIG_KIND_META[asRow(row).kind].tone" variant="soft">
            {{ SIG_KIND_META[asRow(row).kind].label }}
          </GBadge>
        </template>

        <template #cell-severity="{ row }">
          <GBadge :tone="severityMeta(asRow(row).severity).tone">
            {{ severityMeta(asRow(row).severity).label }}
          </GBadge>
        </template>

        <template #cell-name="{ row }">
          <div class="name-cell">
            <button type="button" class="name-btn" @click.stop="emit('open-signature', asRow(row).id)">
              {{ asRow(row).name }}
            </button>
            <GBadge v-if="asRow(row).isNew" tone="primary" variant="soft" class="mini-badge">新</GBadge>
            <GBadge v-if="asRow(row).disabled" tone="neutral" variant="outline" class="mini-badge">預設停用</GBadge>
          </div>
          <div v-if="asRow(row).category" class="xs muted">{{ asRow(row).category }}</div>
        </template>

        <template #cell-cves="{ row }">
          <div v-if="asRow(row).cves.length" class="cve-list">
            <GBadge v-for="c in asRow(row).cves.slice(0, 2)" :key="c" tone="danger" variant="outline" mono class="mini-badge">
              {{ c }}
            </GBadge>
            <span v-if="asRow(row).cves.length > 2" class="xs muted">+{{ asRow(row).cves.length - 2 }}</span>
          </div>
          <span v-else class="xs muted">—</span>
        </template>

        <template #cell-defaultAction="{ row }">
          <GBadge
            v-if="asRow(row).defaultAction"
            :tone="asRow(row).defaultAction === 'alert' ? 'warning' : 'neutral'"
            variant="soft"
          >
            {{ asRow(row).defaultAction }}
          </GBadge>
          <span v-else class="xs muted">—</span>
        </template>

        <template #cell-firstVersion="{ row }">
          <span class="mono xs" :class="{ muted: !asRow(row).firstVersion }">
            {{ formatFirstVersion(asRow(row).firstVersion) }}
          </span>
        </template>

        <template #cell-hits30d="{ row }">
          <span v-if="hitsAvailable" class="mono xs" :class="{ 'c-danger strong': (asRow(row).hits30d ?? 0) > 0, muted: !(asRow(row).hits30d ?? 0) }">
            {{ fmtNum(asRow(row).hits30d ?? 0) }}
          </span>
          <span v-else class="xs muted">—</span>
        </template>
      </GTable>
    </GCard>
  </div>
</template>

<style scoped>
.sig-list-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px 14px;
  align-items: end;
}
.days-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-lbl {
  font-weight: 500;
}
.filter-checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 4px;
}
.btn-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.mt-2 {
  margin-top: 12px;
}
.table-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.id-btn,
.name-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.id-btn:hover,
.name-btn:hover {
  text-decoration: underline;
}
.name-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.cve-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.mini-badge {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
}
.strong {
  font-weight: 700;
}
</style>
