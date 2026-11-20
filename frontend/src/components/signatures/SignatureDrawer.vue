<script setup lang="ts">
/**
 * 威脅特徵碼說明抽屜(TS-4;docs/THREAT-SIGNATURE-PLAN.md §5.4):
 *   共用元件:威脅特徵碼頁、安全事件、Log 明細查詢、即時監控戰情室、時段明細抽屜。
 *   - 快照命中:顯示名稱、嚴重度、類別、CVE、預設動作、首次出現版本(null 顯示「未知」)、近 30 天命中數與版本異動紀錄
 *   - 索引重建(rebuilt):標示「這一版差異無法計算」
 *   - 快照查無:202 按需查詢(show threat id)輪詢過程顯示進度;查無顯示「本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)」
 */
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { fmtNum, fmtTime } from '@/api/format';
import {
  DIFF_FIELD_LABELS,
  DIFF_KIND_META,
  formatDiffValue,
  formatFirstVersion,
  searchLinkForSignature,
  severityMeta,
  SIG_KIND_META,
  type PaSignatureDrawerStore,
} from './types';

const props = defineProps<{
  drawer: PaSignatureDrawerStore;
}>();

const snapDetail = computed(() => (props.drawer.detail?.source === 'snapshot' ? props.drawer.detail : null));
const lookupDetail = computed(() => (props.drawer.detail?.source === 'lookup' ? props.drawer.detail : null));

const title = computed(() => {
  if (snapDetail.value) return `#${snapDetail.value.item.id} ${snapDetail.value.item.name}`;
  if (lookupDetail.value) return `#${lookupDetail.value.item.id} ${lookupDetail.value.item.name || '特徵碼按需查詢'}`;
  if (props.drawer.threatId) return `威脅特徵碼 #${props.drawer.threatId}`;
  return '威脅特徵碼說明';
});

const sevInfo = computed(() => {
  const sev = snapDetail.value?.item.severity ?? lookupDetail.value?.item.severity;
  return sev ? severityMeta(sev) : null;
});

const searchLink = computed(() => {
  if (snapDetail.value) return searchLinkForSignature({ id: snapDetail.value.item.id, name: snapDetail.value.item.name });
  if (lookupDetail.value) return searchLinkForSignature({ id: lookupDetail.value.item.id, name: lookupDetail.value.item.name });
  if (props.drawer.threatId) return searchLinkForSignature({ id: props.drawer.threatId });
  return null;
});

function onUpdate(v: boolean) {
  if (!v) props.drawer.close();
}
</script>

<template>
  <GDrawer :model-value="drawer.open" :title="title" width="600px" @update:model-value="onUpdate">
    <template #actions>
      <GBadge v-if="sevInfo" :tone="sevInfo.tone">{{ sevInfo.label }}</GBadge>
      <GBadge v-if="snapDetail" :tone="SIG_KIND_META[snapDetail.item.kind].tone" variant="soft">
        {{ SIG_KIND_META[snapDetail.item.kind].label }}
      </GBadge>
      <GBadge v-if="snapDetail?.item.isNew" tone="primary" variant="outline">新特徵</GBadge>
      <GBadge v-if="snapDetail?.item.disabled" tone="neutral" variant="outline">預設停用</GBadge>
      <GBadge v-if="lookupDetail" tone="info" variant="soft">按需查詢</GBadge>
    </template>

    <!-- 202 按需查詢輪詢中或初次載入中 -->
    <div v-if="drawer.polling || (drawer.loading && !drawer.detail)" class="sig-loading" role="status" aria-live="polite">
      <div class="sig-loading__head">
        <span class="spin-dot" aria-hidden="true" />
        <span class="small">
          {{
            drawer.polling
              ? `快照中沒有特徵碼 #${drawer.threatId}，正在透過收集器向 PA 按需查詢（show threat id）…`
              : `正在讀取特徵碼 #${drawer.threatId}…`
          }}
        </span>
      </div>
      <GSkeleton :lines="6" />
    </div>

    <!-- 查無 / 拒絕 / 錯誤(例:202 按需查無回「本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)」) -->
    <div v-else-if="!drawer.detail && drawer.notice" class="sig-notice-wrap">
      <GEmpty
        icon="shield-alert"
        :title="`查無特徵碼 #${drawer.threatId ?? ''}`"
        :description="drawer.notice"
      >
        <RouterLink v-if="searchLink" :to="searchLink" @click="drawer.close()">
          <GButton size="sm" variant="secondary" icon="search">到 Log 明細查詢</GButton>
        </RouterLink>
      </GEmpty>
    </div>

    <!-- 快照命中 -->
    <div v-else-if="snapDetail" class="sig-body">
      <div class="meta-bar xs muted">
        <span>內容版本：<strong class="mono">{{ snapDetail.threatVersion }}</strong></span>
        <span>快照時間：{{ fmtTime(snapDetail.fetchedAt) }}</span>
        <span v-if="snapDetail.baselineAt">基準日：{{ snapDetail.baselineAt.slice(0, 10) }}</span>
      </div>

      <GAlert v-if="drawer.hasRebuiltChanges" tone="warning">
        此特徵涉及精簡索引重建版本，這一版差異無法計算（首次出現版本可能標示為「未知」）。
      </GAlert>

      <section class="sec">
        <h3 class="sec-title">基本資訊</h3>
        <dl class="kv">
          <dt>特徵 ID</dt>
          <dd class="mono">{{ snapDetail.item.id }}</dd>
          <dt>名稱</dt>
          <dd>{{ snapDetail.item.name }}</dd>
          <dt>類型</dt>
          <dd>{{ SIG_KIND_META[snapDetail.item.kind].label }}</dd>
          <dt>嚴重度</dt>
          <dd>
            <GBadge :tone="severityMeta(snapDetail.item.severity).tone">{{ severityMeta(snapDetail.item.severity).label }}</GBadge>
            <span class="xs muted mono ml-1">({{ snapDetail.item.severity }})</span>
          </dd>
          <dt>類別</dt>
          <dd class="mono">{{ snapDetail.item.category || '—' }}</dd>
          <dt>影響目標</dt>
          <dd class="mono">{{ snapDetail.item.affectedHost || '—' }}</dd>
          <dt>預設動作</dt>
          <dd>
            <GBadge
              v-if="snapDetail.item.defaultAction"
              :tone="snapDetail.item.defaultAction === 'alert' ? 'warning' : 'info'"
              variant="soft"
            >
              {{ snapDetail.item.defaultAction }}
            </GBadge>
            <span v-else class="muted">—</span>
          </dd>
          <dt>引擎版本</dt>
          <dd class="mono">{{ snapDetail.item.engineVersion || '—' }}</dd>
          <dt>首次出現版本</dt>
          <dd class="mono">{{ formatFirstVersion(snapDetail.item.firstVersion) }}</dd>
          <dt>近 30 天命中</dt>
          <dd class="mono">
            {{ snapDetail.item.hits30d != null ? `${fmtNum(snapDetail.item.hits30d)} 筆` : '無法取得（ClickHouse 未連線）' }}
          </dd>
          <dt>CVE</dt>
          <dd>
            <div v-if="snapDetail.item.cves.length" class="chips">
              <GBadge v-for="cve in snapDetail.item.cves" :key="cve" tone="danger" variant="outline" mono>{{ cve }}</GBadge>
            </div>
            <span v-else class="muted">無</span>
          </dd>
          <dt>廠商參考</dt>
          <dd>
            <div v-if="snapDetail.item.vendorIds.length" class="chips">
              <GBadge v-for="v in snapDetail.item.vendorIds" :key="v" tone="neutral" variant="soft" mono>{{ v }}</GBadge>
            </div>
            <span v-else class="muted">—</span>
          </dd>
        </dl>
      </section>

      <section class="sec">
        <h3 class="sec-title">版本異動紀錄 ({{ snapDetail.item.changes.length }})</h3>
        <p v-if="!snapDetail.item.changes.length" class="xs muted empty-note">
          自基準日以來沒有異動紀錄（可能為基準版本即已存在）。
        </p>
        <ul v-else class="change-list">
          <li v-for="(c, idx) in snapDetail.item.changes" :key="`${c.threatVersion}-${c.kind}-${idx}`" class="change-item">
            <div class="change-head">
              <GBadge :tone="DIFF_KIND_META[c.rebuilt ? 'rebuilt' : c.kind].tone" variant="soft">
                {{ DIFF_KIND_META[c.rebuilt ? 'rebuilt' : c.kind].label }}
              </GBadge>
              <strong class="mono xs">{{ c.threatVersion }}</strong>
              <span class="xs muted">{{ c.releaseDate || fmtTime(c.savedAt) }}</span>
            </div>
            <p v-if="c.rebuilt || c.kind === 'rebuilt'" class="xs c-warning change-rebuilt">
              這一版差異無法計算（精簡索引遺失或損壞而重建）
            </p>
            <div v-else-if="c.fields?.length" class="field-diffs">
              <div v-for="f in c.fields" :key="f.field" class="field-row xs">
                <span class="field-name">{{ DIFF_FIELD_LABELS[f.field] ?? f.field }}</span>
                <span class="val-before mono">- {{ formatDiffValue(f.before) }}</span>
                <span class="val-after mono">+ {{ formatDiffValue(f.after) }}</span>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <div v-if="searchLink" class="sig-footer">
        <RouterLink :to="searchLink" @click="drawer.close()">
          <GButton size="sm" variant="secondary" icon="search">查看近 30 天威脅 Log 明細</GButton>
        </RouterLink>
      </div>
    </div>

    <!-- 202 按需查詢命中(show threat id) -->
    <div v-else-if="lookupDetail" class="sig-body">
      <div class="meta-bar xs muted">
        <span>資料來源：PA 按需查詢（show threat id）</span>
        <span v-if="lookupDetail.checkedAt">查詢時間：{{ fmtTime(lookupDetail.checkedAt) }}</span>
      </div>

      <section class="sec">
        <h3 class="sec-title">按需查詢結果</h3>
        <dl class="kv">
          <dt>特徵 ID</dt>
          <dd class="mono">{{ lookupDetail.item.id }}</dd>
          <dt>名稱</dt>
          <dd>{{ lookupDetail.item.name || '—' }}</dd>
          <dt>子類型</dt>
          <dd class="mono">{{ lookupDetail.item.subtype || '—' }}</dd>
          <dt>嚴重度</dt>
          <dd>
            <GBadge v-if="lookupDetail.item.severity" :tone="severityMeta(lookupDetail.item.severity).tone">
              {{ severityMeta(lookupDetail.item.severity).label }}
            </GBadge>
            <span v-else class="muted">—</span>
          </dd>
          <dt>首次出現版本</dt>
          <dd class="mono">{{ formatFirstVersion(lookupDetail.item.firstVersion) }}</dd>
          <dt>近 30 天命中</dt>
          <dd class="mono">
            {{ lookupDetail.item.hits30d != null ? `${fmtNum(lookupDetail.item.hits30d)} 筆` : '無法取得' }}
          </dd>
          <dt>說明</dt>
          <dd class="desc-text">{{ lookupDetail.item.description || '—' }}</dd>
        </dl>
      </section>

      <div v-if="searchLink" class="sig-footer">
        <RouterLink :to="searchLink" @click="drawer.close()">
          <GButton size="sm" variant="secondary" icon="search">查看近 30 天威脅 Log 明細</GButton>
        </RouterLink>
      </div>
    </div>
  </GDrawer>
</template>

<style scoped>
.sig-loading {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sig-loading__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--c-primary-text);
}
.spin-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--c-primary) 30%, transparent);
  border-top-color: var(--c-primary);
  animation: sig-spin 0.8s linear infinite;
  flex: none;
}
@keyframes sig-spin {
  to {
    transform: rotate(360deg);
  }
}
.sig-notice-wrap {
  padding: 12px 0;
}
.sig-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.meta-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sec-title {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  font-weight: 600;
}
.kv {
  display: grid;
  grid-template-columns: 112px 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: var(--fs-sm);
}
.kv dt {
  color: var(--text-3);
}
.kv dd {
  margin: 0;
  min-width: 0;
  word-break: break-word;
}
.ml-1 {
  margin-left: 4px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.desc-text {
  white-space: pre-wrap;
  line-height: 1.5;
}
.empty-note {
  margin: 0;
}
.change-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.change-item {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.change-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.change-rebuilt {
  margin: 0;
  font-weight: 600;
}
.field-diffs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
}
.field-name {
  font-weight: 600;
  color: var(--text-2);
}
.val-before {
  color: var(--c-danger);
}
.val-after {
  color: var(--c-success);
}
.sig-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
</style>
