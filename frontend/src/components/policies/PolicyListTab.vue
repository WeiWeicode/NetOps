<script setup lang="ts">
/**
 * 防火牆 › 安全規則 — 分頁 1:清單(PR-4)
 *   - 篩選:關鍵字 q、zone、IP(ipError 不送出)、含 any 勾選、應用、動作、長期未命中 N 天、停用
 *   - 僅 p.canNames 為 true 時顯示「用姓名 / 部門 / 設備找規則」→ p.findByName(keyword)
 *   - 仿 PA GUI 分組表格:基本、來源(Zone / 位址 / 使用者 / 裝置)、目的(Zone / 位址 / 裝置)、應用 / 服務、動作 / Profile / 選項、命中統計
 *   - 停用規則淡色;negateSource / negateDestination 標「反向」;物件可展開並附 IP 對照
 *   - 表格下方列出預設規則 p.defaults(intrazone-default / interzone-default)
 */
import { computed, reactive, ref } from 'vue';
import { fmtNum, fmtTime } from '@/api/format';
import { describeError } from '@/api/gateway';
import type { ExpandedApplication, ExpandedService, PolicyRule } from '@/api/paPolicy';
import { toast } from '@/ui';
import PolicyObjectExpand from './PolicyObjectExpand.vue';
import { actionMeta, RULE_TYPE_LABELS, type PaPolicyStore } from './types';

const props = defineProps<{
  policy: PaPolicyStore;
}>();
const emit = defineEmits<{ (e: 'open-rule', name: string): void }>();

const ACTION_OPTIONS = [
  { label: '允許 (allow)', value: 'allow' },
  { label: '拒絕 (deny)', value: 'deny' },
  { label: '丟棄 (drop)', value: 'drop' },
  { label: '重設用戶端 (reset-client)', value: 'reset-client' },
  { label: '重設伺服器 (reset-server)', value: 'reset-server' },
  { label: '雙向重設 (reset-both)', value: 'reset-both' },
];
const DISABLED_OPTIONS = [
  { label: '僅啟用', value: 'false' },
  { label: '僅停用', value: 'true' },
];

const actionModel = computed({
  get: () => props.policy.filters.action ?? '',
  set: (v: string) => {
    props.policy.filters.action = v || undefined;
  },
});
const disabledModel = computed({
  get: () => (props.policy.filters.disabled === undefined ? '' : String(props.policy.filters.disabled)),
  set: (v: string) => {
    props.policy.filters.disabled = v === '' ? undefined : v === 'true';
  },
});
const unusedDaysModel = computed({
  get: () => (props.policy.filters.unusedDays != null ? String(props.policy.filters.unusedDays) : ''),
  set: (v: string) => {
    const n = Number(v);
    props.policy.filters.unusedDays = v.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  },
});
const includeAnyModel = computed({
  get: () => Boolean(props.policy.filters.includeAny),
  set: (v: boolean) => {
    props.policy.filters.includeAny = v || undefined;
  },
});

const nameKeyword = ref('');
const nameSearchLoading = ref(false);
const nameSearchNotice = ref<string | null>(null);

async function onSearch() {
  if (props.policy.ipError) {
    toast.warning(props.policy.ipError);
    return;
  }
  nameSearchNotice.value = null;
  await props.policy.load();
}

async function onFindByName() {
  const kw = nameKeyword.value.trim();
  if (!kw) return;
  nameSearchLoading.value = true;
  nameSearchNotice.value = null;
  try {
    const res = await props.policy.findByName(kw);
    if (!res) return;
    if (res.matched === 0) {
      nameSearchNotice.value = `IP 對照表查無符合「${kw}」的項目`;
    } else if (res.truncated) {
      nameSearchNotice.value = `符合的對照太多(共 ${fmtNum(res.matched)} 筆),只用前 50 個 IP 篩選`;
    } else {
      nameSearchNotice.value = `已依對照表符合的 ${fmtNum(res.matched)} 筆 IP 篩選規則`;
    }
  } catch (e) {
    toast.error(describeError(e));
  } finally {
    nameSearchLoading.value = false;
  }
}

function onReset() {
  props.policy.filters.q = undefined;
  props.policy.filters.zone = undefined;
  props.policy.filters.ip = undefined;
  props.policy.filters.includeAny = undefined;
  props.policy.filters.application = undefined;
  props.policy.filters.action = undefined;
  props.policy.filters.unusedDays = undefined;
  props.policy.filters.disabled = undefined;
  nameKeyword.value = '';
  nameSearchNotice.value = null;
  void props.policy.load();
}

const expandedOther = reactive(new Set<string>());
function toggleOther(key: string) {
  if (expandedOther.has(key)) expandedOther.delete(key);
  else expandedOther.add(key);
}

function profileSummary(r: PolicyRule): string[] {
  if (r.profileGroup) return [`Group: ${r.profileGroup}`];
  const entries = Object.entries(r.profiles).filter(([, v]) => v.length > 0);
  if (!entries.length) return [];
  return entries.map(([k, v]) => `${k}: ${v.join(', ')}`);
}

function appItems(r: PolicyRule): ExpandedApplication[] {
  return r.expanded.applications.length
    ? r.expanded.applications
    : r.applications.map((name) => ({ name, kind: name === 'any' ? 'any' : 'application', values: [] }));
}

function svcItems(r: PolicyRule): ExpandedService[] {
  return r.expanded.services.length
    ? r.expanded.services
    : r.services.map((name) => ({ name, kind: name === 'any' ? 'any' : 'service', values: [] }));
}
</script>

<template>
  <div class="list-tab">
    <GCard class="filter-card">
      <form class="filter-grid" @submit.prevent="onSearch">
        <GInput
          :modelValue="policy.filters.q ?? ''"
          label="關鍵字"
          placeholder="規則名稱 / 說明 / 標籤"
          icon="search"
          clearable
          @update:modelValue="(v) => (policy.filters.q = String(v) || undefined)"
        />
        <GInput
          :modelValue="policy.filters.zone ?? ''"
          label="Zone"
          placeholder="例: trust、untrust"
          clearable
          @update:modelValue="(v) => (policy.filters.zone = String(v) || undefined)"
        />
        <GInput
          :modelValue="policy.filters.ip ?? ''"
          label="IP / 網段"
          placeholder="IPv4、CIDR 或 a-b,逗號分隔"
          :error="policy.ipError"
          clearable
          @update:modelValue="(v) => (policy.filters.ip = String(v) || undefined)"
        />
        <GInput
          :modelValue="policy.filters.application ?? ''"
          label="應用 (Application)"
          placeholder="例: ssl、web-browsing"
          clearable
          @update:modelValue="(v) => (policy.filters.application = String(v) || undefined)"
        />
        <GSelect v-model="actionModel" label="動作 (Action)" placeholder="全部動作" :options="ACTION_OPTIONS" />
        <GInput
          v-model="unusedDaysModel"
          label="長期未命中 (天)"
          type="number"
          placeholder="例: 90"
          clearable
        />
        <GSelect v-model="disabledModel" label="啟用狀態" placeholder="全部" :options="DISABLED_OPTIONS" />

        <div class="filter-actions">
          <GCheckbox v-model="includeAnyModel" label="IP 篩選含 any" />
          <div class="btn-row">
            <GButton type="submit" variant="primary" icon="search" :loading="policy.loading" :disabled="!!policy.ipError">
              查詢
            </GButton>
            <GButton type="button" variant="ghost" icon="reset" :disabled="policy.loading" @click="onReset">
              清除
            </GButton>
          </div>
        </div>
      </form>

      <div v-if="policy.canNames" class="name-search">
        <GInput
          v-model="nameKeyword"
          label="用姓名 / 部門 / 設備找規則"
          placeholder="輸入姓名、部門或設備名稱(經 IP 對照表反查,不進網址)"
          icon="users"
          clearable
          @keydown.enter.prevent="onFindByName"
        />
        <GButton
          type="button"
          variant="secondary"
          icon="search"
          :loading="nameSearchLoading"
          :disabled="!nameKeyword.trim()"
          class="name-btn"
          @click="onFindByName"
        >
          依名稱找規則
        </GButton>
      </div>

      <GAlert v-if="nameSearchNotice" tone="info" class="mt-2">{{ nameSearchNotice }}</GAlert>
      <GAlert v-if="policy.namesError" tone="warning" class="mt-2">
        IP 對照查詢失敗,不影響規則顯示({{ describeError(policy.namesError) }})
      </GAlert>
      <GAlert v-if="policy.error" tone="danger" class="mt-2">{{ describeError(policy.error) }}</GAlert>
    </GCard>

    <GCard class="table-card" padding="none">
      <div class="table-head">
        <span class="small muted">
          共 <strong class="mono">{{ fmtNum(policy.total) }}</strong> 條規則(依 PA 比對順序排列,篩選後仍顯示原編號)
        </span>
      </div>

      <GSkeleton v-if="policy.loading && !policy.rules.length" :rows="8" class="pad" />

      <GEmpty
        v-else-if="!policy.loading && !policy.rules.length"
        icon="filter"
        title="查無符合條件的規則"
        description="請調整篩選條件後再查詢。"
        class="pad"
      />

      <div v-else class="pa-table-scroll">
        <table class="pa-table">
          <thead>
            <tr class="grp-row">
              <th colspan="2" class="grp-basic">基本</th>
              <th colspan="4" class="grp-src">來源 (Source)</th>
              <th colspan="3" class="grp-dst">目的 (Destination)</th>
              <th colspan="2" class="grp-app">應用與服務</th>
              <th colspan="3" class="grp-act">處置與選項</th>
              <th colspan="2" class="grp-hit">命中統計</th>
            </tr>
            <tr class="col-row">
              <th class="col-pos">#</th>
              <th class="col-name">名稱 / 標籤 / 類型</th>
              <th class="col-zone">Zone</th>
              <th class="col-addr">位址 (Address)</th>
              <th class="col-user">使用者</th>
              <th class="col-dev">裝置</th>
              <th class="col-zone">Zone</th>
              <th class="col-addr">位址 (Address)</th>
              <th class="col-dev">裝置</th>
              <th class="col-app">應用</th>
              <th class="col-svc">服務</th>
              <th class="col-action">動作</th>
              <th class="col-prof">Profile</th>
              <th class="col-opt">選項</th>
              <th class="col-hits num">命中數</th>
              <th class="col-lasthit">最後命中</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in policy.rules"
              :key="r.name"
              class="rule-row"
              :class="{ 'is-disabled': r.disabled }"
              @click="emit('open-rule', r.name)"
            >
              <td class="mono col-pos">
                <div class="pos-cell">
                  <span>{{ r.position }}</span>
                  <GBadge v-if="r.ipMatch === 'maybe'" tone="warning" variant="outline" class="mini">需確認</GBadge>
                </div>
              </td>
              <td class="col-name">
                <button type="button" class="name-link mono" @click.stop="emit('open-rule', r.name)">
                  {{ r.name }}
                </button>
                <div class="sub-meta">
                  <GBadge v-if="r.disabled" tone="neutral" variant="outline" class="mini">停用</GBadge>
                  <span class="xs faint">{{ RULE_TYPE_LABELS[r.type] ?? r.type }}</span>
                  <GBadge v-for="t in r.tags" :key="t" tone="info" variant="soft" class="mini">{{ t }}</GBadge>
                </div>
              </td>
              <td class="col-zone">
                <div class="chips">
                  <GBadge v-for="z in r.fromZones" :key="z" tone="primary" variant="outline" mono class="mini">{{ z }}</GBadge>
                </div>
              </td>
              <td class="col-addr">
                <PolicyObjectExpand
                  :items="r.expanded.sources"
                  :rule="r"
                  :policy="policy"
                  :negated="r.negateSource"
                />
              </td>
              <td class="col-user xs mono">{{ r.sourceUsers.length ? r.sourceUsers.join(', ') : '—' }}</td>
              <td class="col-dev xs mono">{{ r.sourceDevices.length ? r.sourceDevices.join(', ') : '—' }}</td>
              <td class="col-zone">
                <div class="chips">
                  <GBadge v-for="z in r.toZones" :key="z" tone="cyan" variant="outline" mono class="mini">{{ z }}</GBadge>
                </div>
              </td>
              <td class="col-addr">
                <PolicyObjectExpand
                  :items="r.expanded.destinations"
                  :rule="r"
                  :policy="policy"
                  :negated="r.negateDestination"
                />
              </td>
              <td class="col-dev xs mono">{{ r.destinationDevices.length ? r.destinationDevices.join(', ') : '—' }}</td>
              <td class="col-app">
                <div v-for="a in appItems(r)" :key="a.name" class="other-item">
                  <button
                    v-if="a.values.length"
                    type="button"
                    class="exp-btn mono"
                    @click.stop="toggleOther(`app:${r.name}:${a.name}`)"
                  >
                    <GIcon :name="expandedOther.has(`app:${r.name}:${a.name}`) ? 'chevron-down' : 'chevron-right'" :size="12" />
                    {{ a.name }}
                  </button>
                  <span v-else class="xs mono">{{ a.name }}</span>
                  <div v-if="a.values.length && expandedOther.has(`app:${r.name}:${a.name}`)" class="exp-vals xs mono" @click.stop>
                    {{ a.values.join(', ') }}
                  </div>
                </div>
              </td>
              <td class="col-svc">
                <div v-for="s in svcItems(r)" :key="s.name" class="other-item">
                  <button
                    v-if="s.values.length"
                    type="button"
                    class="exp-btn mono"
                    @click.stop="toggleOther(`svc:${r.name}:${s.name}`)"
                  >
                    <GIcon :name="expandedOther.has(`svc:${r.name}:${s.name}`) ? 'chevron-down' : 'chevron-right'" :size="12" />
                    {{ s.name }}
                  </button>
                  <span v-else class="xs mono">{{ s.name }}</span>
                  <div v-if="s.values.length && expandedOther.has(`svc:${r.name}:${s.name}`)" class="exp-vals xs mono" @click.stop>
                    {{ s.values.join(', ') }}
                  </div>
                </div>
              </td>
              <td class="col-action">
                <GBadge :tone="actionMeta(r.action).tone">{{ r.action }}</GBadge>
              </td>
              <td class="col-prof xs">
                <div v-if="profileSummary(r).length" class="prof-list">
                  <span v-for="pText in profileSummary(r)" :key="pText" class="mono">{{ pText }}</span>
                </div>
                <span v-else class="faint">—</span>
              </td>
              <td class="col-opt">
                <div class="chips">
                  <GBadge v-if="r.logStart" tone="info" variant="outline" class="mini">LogStart</GBadge>
                  <GBadge v-if="r.logEnd" tone="success" variant="outline" class="mini">LogEnd</GBadge>
                  <GBadge v-if="r.logSetting" tone="neutral" variant="soft" mono class="mini">{{ r.logSetting }}</GBadge>
                  <GBadge v-if="r.schedule" tone="warning" variant="outline" mono class="mini">{{ r.schedule }}</GBadge>
                  <span v-if="!r.logStart && !r.logEnd && !r.logSetting && !r.schedule" class="xs faint">—</span>
                </div>
              </td>
              <td class="col-hits num mono">
                {{ r.hits && r.hits.hitCount != null ? fmtNum(r.hits.hitCount) : '—' }}
              </td>
              <td class="col-lasthit xs mono">
                {{ r.hits ? fmtTime(r.hits.lastHit) : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </GCard>

    <GCard v-if="policy.defaults.length" class="defaults-card">
      <div class="defaults-head">
        <h3>預設規則 (Default Rules)</h3>
        <span class="xs muted">PA 內建最後兩條規則(僅提供命中數,不含規則條件內容)</span>
      </div>
      <div class="defaults-grid">
        <div v-for="d in policy.defaults" :key="d.name" class="def-item">
          <div class="def-top">
            <span class="mono def-name">{{ d.name }}</span>
            <GBadge :tone="d.name === 'intrazone-default' ? 'success' : 'danger'" variant="soft">
              {{ d.name === 'intrazone-default' ? '預設允許' : '預設拒絕' }}
            </GBadge>
          </div>
          <div class="def-stats xs">
            <span>命中數：<strong class="mono">{{ d.hitCount != null ? fmtNum(d.hitCount) : '—' }}</strong></span>
            <span>最後命中：<span class="mono">{{ fmtTime(d.lastHit) }}</span></span>
          </div>
        </div>
      </div>
    </GCard>
  </div>
</template>

<style scoped>
.list-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
  align-items: end;
}
.filter-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: flex-end;
}
.btn-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.name-search {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--line);
  display: flex;
  gap: 10px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.name-search > :first-child {
  flex: 1 1 280px;
}
.name-btn {
  flex: none;
}
.mt-2 {
  margin-top: 12px;
}
.table-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.pad {
  padding: 20px;
}
.pa-table-scroll {
  width: 100%;
  overflow-x: auto;
}
.pa-table {
  width: 100%;
  min-width: 1280px;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}
.pa-table th,
.pa-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
.grp-row th {
  font-size: var(--fs-xs);
  font-weight: 700;
  text-align: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  border-right: 1px solid var(--line);
  background: var(--glass-soft);
}
.grp-row th:last-child {
  border-right: 0;
}
.grp-src {
  color: var(--c-primary-text);
}
.grp-dst {
  color: var(--c-cyan);
}
.col-row th {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
  background: color-mix(in srgb, var(--glass-soft) 70%, transparent);
}
.rule-row {
  cursor: pointer;
  transition: background var(--dur);
}
.rule-row:hover {
  background: var(--glass-hover);
}
.rule-row.is-disabled {
  opacity: 0.52;
  background: color-mix(in srgb, var(--text-3) 5%, transparent);
}
.col-pos {
  width: 56px;
  white-space: nowrap;
}
.pos-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.col-name {
  min-width: 180px;
}
.name-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  word-break: break-all;
}
.name-link:hover {
  text-decoration: underline;
}
.sub-meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.col-zone {
  min-width: 90px;
}
.col-addr {
  min-width: 160px;
}
.col-hits {
  white-space: nowrap;
  text-align: right;
}
.col-lasthit {
  white-space: nowrap;
}
.num {
  text-align: right;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mini {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
}
.other-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 2px;
}
.exp-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 4px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--glass-soft);
  color: var(--text);
  font-size: var(--fs-xs);
  cursor: pointer;
  align-self: flex-start;
}
.exp-vals {
  margin-left: 10px;
  color: var(--text-2);
  word-break: break-all;
}
.prof-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.defaults-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}
.defaults-head h3 {
  margin: 0;
  font-size: var(--fs-md);
}
.defaults-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.def-item {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.def-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.def-name {
  font-weight: 600;
}
.def-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  color: var(--text-2);
}
</style>
