<script setup lang="ts">
/**
 * 規則詳細抽屜(清單、排序檢查、規則圖三個分頁共用):
 *   - 顯示 p.detail.rule 與快照時間 p.detail.fetchedAt
 *   - 若 p.canNames 為 true,載入完成時自動呼叫 p.resolveNames(rule)
 */
import { computed, watch } from 'vue';
import { fmtNum, fmtTime } from '@/api/format';
import { ApiError, describeError } from '@/api/gateway';
import { PA_POLICY_ERRORS } from '@/api/paPolicy';
import PolicyObjectExpand from './PolicyObjectExpand.vue';
import { actionMeta, RULE_TYPE_LABELS, type PaPolicyStore } from './types';

const props = defineProps<{
  open: boolean;
  policy: PaPolicyStore;
}>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const rule = computed(() => props.policy.detail?.rule ?? null);
const title = computed(() => {
  if (rule.value) return `#${rule.value.position} ${rule.value.name}`;
  return '安全規則詳細';
});

const errorText = computed(() => {
  const err = props.policy.detailError;
  if (!err) return '';
  if (err instanceof ApiError && err.code === PA_POLICY_ERRORS.notFound) {
    return '找不到這條規則(可能已在 PA 上刪除或改名)';
  }
  return describeError(err);
});

watch(
  () => [props.open, rule.value?.name, props.policy.canNames] as const,
  ([isOpen, , canNames]) => {
    if (isOpen && rule.value && canNames) {
      void props.policy.resolveNames(rule.value);
    }
  },
  { immediate: true },
);

function onUpdate(v: boolean) {
  emit('update:open', v);
  if (!v) props.policy.closeRule();
}
</script>

<template>
  <GDrawer :modelValue="open" :title="title" width="640px" @update:modelValue="onUpdate">
    <template #actions>
      <GBadge v-if="rule" :tone="actionMeta(rule.action).tone">{{ actionMeta(rule.action).label }}</GBadge>
      <GBadge v-if="rule?.disabled" tone="neutral" variant="outline">停用</GBadge>
    </template>

    <GSkeleton v-if="policy.detailLoading" :rows="8" />
    <GAlert v-else-if="policy.detailError" tone="danger">{{ errorText }}</GAlert>

    <template v-else-if="rule && policy.detail">
      <div class="meta-bar xs muted">
        <span>快照時間：{{ fmtTime(policy.detail.fetchedAt) }}</span>
        <span v-if="rule.uuid" class="mono">UUID：{{ rule.uuid }}</span>
      </div>

      <GAlert v-if="policy.namesError" tone="warning">
        IP 對照查詢失敗,目前只顯示位址({{ describeError(policy.namesError) }})
      </GAlert>

      <section class="sec">
        <h3 class="sec-title">基本資訊</h3>
        <dl class="kv">
          <dt>編號 (Position)</dt>
          <dd class="mono">#{{ rule.position }}</dd>
          <dt>名稱 (Name)</dt>
          <dd class="mono">{{ rule.name }}</dd>
          <dt>類型 (Type)</dt>
          <dd>{{ RULE_TYPE_LABELS[rule.type] ?? rule.type }}</dd>
          <dt>標籤 (Tags)</dt>
          <dd>
            <div v-if="rule.tags.length" class="chips">
              <GBadge v-for="t in rule.tags" :key="t" tone="info" variant="soft">{{ t }}</GBadge>
            </div>
            <span v-else class="muted">—</span>
          </dd>
          <dt>群組標籤 (Group Tag)</dt>
          <dd>{{ rule.groupTag || '—' }}</dd>
          <dt>說明 (Description)</dt>
          <dd>{{ rule.description || '—' }}</dd>
        </dl>
      </section>

      <section class="sec">
        <h3 class="sec-title">來源 (Source)</h3>
        <dl class="kv">
          <dt>Source Zone</dt>
          <dd>
            <div class="chips">
              <GBadge v-for="z in rule.fromZones" :key="z" tone="primary" variant="outline" mono>{{ z }}</GBadge>
            </div>
          </dd>
          <dt>Source Address</dt>
          <dd>
            <PolicyObjectExpand
              :items="rule.expanded.sources"
              :rule="rule"
              :policy="policy"
              :negated="rule.negateSource"
              defaultExpanded
            />
          </dd>
          <dt>Source User</dt>
          <dd class="mono">{{ rule.sourceUsers.length ? rule.sourceUsers.join(', ') : '—' }}</dd>
          <dt>Source Device</dt>
          <dd class="mono">{{ rule.sourceDevices.length ? rule.sourceDevices.join(', ') : '—' }}</dd>
        </dl>
      </section>

      <section class="sec">
        <h3 class="sec-title">目的 (Destination)</h3>
        <dl class="kv">
          <dt>Destination Zone</dt>
          <dd>
            <div class="chips">
              <GBadge v-for="z in rule.toZones" :key="z" tone="cyan" variant="outline" mono>{{ z }}</GBadge>
            </div>
          </dd>
          <dt>Destination Address</dt>
          <dd>
            <PolicyObjectExpand
              :items="rule.expanded.destinations"
              :rule="rule"
              :policy="policy"
              :negated="rule.negateDestination"
              defaultExpanded
            />
          </dd>
          <dt>Destination Device</dt>
          <dd class="mono">{{ rule.destinationDevices.length ? rule.destinationDevices.join(', ') : '—' }}</dd>
        </dl>
      </section>

      <section class="sec">
        <h3 class="sec-title">應用與服務 (Application / Service)</h3>
        <dl class="kv">
          <dt>Application</dt>
          <dd>
            <div class="list-col">
              <div v-for="a in rule.expanded.applications" :key="a.name" class="exp-line">
                <span class="mono">{{ a.name }}</span>
                <span v-if="a.values.length" class="xs muted">→ {{ a.values.join(', ') }}</span>
              </div>
              <span v-if="!rule.expanded.applications.length" class="mono">{{ rule.applications.join(', ') || '—' }}</span>
            </div>
          </dd>
          <dt>Service</dt>
          <dd>
            <div class="list-col">
              <div v-for="s in rule.expanded.services" :key="s.name" class="exp-line">
                <span class="mono">{{ s.name }}</span>
                <span v-if="s.values.length" class="xs muted">→ {{ s.values.join(', ') }}</span>
              </div>
              <span v-if="!rule.expanded.services.length" class="mono">{{ rule.services.join(', ') || '—' }}</span>
            </div>
          </dd>
          <dt>URL Category</dt>
          <dd class="mono">{{ rule.categories.length ? rule.categories.join(', ') : '—' }}</dd>
        </dl>
      </section>

      <section class="sec">
        <h3 class="sec-title">處置、Profile 與選項</h3>
        <dl class="kv">
          <dt>Action</dt>
          <dd><GBadge :tone="actionMeta(rule.action).tone">{{ actionMeta(rule.action).label }}</GBadge></dd>
          <dt>Profile Group</dt>
          <dd class="mono">{{ rule.profileGroup || '—' }}</dd>
          <dt>個別 Profile</dt>
          <dd>
            <div v-if="Object.keys(rule.profiles).length" class="list-col">
              <div v-for="(vals, k) in rule.profiles" :key="k" class="xs">
                <span class="muted">{{ k }}：</span>
                <span class="mono">{{ vals.join(', ') }}</span>
              </div>
            </div>
            <span v-else class="muted">—</span>
          </dd>
          <dt>記錄選項 (Log)</dt>
          <dd class="chips">
            <GBadge :tone="rule.logStart ? 'info' : 'neutral'" variant="outline">
              Log at Start：{{ rule.logStart ? '開' : '關' }}
            </GBadge>
            <GBadge :tone="rule.logEnd ? 'success' : 'warning'" variant="outline">
              Log at End：{{ rule.logEnd ? '開' : '關' }}
            </GBadge>
            <GBadge v-if="rule.logSetting" tone="neutral" variant="soft" mono>{{ rule.logSetting }}</GBadge>
          </dd>
          <dt>排程 (Schedule)</dt>
          <dd class="mono">{{ rule.schedule || '—' }}</dd>
        </dl>
      </section>

      <section class="sec">
        <h3 class="sec-title">命中統計 (Rule Hit Count)</h3>
        <dl v-if="rule.hits" class="kv">
          <dt>命中次數</dt>
          <dd class="mono">{{ rule.hits.hitCount != null ? fmtNum(rule.hits.hitCount) : '—' }}</dd>
          <dt>最後命中</dt>
          <dd class="mono">{{ fmtTime(rule.hits.lastHit) }}</dd>
          <dt>首次命中</dt>
          <dd class="mono">{{ fmtTime(rule.hits.firstHit) }}</dd>
          <dt>最後重設</dt>
          <dd class="mono">{{ fmtTime(rule.hits.lastReset) }}</dd>
          <dt>規則建立</dt>
          <dd class="mono">{{ fmtTime(rule.hits.created) }}</dd>
          <dt>最後修改</dt>
          <dd class="mono">{{ fmtTime(rule.hits.modified) }}</dd>
        </dl>
        <p v-else class="xs muted">無命中統計資料</p>
      </section>
    </template>
  </GDrawer>
</template>

<style scoped>
.meta-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}
.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.sec-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--text);
}
.kv {
  margin: 0;
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  gap: 8px 12px;
  font-size: var(--fs-sm);
}
.kv dt {
  color: var(--text-2);
  font-weight: 600;
}
.kv dd {
  margin: 0;
  min-width: 0;
  word-break: break-word;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.list-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.exp-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
}
@media (max-width: 560px) {
  .kv {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
