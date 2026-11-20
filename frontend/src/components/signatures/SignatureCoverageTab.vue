<script setup lang="ts">
/**
 * 防火牆 › 威脅特徵碼 — 分頁 4:規則覆蓋(TS-4;計畫 §5.2、TS-Q5)
 *   - 列出 action=allow、啟用中且缺少弱點防護或間諜軟體 profile 的安全規則
 *   - 第一版只看有沒有掛(TS-Q5),不判斷 profile 內容
 *   - Profile Group 讀不到或找不到時標「無法判定」,不可當成已有防護
 *   - 點選規則名稱開既有安全規則抽屜(PolicyRuleDrawer)
 */
import { computed, ref } from 'vue';
import { fmtNum, fmtTime } from '@/api/format';
import { describeError } from '@/api/gateway';
import type { CoverageRuleItem } from '@/api/paSignature';
import type { Column } from '@/ui/components/GTable.vue';
import type { PaSignatureStore } from './types';

const props = defineProps<{
  sig: PaSignatureStore;
}>();
const emit = defineEmits<{ (e: 'open-rule', name: string): void }>();

const statusFilter = ref<'all' | 'missing' | 'unknown'>('all');
const keyword = ref('');

const STATUS_OPTIONS = [
  { label: '全部缺口', value: 'all' },
  { label: '缺少防護', value: 'missing' },
  { label: '無法判定', value: 'unknown' },
];

const availableCoverage = computed(() => (props.sig.coverage?.available ? props.sig.coverage : null));
const unavailableCoverage = computed(() => (props.sig.coverage && !props.sig.coverage.available ? props.sig.coverage : null));

const filteredItems = computed<CoverageRuleItem[]>(() => {
  const list = availableCoverage.value?.items ?? [];
  const q = keyword.value.trim().toLowerCase();
  return list.filter((it) => {
    if (statusFilter.value !== 'all' && it.status !== statusFilter.value) return false;
    if (q) {
      const hit =
        String(it.position).includes(q) ||
        it.name.toLowerCase().includes(q) ||
        it.fromZones.some((z) => z.toLowerCase().includes(q)) ||
        it.toZones.some((z) => z.toLowerCase().includes(q)) ||
        it.applications.some((a) => a.toLowerCase().includes(q)) ||
        (it.profileGroup?.toLowerCase().includes(q) ?? false);
      if (!hit) return false;
    }
    return true;
  });
});

const COLUMNS: Column[] = [
  { key: 'position', label: '編號', width: '76px', mono: true },
  { key: 'name', label: '規則名稱' },
  { key: 'zones', label: 'Zone', width: '180px' },
  { key: 'applications', label: '應用', width: '180px', hideSm: true },
  { key: 'profileGroup', label: 'Profile Group', width: '150px', hideSm: true },
  { key: 'hitCount', label: '命中數', width: '96px', align: 'right', mono: true, hideSm: true },
  { key: 'status', label: '缺口 / 狀態', width: '210px' },
];

const asRow = (r: unknown) => r as CoverageRuleItem;
</script>

<template>
  <div class="cov-tab">
    <GCard v-if="!sig.canCoverage">
      <GEmpty
        icon="lock"
        title="需要安全規則檢視權限"
        description="檢視規則覆蓋缺口需具備安全規則檢視權限（netops.pa-policy.read）。"
      />
    </GCard>

    <template v-else>
      <GAlert v-if="sig.coverageError" tone="danger">{{ describeError(sig.coverageError) }}</GAlert>
      <GSkeleton v-if="sig.coverageLoading && !sig.coverage" :lines="6" />

      <GCard v-else-if="unavailableCoverage">
        <GEmpty
          icon="shield"
          title="目前無法評估規則覆蓋"
          :description="unavailableCoverage.message"
        >
          <GButton size="sm" variant="secondary" icon="refresh" :loading="sig.coverageLoading" @click="sig.loadCoverage()">
            重新載入
          </GButton>
        </GEmpty>
      </GCard>

      <template v-else-if="availableCoverage">
        <div class="meta-bar xs muted">
          <span>安全規則快照：{{ fmtTime(availableCoverage.policyFetchedAt) }}</span>
          <span v-if="availableCoverage.profilesFetchedAt">
            vsys1 Profile 快照：{{ fmtTime(availableCoverage.profilesFetchedAt) }}
          </span>
          <span class="spacer" />
          <GButton size="sm" variant="ghost" icon="refresh" :loading="sig.coverageLoading" @click="sig.loadCoverage()">
            重新整理
          </GButton>
        </div>

        <GAlert v-if="availableCoverage.message" tone="warning">{{ availableCoverage.message }}</GAlert>
        <GAlert v-if="availableCoverage.summary.unknown > 0" tone="warning">
          有 <strong>{{ fmtNum(availableCoverage.summary.unknown) }}</strong> 條規則標示為「無法判定」（Profile Group 讀不到或找不到內容），不可當成已有防護，請人工確認。
        </GAlert>

        <section class="summary-grid">
          <div class="sum-card">
            <span class="xs muted">啟用中 allow 規則</span>
            <strong class="mono sum-num">{{ fmtNum(availableCoverage.summary.totalAllowEnabled) }}</strong>
          </div>
          <div class="sum-card">
            <span class="xs muted">完整涵蓋 (VP + AS)</span>
            <strong class="mono sum-num c-success">{{ fmtNum(availableCoverage.summary.covered) }}</strong>
          </div>
          <div class="sum-card" :class="{ 'is-warn': availableCoverage.summary.missingBoth > 0 }">
            <span class="xs muted">兩者皆缺</span>
            <strong class="mono sum-num c-danger">{{ fmtNum(availableCoverage.summary.missingBoth) }}</strong>
          </div>
          <div class="sum-card">
            <span class="xs muted">僅缺弱點防護 (VP)</span>
            <strong class="mono sum-num c-warning">{{ fmtNum(availableCoverage.summary.missingVulnerability) }}</strong>
          </div>
          <div class="sum-card">
            <span class="xs muted">僅缺間諜軟體 (AS)</span>
            <strong class="mono sum-num c-warning">{{ fmtNum(availableCoverage.summary.missingSpyware) }}</strong>
          </div>
          <div class="sum-card" :class="{ 'is-warn': availableCoverage.summary.unknown > 0 }">
            <span class="xs muted">無法判定</span>
            <strong class="mono sum-num">{{ fmtNum(availableCoverage.summary.unknown) }}</strong>
          </div>
        </section>

        <GCard padding="none">
          <div class="filter-bar">
            <GSegmented v-model="statusFilter" size="sm" :options="STATUS_OPTIONS" aria-label="規則覆蓋狀態篩選" />
            <GInput
              v-model="keyword"
              placeholder="篩選編號、規則名稱、Zone 或應用"
              icon="search"
              clearable
              class="kw-input"
            />
            <span class="xs muted ml-auto">
              顯示 {{ fmtNum(filteredItems.length) }} / {{ fmtNum(availableCoverage.items.length) }} 條待確認規則
            </span>
          </div>

          <GTable
            :columns="COLUMNS"
            :rows="filteredItems"
            row-key="name"
            :page-size="50"
            dense
            clickable
            empty-title="沒有缺少威脅防護的 allow 規則"
            empty-description="目前所有啟用中的 allow 規則均已掛載弱點防護與間諜軟體 Profile。"
            @row-click="(r) => emit('open-rule', asRow(r).name)"
          >
            <template #cell-position="{ row }">
              <span class="mono xs">#{{ asRow(row).position }}</span>
            </template>

            <template #cell-name="{ row }">
              <button type="button" class="rule-btn mono" @click.stop="emit('open-rule', asRow(row).name)">
                {{ asRow(row).name }}
              </button>
            </template>

            <template #cell-zones="{ row }">
              <span class="xs mono">
                {{ asRow(row).fromZones.join(', ') || 'any' }} → {{ asRow(row).toZones.join(', ') || 'any' }}
              </span>
            </template>

            <template #cell-applications="{ row }">
              <span class="xs mono">
                {{ asRow(row).applications.slice(0, 3).join(', ') || 'any' }}
                <template v-if="asRow(row).applications.length > 3"> +{{ asRow(row).applications.length - 3 }}</template>
              </span>
            </template>

            <template #cell-profileGroup="{ row }">
              <span class="xs mono" :class="{ muted: !asRow(row).profileGroup }">
                {{ asRow(row).profileGroup || '—' }}
              </span>
            </template>

            <template #cell-hitCount="{ row }">
              <span class="xs mono" :class="{ muted: asRow(row).hitCount == null }">
                {{ asRow(row).hitCount != null ? fmtNum(asRow(row).hitCount!) : '—' }}
              </span>
            </template>

            <template #cell-status="{ row }">
              <div v-if="asRow(row).status === 'unknown'" class="status-cell">
                <GBadge tone="warning" variant="soft">無法判定</GBadge>
                <span v-if="asRow(row).reason" class="xs muted">{{ asRow(row).reason }}</span>
              </div>
              <div v-else class="status-cell">
                <GBadge v-if="asRow(row).missing.includes('vulnerability')" tone="danger" variant="soft">缺弱點防護</GBadge>
                <GBadge v-if="asRow(row).missing.includes('spyware')" tone="warning" variant="soft">缺間諜軟體</GBadge>
              </div>
            </template>
          </GTable>
        </GCard>
      </template>
    </template>
  </div>
</template>

<style scoped>
.cov-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.meta-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.spacer {
  flex: 1;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.sum-card {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--glass);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sum-card.is-warn {
  border-color: color-mix(in srgb, var(--c-warning) 50%, var(--line));
}
.sum-num {
  font-size: var(--fs-xl);
  font-weight: 700;
}
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.kw-input {
  width: 260px;
  max-width: 100%;
}
.ml-auto {
  margin-left: auto;
}
.rule-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  font: inherit;
  font-weight: 600;
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
}
.rule-btn:hover {
  text-decoration: underline;
}
.status-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
</style>
