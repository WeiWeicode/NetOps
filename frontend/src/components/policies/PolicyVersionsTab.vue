<script setup lang="ts">
/**
 * 防火牆 › 安全規則 — 分頁 2:變更紀錄(PR-4)
 *   - 版本清單 p.versions(savedAt / fetchedAt / ruleCount),註明「收集器讀到的時間,不是 PA Commit 時間」
 *   - 選版本呼叫 p.openDiff(id),並可選擇比較基準版本 p.openDiff(id, baseId)
 *   - 顯示 p.diff.rules(added / removed / moved / changed,含 fields[].field / before / after)與 p.diff.objects
 *   - p.diff.baseId === null 時顯示「這是第一個版本,沒有可比較的前一版」
 */
import { computed, ref, watch } from 'vue';
import { fmtNum, fmtTime } from '@/api/format';
import { ApiError, describeError } from '@/api/gateway';
import { PA_POLICY_ERRORS, type ObjectChange } from '@/api/paPolicy';
import { OBJECT_KIND_LABELS, RULE_CHANGE_META, type PaPolicyStore } from './types';

const props = defineProps<{
  policy: PaPolicyStore;
}>();
const emit = defineEmits<{ (e: 'open-rule', name: string): void }>();

const selectedId = ref<string>('');
const baseId = ref<string>('');

const baseOptions = computed(() =>
  props.policy.versions
    .filter((v) => v.id !== selectedId.value)
    .map((v) => ({
      value: v.id,
      label: `${fmtTime(v.savedAt)} (${fmtNum(v.ruleCount)} 條)`,
    })),
);

const diffErrorText = computed(() => {
  const err = props.policy.diffError;
  if (!err) return '';
  if (err instanceof ApiError && err.code === PA_POLICY_ERRORS.versionNotFound) {
    return '找不到指定的版本(系統只保留最近 50 份快照)';
  }
  return describeError(err);
});

watch(
  () => props.policy.versions,
  (list) => {
    if (list.length && !selectedId.value) {
      selectVersion(list[0]!.id);
    }
  },
  { immediate: true },
);

function selectVersion(id: string) {
  selectedId.value = id;
  baseId.value = '';
  void props.policy.openDiff(id);
}

function onBaseChange(v: string) {
  baseId.value = v;
  if (selectedId.value) {
    void props.policy.openDiff(selectedId.value, v || undefined);
  }
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : '(空)';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const nonEmptyObjects = computed<ObjectChange[]>(() =>
  (props.policy.diff?.objects ?? []).filter((o) => o.added.length || o.removed.length || o.changed.length),
);
</script>

<template>
  <div class="ver-tab">
    <GAlert tone="info">
      版本時間是<strong>收集器讀到的時間,不是 PA Commit 時間</strong>(規則內容雜湊有變動時才會存成新版本,系統最多保留最近 50 份)。
    </GAlert>

    <GAlert v-if="policy.versionsError" tone="danger">{{ describeError(policy.versionsError) }}</GAlert>

    <div class="ver-layout">
      <GCard class="ver-list-card" padding="none">
        <header class="card-head">
          <h3>快照版本清單</h3>
          <GButton size="sm" variant="ghost" icon="refresh" :loading="policy.versionsLoading" @click="policy.loadVersions()">
            重整清單
          </GButton>
        </header>

        <GSkeleton v-if="policy.versionsLoading && !policy.versions.length" :rows="6" class="pad" />
        <GEmpty
          v-else-if="!policy.versions.length"
          icon="clock"
          title="尚無版本紀錄"
          description="收集器尚未儲存任何規則快照版本。"
          class="pad"
        />
        <ul v-else class="ver-list">
          <li v-for="v in policy.versions" :key="v.id">
            <button
              type="button"
              class="ver-item"
              :class="{ active: selectedId === v.id }"
              @click="selectVersion(v.id)"
            >
              <div class="ver-top">
                <span class="mono ver-time">{{ fmtTime(v.savedAt) }}</span>
                <GBadge tone="primary" variant="soft">{{ fmtNum(v.ruleCount) }} 條</GBadge>
              </div>
              <div class="xs muted ver-sub">
                <span>讀取時間：{{ fmtTime(v.fetchedAt) }}</span>
                <span class="mono">{{ v.hash.slice(0, 8) }}</span>
              </div>
            </button>
          </li>
        </ul>
      </GCard>

      <GCard class="diff-card">
        <header class="diff-head">
          <div>
            <h3>版本差異</h3>
            <p v-if="policy.diff" class="xs muted">
              目標版本：{{ fmtTime(policy.diff.version.savedAt) }}
              <template v-if="policy.diff.base">
                · 比較基準：{{ fmtTime(policy.diff.base.savedAt) }}
              </template>
            </p>
          </div>
          <div v-if="selectedId && baseOptions.length" class="base-picker">
            <GSelect
              :modelValue="baseId"
              label="比較基準版本"
              placeholder="預設(前一版)"
              :options="baseOptions"
              @update:modelValue="onBaseChange"
            />
          </div>
        </header>

        <GSkeleton v-if="policy.diffLoading" :rows="6" />
        <GAlert v-else-if="policy.diffError" tone="danger">{{ diffErrorText }}</GAlert>
        <GEmpty
          v-else-if="!policy.diff"
          icon="audit"
          title="請選擇左側版本"
          description="點擊版本清單中的任一快照以檢視規則與物件變更。"
        />
        <template v-else>
          <GAlert v-if="policy.diff.baseId === null" tone="info">
            這是第一個版本,沒有可比較的前一版。
          </GAlert>

          <template v-else>
            <section class="diff-sec">
              <h4>規則變更 ({{ policy.diff.rules.length }})</h4>
              <GEmpty
                v-if="!policy.diff.rules.length"
                icon="check-circle"
                title="沒有規則變更"
                description="兩個版本之間的安全規則順序與欄位完全相同。"
              />
              <div v-else class="rule-changes">
                <article v-for="rc in policy.diff.rules" :key="`${rc.kind}-${rc.name}`" class="rc-item">
                  <div class="rc-head">
                    <GBadge :tone="RULE_CHANGE_META[rc.kind].tone">{{ RULE_CHANGE_META[rc.kind].label }}</GBadge>
                    <button
                      v-if="rc.kind !== 'removed'"
                      type="button"
                      class="name-btn mono"
                      @click="emit('open-rule', rc.name)"
                    >
                      {{ rc.name }}
                    </button>
                    <span v-else class="mono removed-name">{{ rc.name }}</span>
                    <span class="xs muted mono pos-info">
                      <template v-if="rc.kind === 'moved'">
                        #{{ rc.basePosition }} → #{{ rc.position }}
                      </template>
                      <template v-else-if="rc.position != null">
                        #{{ rc.position }}
                        <template v-if="rc.basePosition != null && rc.basePosition !== rc.position">
                          (原 #{{ rc.basePosition }})
                        </template>
                      </template>
                      <template v-else-if="rc.basePosition != null">
                        原 #{{ rc.basePosition }}
                      </template>
                    </span>
                  </div>

                  <div v-if="rc.fields?.length" class="field-diffs">
                    <div v-for="f in rc.fields" :key="f.field" class="field-row xs">
                      <span class="field-name mono">{{ f.field }}</span>
                      <span class="val-before mono">- {{ formatVal(f.before) }}</span>
                      <span class="val-after mono">+ {{ formatVal(f.after) }}</span>
                    </div>
                  </div>
                </article>
              </div>
            </section>

            <section class="diff-sec">
              <h4>物件變更 ({{ nonEmptyObjects.length }} 類)</h4>
              <p v-if="!nonEmptyObjects.length" class="xs muted">兩個版本之間沒有位址、服務、應用或標籤物件變動。</p>
              <div v-else class="obj-changes">
                <div v-for="oc in nonEmptyObjects" :key="oc.kind" class="oc-card">
                  <div class="oc-title">{{ OBJECT_KIND_LABELS[oc.kind] }}</div>
                  <div v-if="oc.added.length" class="oc-line xs">
                    <GBadge tone="success" variant="soft">新增</GBadge>
                    <span class="mono">{{ oc.added.join(', ') }}</span>
                  </div>
                  <div v-if="oc.changed.length" class="oc-line xs">
                    <GBadge tone="warning" variant="soft">修改</GBadge>
                    <span class="mono">{{ oc.changed.join(', ') }}</span>
                  </div>
                  <div v-if="oc.removed.length" class="oc-line xs">
                    <GBadge tone="danger" variant="soft">刪除</GBadge>
                    <span class="mono">{{ oc.removed.join(', ') }}</span>
                  </div>
                </div>
              </div>
            </section>
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
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 900px) {
  .ver-layout {
    grid-template-columns: 1fr;
  }
}
.card-head {
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-head h3 {
  margin: 0;
  font-size: var(--fs-md);
}
.pad {
  padding: 16px;
}
.ver-list {
  list-style: none;
  margin: 0;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 620px;
  overflow-y: auto;
}
.ver-item {
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background var(--dur), border-color var(--dur);
}
.ver-item:hover {
  background: var(--glass-hover);
}
.ver-item.active {
  background: color-mix(in srgb, var(--c-primary) 10%, var(--glass-soft));
  border-color: color-mix(in srgb, var(--c-primary) 45%, var(--line));
}
.ver-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ver-time {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.ver-sub {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.diff-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
  padding-bottom: 12px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.diff-head h3 {
  margin: 0;
  font-size: var(--fs-lg);
}
.diff-head p {
  margin: 4px 0 0;
}
.base-picker {
  min-width: 240px;
}
.diff-sec {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.diff-sec:first-of-type {
  margin-top: 0;
}
.diff-sec h4 {
  margin: 0;
  font-size: var(--fs-md);
}
.rule-changes {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rc-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rc-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.name-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  font-weight: 600;
  cursor: pointer;
}
.name-btn:hover {
  text-decoration: underline;
}
.removed-name {
  text-decoration: line-through;
  color: var(--text-2);
}
.pos-info {
  margin-left: auto;
}
.field-diffs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 8px;
  border-left: 2px solid var(--line);
}
.field-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.field-name {
  font-weight: 600;
  color: var(--text-2);
}
.val-before {
  color: var(--c-danger);
  word-break: break-all;
}
.val-after {
  color: var(--c-success);
  word-break: break-all;
}
.obj-changes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.oc-card {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.oc-title {
  font-weight: 600;
  font-size: var(--fs-sm);
}
.oc-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
