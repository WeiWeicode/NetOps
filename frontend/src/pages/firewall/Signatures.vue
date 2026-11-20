<script setup lang="ts">
/**
 * 防火牆 › 威脅特徵碼頁(TS-4;docs/THREAT-SIGNATURE-PLAN.md §1.2、§5、§7):
 *   - 五個分頁:特徵清單、版本差異、命中比對、規則覆蓋、AI 摘要(AI 分頁僅在 canAi 為 true 時顯示)
 *   - 資料一律來自 usePaSignature、usePaSignatureDrawer、usePolicyRuleDrawer(頁面不自行 fetch、不自寫權限判斷)
 *   - 頁首顯示內容版本(威脅、AV、WildFire 依 TS-Q4 只顯示版本與發布時間)、快照時間、過期警告(>2h)、收集狀態、CPU 與手動重新整理
 *   - s.info.available === false 時整頁以 GEmpty 顯示 s.info.message
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fmtTime } from '@/api/format';
import { describeError } from '@/api/gateway';
import PolicyRuleDrawer from '@/components/policies/PolicyRuleDrawer.vue';
import SignatureAiTab from '@/components/signatures/SignatureAiTab.vue';
import SignatureCoverageTab from '@/components/signatures/SignatureCoverageTab.vue';
import SignatureDrawer from '@/components/signatures/SignatureDrawer.vue';
import SignatureHitsTab from '@/components/signatures/SignatureHitsTab.vue';
import SignatureListTab from '@/components/signatures/SignatureListTab.vue';
import SignatureVersionsTab from '@/components/signatures/SignatureVersionsTab.vue';
import { COLLECTOR_STATE_META, type SignatureTab } from '@/components/signatures/types';
import type { UsePaPolicyOptions } from '@/composables/usePaPolicy';
import { usePaSignature, type UsePaSignatureOptions } from '@/composables/usePaSignature';
import { usePaSignatureDrawer, type UsePaSignatureDrawerOptions } from '@/composables/usePaSignatureDrawer';
import { usePolicyRuleDrawer } from '@/composables/usePolicyRuleDrawer';
import { toast } from '@/ui';
import type { TabItem } from '@/ui/components/GTabs.vue';

const props = defineProps<{
  /** 元件測試 / 預覽用注入選項;正式頁面不傳入,使用真實後端與權限 */
  signatureOptions?: UsePaSignatureOptions;
  drawerOptions?: UsePaSignatureDrawerOptions;
  ruleDrawerOptions?: UsePaPolicyOptions;
}>();

const s = usePaSignature(props.signatureOptions);
const sigDrawer = usePaSignatureDrawer(props.drawerOptions);
const ruleDrawer = usePolicyRuleDrawer(props.ruleDrawerOptions);

const activeTab = ref<SignatureTab>('list');
const versionsLoaded = ref(false);
const coverageLoaded = ref(false);

const tabItems = computed<TabItem[]>(() => {
  const tabs: TabItem[] = [
    { label: '清單', value: 'list', icon: 'list', count: s.info?.available ? s.total : undefined },
    { label: '版本差異', value: 'versions', icon: 'clock', count: versionsLoaded.value ? s.versions.length : undefined },
    { label: '命中比對', value: 'hits', icon: 'activity', count: s.hitsResult ? s.hitsResult.items.length : undefined },
    {
      label: '規則覆蓋',
      value: 'coverage',
      icon: 'shield',
      count: coverageLoaded.value && s.coverage?.available ? s.coverage.items.length : undefined,
    },
  ];
  if (s.canAi) {
    tabs.push({ label: 'AI 摘要', value: 'ai', icon: 'sparkles' });
  }
  return tabs;
});

/* ───── 冷卻倒數(跟隨 s.cooldownSec,每秒遞減顯示) ───── */
const localCooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | undefined;

function clearCooldownTimer() {
  if (cooldownTimer !== undefined) {
    clearInterval(cooldownTimer);
    cooldownTimer = undefined;
  }
}

watch(
  () => s.cooldownSec,
  (sec) => {
    clearCooldownTimer();
    localCooldown.value = Math.max(0, Math.ceil(sec));
    if (localCooldown.value > 0) {
      cooldownTimer = setInterval(() => {
        localCooldown.value = Math.max(0, localCooldown.value - 1);
        if (localCooldown.value === 0) clearCooldownTimer();
      }, 1000);
    }
  },
  { immediate: true },
);

onBeforeUnmount(clearCooldownTimer);

const availableInfo = computed(() => (s.info?.available ? s.info : null));
const unavailableInfo = computed(() => (s.info && !s.info.available ? s.info : null));

const statusMeta = computed(() => {
  const st = s.info?.status?.state;
  if (!st) return null;
  return COLLECTOR_STATE_META[st] ?? { label: st, tone: 'neutral' };
});

async function onRefresh() {
  try {
    const ok = await s.refresh();
    if (ok) void s.loadStatus();
  } catch (e) {
    toast.error(describeError(e));
  }
}

async function openSignature(id: string) {
  const r = await sigDrawer.show(id);
  if (r !== 'ok' && r !== 'stale' && !sigDrawer.open && sigDrawer.notice) {
    toast.info(sigDrawer.notice);
  }
}

async function openRule(name: string) {
  const r = await ruleDrawer.show(name);
  if (r !== 'ok' && r !== 'stale' && ruleDrawer.notice) {
    toast.info(ruleDrawer.notice);
  }
}

function onRuleDrawerToggle(v: boolean) {
  if (!v) ruleDrawer.close();
}

watch(activeTab, (tab) => {
  if (tab === 'versions' && !versionsLoaded.value) {
    versionsLoaded.value = true;
    void s.loadVersions();
  } else if (tab === 'coverage' && !coverageLoaded.value && s.canCoverage) {
    coverageLoaded.value = true;
    void s.loadCoverage();
  }
});

onMounted(() => {
  void s.load(1);
});
</script>

<template>
  <div class="signatures-page">
    <!-- 標題與說明由外層 TabbedPage 呈現,頁內只留版本、收集狀態與重新整理列 -->
    <section v-if="s.info || s.canRefresh" class="status-bar glass">
      <div v-if="availableInfo" class="status-item">
        <GIcon name="fingerprint" :size="15" />
        <span class="xs muted">威脅版本：</span>
        <strong class="mono xs">{{ availableInfo.threatVersion }}</strong>
        <span v-if="availableInfo.threatReleaseDate" class="xs muted">({{ availableInfo.threatReleaseDate }})</span>
        <GBadge v-if="availableInfo.stale" tone="warning" icon="alert">超過 2 小時沒更新</GBadge>
      </div>

      <div v-if="availableInfo" class="status-item">
        <GIcon name="clock" :size="15" />
        <span class="xs muted">快照時間：</span>
        <span class="mono xs">{{ fmtTime(availableInfo.fetchedAt) }}</span>
      </div>

      <!-- TS-Q4:AV / WildFire 第一版只顯示版本與發布時間,不讀清單 -->
      <div v-if="availableInfo?.versions.avVersion" class="status-item xs muted">
        <span>AV：</span>
        <span class="mono">{{ availableInfo.versions.avVersion }}</span>
        <span v-if="availableInfo.versions.avReleaseDate">({{ availableInfo.versions.avReleaseDate }})</span>
      </div>
      <div v-if="availableInfo?.versions.wildfireVersion" class="status-item xs muted">
        <span>WildFire：</span>
        <span class="mono">{{ availableInfo.versions.wildfireVersion }}</span>
        <span v-if="availableInfo.versions.wildfireReleaseDate">({{ availableInfo.versions.wildfireReleaseDate }})</span>
      </div>

      <div v-if="s.info?.status" class="status-item">
        <span class="xs muted">收集狀態：</span>
        <GBadge v-if="statusMeta" :tone="statusMeta.tone" dot>{{ statusMeta.label }}</GBadge>
        <span v-else class="xs muted">—</span>
        <span v-if="s.info.status.mgmtCpu != null" class="xs muted mono">
          管理平面 CPU {{ s.info.status.mgmtCpu }}%
        </span>
        <span v-if="s.info.status.message" class="xs muted">{{ s.info.status.message }}</span>
      </div>

      <div class="spacer" />

      <GButton
        v-if="s.canRefresh"
        size="sm"
        variant="primary"
        icon="refresh"
        :loading="s.refreshing"
        :disabled="localCooldown > 0"
        @click="onRefresh"
      >
        {{ localCooldown > 0 ? `重新整理 (${localCooldown}s)` : '重新整理' }}
      </GButton>
    </section>

    <GAlert v-if="s.refreshNotice" tone="info">{{ s.refreshNotice }}</GAlert>
    <GAlert v-if="availableInfo?.stale" tone="warning">
      威脅特徵碼快照已超過 2 小時沒更新，畫面資料可能不是 PA 上的最新內容版本。
    </GAlert>

    <GCard v-if="unavailableInfo" class="unavail-card">
      <GEmpty
        icon="fingerprint"
        title="目前無法取得威脅特徵碼快照"
        :description="unavailableInfo.message"
      />
    </GCard>

    <template v-else>
      <div class="tabs-bar">
        <GTabs v-model="activeTab" :items="tabItems" />
      </div>

      <SignatureListTab v-if="activeTab === 'list'" :sig="s" @open-signature="openSignature" />
      <SignatureVersionsTab v-else-if="activeTab === 'versions'" :sig="s" @open-signature="openSignature" />
      <SignatureHitsTab
        v-else-if="activeTab === 'hits'"
        :sig="s"
        :rule-linkable="ruleDrawer.linkable"
        @open-signature="openSignature"
        @open-rule="openRule"
      />
      <SignatureCoverageTab v-else-if="activeTab === 'coverage'" :sig="s" @open-rule="openRule" />
      <SignatureAiTab v-else-if="activeTab === 'ai'" :sig="s" />
    </template>

    <SignatureDrawer :drawer="sigDrawer" />
    <PolicyRuleDrawer :open="ruleDrawer.open" :policy="ruleDrawer.policy" @update:open="onRuleDrawerToggle" />
  </div>
</template>

<style scoped>
.signatures-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.status-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
}
.status-item {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.spacer {
  flex: 1;
}
.tabs-bar {
  display: flex;
  align-items: center;
}
.unavail-card {
  max-width: 640px;
  margin: 24px auto;
  width: 100%;
}
</style>
