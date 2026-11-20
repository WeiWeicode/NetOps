<script setup lang="ts">
/**
 * 防火牆 › 威脅特徵碼 — 分頁 2:版本差異(TS-4)
 *   - 左欄:內容版本清單(最多保留 90 份差異,D1/D2);標記基準版與 rebuilt 版
 *   - 右欄:單版差異(新增 / 變更含欄位前後值 / 停用或移除),支援篩選與分頁
 *   - TS-2 審查結論:標成 rebuilt 的版本明確顯示「這一版差異無法計算」
 */
import { computed, watch } from 'vue';
import { fmtNum, fmtTime } from '@/api/format';
import { ApiError, describeError } from '@/api/gateway';
import {
  PA_SIGNATURE_ERRORS,
  type SignatureDiffRow,
  type SignatureKind,
  type SignatureSeverity,
} from '@/api/paSignature';
import {
  DIFF_FIELD_LABELS,
  DIFF_KIND_META,
  formatDiffValue,
  severityMeta,
  SIG_KIND_META,
  type PaSignatureStore,
} from './types';

const props = defineProps<{
  sig: PaSignatureStore;
}>();
const emit = defineEmits<{ (e: 'open-signature', id: string): void }>();

const DIFF_KIND_OPTIONS = [
  { label: '新增', value: 'added' },
  { label: '變更', value: 'changed' },
  { label: '停用 / 移除', value: 'removed' },
];
const SIG_KIND_OPTIONS = [
  { label: '弱點', value: 'vulnerability' },
  { label: '間諜軟體', value: 'spyware' },
];
const SEVERITY_OPTIONS = [
  { label: '嚴重', value: 'critical' },
  { label: '高', value: 'high' },
  { label: '中', value: 'medium' },
  { label: '低', value: 'low' },
  { label: '資訊', value: 'informational' },
];

const diffKindModel = computed({
  get: () => props.sig.diffFilters.kind ?? '',
  set: (v: string) => {
    props.sig.diffFilters.kind = (v || undefined) as 'added' | 'changed' | 'removed' | undefined;
  },
});
const sigKindModel = computed({
  get: () => props.sig.diffFilters.sigKind ?? '',
  set: (v: string) => {
    props.sig.diffFilters.sigKind = (v || undefined) as SignatureKind | undefined;
  },
});
const sevModel = computed({
  get: () => props.sig.diffFilters.severity ?? '',
  set: (v: string) => {
    props.sig.diffFilters.severity = (v || undefined) as SignatureSeverity | undefined;
  },
});

watch(
  () => props.sig.versions,
  (list) => {
    if (list.length && !props.sig.selectedVersion) {
      void props.sig.loadDiff(list[0]!.threatVersion, 1);
    }
  },
  { immediate: true },
);

function selectVersion(ver: string) {
  props.sig.diffFilters.kind = undefined;
  props.sig.diffFilters.sigKind = undefined;
  props.sig.diffFilters.severity = undefined;
  props.sig.diffFilters.q = undefined;
  void props.sig.loadDiff(ver, 1);
}

function searchDiff() {
  if (!props.sig.selectedVersion) return;
  void props.sig.loadDiff(props.sig.selectedVersion, 1);
}

function resetDiffFilters() {
  props.sig.diffFilters.kind = undefined;
  props.sig.diffFilters.sigKind = undefined;
  props.sig.diffFilters.severity = undefined;
  props.sig.diffFilters.q = undefined;
  searchDiff();
}

const diffPages = computed(() => {
  const total = props.sig.diff?.total ?? 0;
  const ps = props.sig.diffPageSize || 50;
  return Math.max(1, Math.ceil(total / ps));
});

function gotoDiffPage(p: number) {
  if (!props.sig.selectedVersion) return;
  const clamped = Math.min(diffPages.value, Math.max(1, p));
  if (clamped !== props.sig.diffPage) void props.sig.loadDiff(props.sig.selectedVersion, clamped);
}

const diffErrorText = computed(() => {
  const err = props.sig.diffError;
  if (!err) return '';
  if (err instanceof ApiError && err.code === PA_SIGNATURE_ERRORS.versionNotFound) {
    return '找不到指定的內容版本（系統最多保留最近 90 份差異）';
  }
  return describeError(err);
});

const isChanged = (r: SignatureDiffRow): r is Extract<SignatureDiffRow, { diffKind: 'changed' }> => r.diffKind === 'changed';
</script>

<template>
  <div class="ver-tab">
    <GAlert tone="info">
      系統最多保留最近 <strong>90 份</strong> 內容版本差異（不存每版全量）；第一次讀到的清單作為基準版本，不算新增。
      <template v-if="sig.baselineAt">
        目前基準日：<strong class="mono">{{ sig.baselineAt.slice(0, 10) }}</strong>
        <template v-if="sig.baselineVersion">（版本 <span class="mono">{{ sig.baselineVersion }}</span>）</template>
      </template>
    </GAlert>

    <GAlert v-if="sig.versionsError" tone="danger">{{ describeError(sig.versionsError) }}</GAlert>

    <div class="ver-layout">
      <GCard class="ver-list-card" padding="none">
        <header class="card-head">
          <h3>內容版本歷史 ({{ sig.versions.length }})</h3>
          <GButton size="sm" variant="ghost" icon="refresh" :loading="sig.versionsLoading" @click="sig.loadVersions()">
            重整
          </GButton>
        </header>

        <GSkeleton v-if="sig.versionsLoading && !sig.versions.length" :lines="6" class="pad" />
        <GEmpty
          v-else-if="!sig.versions.length"
          icon="clock"
          title="尚無內容版本紀錄"
          description="待收集器讀取 PA 威脅特徵碼並完成同步後，將自動建立基準版本。"
          class="pad"
        />
        <ul v-else class="ver-list">
          <li v-for="v in sig.versions" :key="v.threatVersion">
            <button
              type="button"
              class="ver-item"
              :class="{ active: sig.selectedVersion === v.threatVersion }"
              @click="selectVersion(v.threatVersion)"
            >
              <div class="ver-top">
                <span class="mono ver-name">{{ v.threatVersion }}</span>
                <GBadge v-if="v.isBaseline" tone="info" variant="soft">基準</GBadge>
                <GBadge v-else-if="v.rebuilt" tone="warning" variant="soft">差異無法計算</GBadge>
                <div v-else class="ver-counts xs mono">
                  <span class="c-success">+{{ fmtNum(v.added) }}</span>
                  <span class="c-warning">~{{ fmtNum(v.changed) }}</span>
                  <span class="c-danger">-{{ fmtNum(v.removed) }}</span>
                </div>
              </div>
              <div class="xs muted ver-sub">
                <span>{{ v.releaseDate || fmtTime(v.savedAt) }}</span>
                <span class="mono">{{ fmtNum(v.counts.total) }} 筆</span>
              </div>
              <p v-if="v.rebuilt" class="xs c-warning rebuilt-note">這一版差異無法計算</p>
            </button>
          </li>
        </ul>
      </GCard>

      <GCard class="diff-card">
        <header class="diff-head">
          <div>
            <h3>版本差異明細</h3>
            <p v-if="sig.diff" class="xs muted">
              內容版本：<strong class="mono">{{ sig.diff.threatVersion }}</strong>
              <template v-if="sig.diff.baseVersion">
                · 比較前一版：<span class="mono">{{ sig.diff.baseVersion }}</span>
              </template>
              · 記錄時間：{{ fmtTime(sig.diff.savedAt) }}
            </p>
          </div>
          <div v-if="sig.diff && !sig.diff.isBaseline && !sig.diffUnavailable" class="sum-badges">
            <GBadge tone="success" variant="soft">新增 {{ fmtNum(sig.diff.summary.added) }}</GBadge>
            <GBadge tone="warning" variant="soft">變更 {{ fmtNum(sig.diff.summary.changed) }}</GBadge>
            <GBadge tone="danger" variant="soft">停用 / 移除 {{ fmtNum(sig.diff.summary.removed) }}</GBadge>
          </div>
        </header>

        <GSkeleton v-if="sig.diffLoading" :lines="6" />
        <GAlert v-else-if="sig.diffError" tone="danger">{{ diffErrorText }}</GAlert>
        <GEmpty
          v-else-if="!sig.diff"
          icon="audit"
          title="請選擇左側內容版本"
          description="點擊版本清單中的任一版本以檢視新增、變更與停用 / 移除的特徵碼。"
        />
        <template v-else>
          <GAlert v-if="sig.diff.isBaseline" tone="info">
            這是第一次讀到的基準版本（不算新增），沒有可比較的前一版。
          </GAlert>

          <GAlert v-else-if="sig.diffUnavailable" tone="warning">
            這一版差異無法計算（精簡索引遺失或損壞而重建，本版特徵不計入新增；下一次內容版本更新會恢復正常差異比對）。
          </GAlert>

          <template v-else>
            <form class="diff-filters" @submit.prevent="searchDiff">
              <GSelect v-model="diffKindModel" label="異動類型" placeholder="全部" :options="DIFF_KIND_OPTIONS" />
              <GSelect v-model="sigKindModel" label="特徵類型" placeholder="全部" :options="SIG_KIND_OPTIONS" />
              <GSelect v-model="sevModel" label="嚴重度" placeholder="全部" :options="SEVERITY_OPTIONS" />
              <GInput
                :model-value="sig.diffFilters.q ?? ''"
                label="關鍵字"
                placeholder="ID / 名稱 / CVE"
                clearable
                @update:model-value="(v) => (sig.diffFilters.q = String(v) || undefined)"
              />
              <div class="diff-filter-btns">
                <GButton type="submit" size="sm" variant="primary" icon="search">篩選</GButton>
                <GButton type="button" size="sm" variant="ghost" icon="reset" @click="resetDiffFilters">清除</GButton>
              </div>
            </form>

            <GEmpty
              v-if="!sig.diff.items.length"
              icon="check-circle"
              title="沒有符合條件的差異項目"
              description="此版本在目前篩選條件下沒有新增、變更或移除的特徵。"
            />

            <div v-else class="diff-list">
              <article
                v-for="(row, idx) in sig.diff.items"
                :key="`${row.diffKind}-${row.id}-${idx}`"
                class="diff-row"
              >
                <div class="diff-row__head">
                  <GBadge :tone="DIFF_KIND_META[row.diffKind].tone" variant="soft">
                    {{ DIFF_KIND_META[row.diffKind].label }}
                  </GBadge>
                  <GBadge :tone="SIG_KIND_META[row.kind].tone" variant="outline">
                    {{ SIG_KIND_META[row.kind].label }}
                  </GBadge>
                  <GBadge :tone="severityMeta(row.severity).tone">
                    {{ severityMeta(row.severity).label }}
                  </GBadge>
                  <button
                    type="button"
                    class="sig-link"
                    @click="emit('open-signature', row.id)"
                  >
                    <span class="mono">#{{ row.id }}</span> {{ row.name }}
                  </button>
                </div>

                <div v-if="isChanged(row)" class="field-diffs">
                  <div v-for="f in row.fields" :key="f.field" class="field-line xs">
                    <span class="field-lbl">{{ DIFF_FIELD_LABELS[f.field] ?? f.field }}</span>
                    <span class="val-before mono">- {{ formatDiffValue(f.before) }}</span>
                    <span class="val-after mono">+ {{ formatDiffValue(f.after) }}</span>
                  </div>
                </div>
                <div v-else class="diff-meta xs muted">
                  <span v-if="row.category">類別：{{ row.category }}</span>
                  <span v-if="row.defaultAction">預設動作：{{ row.defaultAction }}</span>
                  <span v-if="row.disabled">（預設停用）</span>
                  <span v-if="row.cves.length" class="mono">CVE：{{ row.cves.slice(0, 4).join(', ') }}{{ row.cves.length > 4 ? ` +${row.cves.length - 4}` : '' }}</span>
                </div>
              </article>
            </div>

            <div v-if="diffPages > 1" class="diff-pager">
              <span class="xs muted">
                共 {{ fmtNum(sig.diff.total) }} 筆 · 第 {{ sig.diffPage }} / {{ diffPages }} 頁
              </span>
              <div class="pager-btns">
                <GButton size="sm" variant="ghost" :disabled="sig.diffPage <= 1" @click="gotoDiffPage(sig.diffPage - 1)">上一頁</GButton>
                <GButton size="sm" variant="ghost" :disabled="sig.diffPage >= diffPages" @click="gotoDiffPage(sig.diffPage + 1)">下一頁</GButton>
              </div>
            </div>
          </template>
        </template>
      </GCard>
    </div>
  </div>
</template>

<style scoped>
.ver-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ver-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 900px) {
  .ver-layout {
    grid-template-columns: 1fr;
  }
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.card-head h3,
.diff-head h3 {
  margin: 0;
  font-size: var(--fs-md);
}
.pad {
  padding: 16px;
}
.ver-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 620px;
  overflow-y: auto;
}
.ver-item {
  width: 100%;
  padding: 10px 14px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ver-item:hover {
  background: var(--glass-soft);
}
.ver-item.active {
  background: color-mix(in srgb, var(--c-primary) 12%, transparent);
  border-left: 3px solid var(--c-primary);
}
.ver-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ver-name {
  font-weight: 600;
  font-size: var(--fs-sm);
}
.ver-counts {
  display: inline-flex;
  gap: 6px;
}
.ver-sub {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.rebuilt-note {
  margin: 0;
  font-weight: 600;
}
.diff-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.diff-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.diff-head p {
  margin: 4px 0 0;
}
.sum-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.diff-filters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px 12px;
  align-items: end;
}
.diff-filter-btns {
  display: flex;
  gap: 6px;
}
.diff-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.diff-row {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.diff-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.sig-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  font: inherit;
  font-weight: 600;
  font-size: var(--fs-sm);
  cursor: pointer;
  text-align: left;
}
.sig-link:hover {
  text-decoration: underline;
}
.diff-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.field-diffs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.field-lbl {
  font-weight: 600;
  color: var(--text-2);
}
.val-before {
  color: var(--c-danger);
}
.val-after {
  color: var(--c-success);
}
.diff-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.pager-btns {
  display: flex;
  gap: 6px;
}
</style>
