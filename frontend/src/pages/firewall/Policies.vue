<script setup lang="ts">
/**
 * 防火牆 › 安全規則頁(PR-4;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3、§3.5、§3.6)。
 *   - 四個分頁:清單、變更紀錄、排序檢查、規則圖
 *   - 資料一律來自 usePaPolicy、usePaPolicyCheck、usePaPolicyViz(不直接呼叫 api/paPolicy,不自寫權限判斷)
 *   - 頁首顯示快照時間、過期警告(>2 小時)、收集狀態、管理平面 CPU 與手動重新整理(僅 canRefresh 顯示,含冷卻倒數)
 *   - p.info.available === false 時整頁以 GEmpty 顯示 p.info.message
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fmtTime } from '@/api/format';
import { describeError } from '@/api/gateway';
import PolicyChecksTab from '@/components/policies/PolicyChecksTab.vue';
import PolicyListTab from '@/components/policies/PolicyListTab.vue';
import PolicyRuleDrawer from '@/components/policies/PolicyRuleDrawer.vue';
import PolicyVersionsTab from '@/components/policies/PolicyVersionsTab.vue';
import PolicyVizTab from '@/components/policies/PolicyVizTab.vue';
import { COLLECTOR_STATE_META, type PolicyTab } from '@/components/policies/types';
import { usePaPolicy, type UsePaPolicyOptions } from '@/composables/usePaPolicy';
import { usePaPolicyCheck, type UsePaPolicyCheckOptions } from '@/composables/usePaPolicyCheck';
import { usePaPolicyViz } from '@/composables/usePaPolicyViz';
import { toast } from '@/ui';
import type { TabItem } from '@/ui/components/GTabs.vue';

const props = defineProps<{
  /** 元件測試 / 預覽用注入選項;正式頁面不傳入,使用真實後端與權限 */
  policyOptions?: UsePaPolicyOptions;
  checkOptions?: UsePaPolicyCheckOptions;
}>();

const p = usePaPolicy(props.policyOptions);
const c = usePaPolicyCheck(props.checkOptions);
const v = usePaPolicyViz(
  () => p.allRules,
  () => p.allDefaults,
  () => c.marks,
);

const activeTab = ref<PolicyTab>('list');
const drawerOpen = ref(false);

const versionsLoaded = ref(false);
const checksLoaded = ref(false);
const vizLoaded = ref(false);

const tabItems = computed<TabItem[]>(() => [
  { label: '清單', value: 'list', icon: 'list', count: p.info?.available ? p.total : undefined },
  { label: '變更紀錄', value: 'versions', icon: 'clock', count: versionsLoaded.value ? p.versions.length : undefined },
  { label: '排序檢查', value: 'checks', icon: 'spec', count: checksLoaded.value && c.summary ? c.items.length : undefined },
  { label: '規則圖', value: 'viz', icon: 'grid' },
]);

/* ───── 冷卻倒數(跟隨 p.cooldownSec,每秒遞減顯示) ───── */
const localCooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | undefined;

function clearCooldownTimer() {
  if (cooldownTimer !== undefined) {
    clearInterval(cooldownTimer);
    cooldownTimer = undefined;
  }
}

watch(
  () => p.cooldownSec,
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

const statusMeta = computed(() => {
  const st = p.info?.status?.state;
  if (!st) return null;
  return COLLECTOR_STATE_META[st] ?? { label: st, tone: 'neutral' };
});

// Omit<PolicyList, ...> 會把聯集壓平,在畫面層安全窄化欄位讀取
const availableInfo = computed(() => {
  const info = p.info as ({ available: true; fetchedAt: string; stale: boolean } | { available: false; message: string }) | null;
  return info && info.available ? info : null;
});
const unavailableInfo = computed(() => {
  const info = p.info as ({ available: true; fetchedAt: string; stale: boolean } | { available: false; message: string }) | null;
  return info && !info.available ? info : null;
});

async function onRefresh() {
  try {
    await p.refresh();
  } catch (e) {
    toast.error(describeError(e));
  }
}

function openRuleDrawer(name: string) {
  drawerOpen.value = true;
  void p.openRule(name);
}

watch(activeTab, (tab) => {
  if (tab === 'versions' && !versionsLoaded.value) {
    versionsLoaded.value = true;
    void p.loadVersions();
  } else if (tab === 'checks' && !checksLoaded.value) {
    checksLoaded.value = true;
    void c.load();
  } else if (tab === 'viz' && !vizLoaded.value) {
    vizLoaded.value = true;
    void p.loadAll();
  }
});

onMounted(() => {
  void p.load();
});
</script>

<template>
  <div class="policies-page">
    <!-- 標題與說明由外層 TabbedPage 呈現,頁內只留快照狀態與重新整理列(PR-FIX #1) -->
    <section v-if="p.info || p.canRefresh" class="status-bar glass">
      <div v-if="availableInfo" class="status-item">
        <GIcon name="clock" :size="15" />
        <span class="xs muted">快照時間：</span>
        <span class="mono xs">{{ fmtTime(availableInfo.fetchedAt) }}</span>
        <GBadge v-if="availableInfo.stale" tone="warning" icon="alert">超過 2 小時沒更新</GBadge>
      </div>

      <div v-if="p.info?.status" class="status-item">
        <span class="xs muted">收集狀態：</span>
        <GBadge v-if="statusMeta" :tone="statusMeta.tone" dot>{{ statusMeta.label }}</GBadge>
        <span v-else class="xs muted">—</span>
        <span v-if="p.info.status.mgmtCpu != null" class="xs muted mono">
          管理平面 CPU {{ p.info.status.mgmtCpu }}%
        </span>
        <span v-if="p.info.status.message" class="xs muted">{{ p.info.status.message }}</span>
      </div>

      <div class="spacer" />

      <GButton
        v-if="p.canRefresh"
        size="sm"
        variant="primary"
        icon="refresh"
        :loading="p.refreshing"
        :disabled="localCooldown > 0"
        @click="onRefresh"
      >
        {{ localCooldown > 0 ? `重新整理 (${localCooldown}s)` : '重新整理' }}
      </GButton>
    </section>

    <GAlert v-if="p.refreshNotice" tone="info">{{ p.refreshNotice }}</GAlert>
    <GAlert v-if="availableInfo?.stale" tone="warning">
      安全規則快照已超過 2 小時沒更新,畫面資料可能不是最新設定。
    </GAlert>

    <GCard v-if="unavailableInfo" class="unavail-card">
      <GEmpty
        icon="shield"
        title="目前無法取得安全規則快照"
        :description="unavailableInfo.message"
      />
    </GCard>

    <template v-else>
      <div class="tabs-bar">
        <GTabs v-model="activeTab" :items="tabItems" />
      </div>

      <PolicyListTab v-if="activeTab === 'list'" :policy="p" @open-rule="openRuleDrawer" />
      <PolicyVersionsTab v-else-if="activeTab === 'versions'" :policy="p" @open-rule="openRuleDrawer" />
      <PolicyChecksTab v-else-if="activeTab === 'checks'" :check="c" @open-rule="openRuleDrawer" />
      <PolicyVizTab v-else-if="activeTab === 'viz'" :policy="p" :viz="v" :check="c" @open-rule="openRuleDrawer" />
    </template>

    <PolicyRuleDrawer v-model:open="drawerOpen" :policy="p" />
  </div>
</template>

<style scoped>
.policies-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.status-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 20px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
}
.status-item {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
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
