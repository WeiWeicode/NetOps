<script setup lang="ts">
/**
 * 防火牆 › 安全事件(docs/API.md §4.2;舊版 src/views/PaEvents.vue):
 *   PA-560 TRAFFIC 以外的 log(威脅、URL 過濾、資料過濾、WildFire、解密、GlobalProtect、User-ID),每種類型一個分段:
 *   KPI、每小時事件數、排行;資料來自 FTP 各類型目錄,「FTP Log 檔案」同步分析後才有。?type= 記住目前類型。
 *   點排行中含 IP 的項目 → 到 AI 問答並帶入問題(由使用者送出;IMPL-PLAN A1)。沒有 AI 問答權限時不可點。
 *   分析中、摘要讀不到的檔案(missing)都要提示結果不完整(AGENT.md §5)。
 *   AC6「AI 摘要安全事件」(按鈕權限 netops.pa-events.ai):目前期間的威脅、URL 過濾、資料過濾、WildFire 四類一起摘要
 *   (只送期間;後端自己取四類總覽統計,docs/API.md §10.3 kind: events)。回答下方列出四類筆數,點了切換到該類型。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { can, describeError } from '@/api/gateway';
import { fmtNum, fmtShort, fmtTime } from '@/api/format';
import { paEvents, type PaEventOverview, type PaEventType } from '@/api/paEvents';
import TopList from '@/components/TopList.vue';
import DateRangeField from '@/components/DateRangeField.vue';
import { coverageText } from '@/composables/dateRange';
import { checkDayRange } from '@/composables/dates';
import { UI } from '@/api/perms';
import { askLink } from '@/composables/aiChat';
import type { ExplainEventType, ExplainInput, ExplainMeta } from '@/api/ai';
import AiExplainPanel from '@/components/AiExplainPanel.vue';
import { EVENT_TYPE_LABELS } from '@/composables/useAiExplain';

const MAX_DAYS = 92;
const route = useRoute();
const router = useRouter();

// ---------- 類型 ----------
const types = ref<PaEventType[]>([]);
const typesError = ref<Error | null>(null);
const typesLoading = ref(false);
const type = ref(typeof route.query.type === 'string' ? route.query.type : '');
const current = computed(() => types.value.find((t) => t.type === type.value));
const typeOptions = computed(() => types.value.map((t) => ({ label: `${t.label}${t.rows ? `(${fmtShort(t.rows)})` : ''}`, value: t.type })));

async function loadTypes() {
  typesLoading.value = true;
  try {
    types.value = (await paEvents.types()).types;
    typesError.value = null;
    if (!current.value && types.value.length) type.value = types.value[0]!.type;
    else resetRange(false);
  } catch (e) {
    typesError.value = e as Error;
  } finally {
    typesLoading.value = false;
  }
}

// ---------- 期間 ----------
const range = reactive({ from: '', to: '' });
/** 換類型:預設該類型最新一天(force = false 時已選的期間保留,重新整理用) */
function resetRange(force = true) {
  const days = current.value?.days ?? [];
  if (!force && range.from && days.length) return;
  const d = days[0] ?? '';
  Object.assign(range, { from: d, to: d });
  if (!d) data.value = null;
}
const rangeCheck = computed(() => checkDayRange(range.from, range.to, !!current.value?.days.length, MAX_DAYS));
const rangeError = computed(() => rangeCheck.value.error);
watch(type, (t) => {
  if (route.query.type !== t) void router.replace({ query: { ...route.query, type: t } });
  // 換類型:丟掉舊類型的資料與進行中的請求,避免標題已換、內容還是舊類型
  seq++;
  data.value = null;
  loadError.value = null;
  loading.value = false;
  resetRange();
});

// ---------- 摘要 ----------
const data = shallowRef<PaEventOverview | null>(null);
const loading = ref(false);
const loadError = ref<Error | null>(null);
let seq = 0;

async function load() {
  if (!type.value) return;
  // 期間無效或沒有已分析資料(期間空白)時不送出,也不顯示舊期間的結果
  if (!rangeCheck.value.ok) {
    seq++;
    data.value = null;
    loading.value = false;
    return;
  }
  const my = ++seq;
  loading.value = true;
  loadError.value = null;
  try {
    const r = await paEvents.overview(type.value, range.from, range.to);
    if (my === seq) data.value = r;
  } catch (e) {
    if (my === seq) loadError.value = e as Error;
  } finally {
    if (my === seq) loading.value = false;
  }
}
// 改類型或日期時稍等再送出(期間最長 92 天,連續修改不要每次都送)
const DEBOUNCE_MS = 300;
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [type.value, range.from, range.to],
  () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, DEBOUNCE_MS);
  },
);
onBeforeUnmount(() => clearTimeout(debounce));

const incomplete = computed(() => {
  const d = data.value;
  if (!d) return '';
  // ClickHouse 類型(C3 D43):排行來自每小時摘要;FTP 類型(解密、GlobalProtect、User-ID):已分析的檔案
  const why =
    d.source === 'clickhouse'
      ? [
          d.topsState === 'not-ready' ? '服務剛啟動,統計還在建立' : '',
          d.topsState === 'stale' ? '統計太久沒更新(ClickHouse 可能停止)' : '',
          d.missing ? `${d.missing} 小時的統計還沒建好` : '',
        ]
      : [d.import.busy ? '分析進行中' : '', d.missing ? `${d.missing} 個已分析的檔案讀不到摘要` : '', d.import.failed ? `${d.import.failed} 個檔案分析失敗` : ''];
  return why.filter(Boolean).join('、');
});

/** 每小時事件數:單日只顯示「時」,多日加上日期 */
const hourChart = computed(() => {
  const h = data.value?.hours ?? [];
  const multiDay = data.value ? data.value.from !== data.value.to : false;
  return {
    labels: h.map((x) => (multiDay ? x.hour.slice(5, 13).replace('T', ' ') : x.hour.slice(11, 13))),
    series: [{ name: '事件數', values: h.map((x) => x.n), area: true }],
  };
});

// 排行的語氣(危險 / 注意);同舊版
const DANGER = new Set(['highName', 'extSrc', 'blockHost', 'blockSrc', 'failIp', 'failUser', 'error', 'bad']);
const WARN = new Set(['upload', 'upSrc', 'name', 'thrCategory']);
const toneOf = (k: string) => (DANGER.has(k) ? 'danger' : WARN.has(k) ? 'warning' : 'primary');
/** KPI 值是壞消息時標紅(嚴重度、動作、結果) */
const BAD_VALUES = /^(critical|high|failure|block|block-url|deny|drop|reset|Blocked|malware|phishing|grayware)/i;
const tops = computed(() => (data.value?.tops ?? []).filter((t) => t.items.length));

/** IPv4(每段 0–255,前後不接數字或點) */
const IP = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/;
// 要能使用 AI 問答(按鈕 netops.pa-ask.use)才可點;只看得到問答頁的人點了也不能問
const canAsk = computed(() => can(UI.paAskUse));
const hasIp = (key: string) => canAsk.value && IP.test(key);
/** 排行點選:內容含 IP 就到 AI 問答並帶入問題(由使用者送出) */
function pick(key: string) {
  const ip = key.match(IP)?.[0];
  if (!ip) return;
  void router.push(askLink(`${ip} 在${current.value?.label ?? ''} log 的狀況,有沒有問題?`, range.from, range.to));
}

async function refresh() {
  clearTimeout(debounce);
  const before = `${type.value}|${range.from}|${range.to}`;
  await loadTypes();
  // 第一次載入時 loadTypes 會設定類型與期間,由 watch 載入;沒變才自己載入
  if (`${type.value}|${range.from}|${range.to}` === before) await load();
}

onMounted(refresh);

// ---------- AC6 AI 摘要安全事件 ----------
const canAi = computed(() => can(UI.paEventsAi));
const aiOpen = ref(false);
/** 期間有效才可用;四類一起摘要,和目前選的類型無關(解密等 FTP 類型的期間也可以用,沒有資料的類型由後端註明) */
const aiInput = computed<ExplainInput | null>(() => (rangeCheck.value.ok && range.from ? { kind: 'events', params: { from: range.from, to: range.to || range.from } } : null));
const aiSubtitle = computed(() => {
  const p = aiInput.value?.params as { from: string; to: string } | undefined;
  return p ? `期間 ${p.from}${p.to !== p.from ? ` ~ ${p.to}` : ''}(威脅、URL 過濾、資料過濾、WildFire)` : '';
});
/** 回答下方的四類筆數:有這個類型(頁面上的分段)才可點 */
const aiTypes = (m: ExplainMeta | null) => (m?.kind === 'events' ? (m.types ?? []) : []);
const typeState = (t: ExplainEventType) => (t.empty ? '沒有資料' : t.partial ? '不完整' : '');
const canSwitch = (t: ExplainEventType) => types.value.some((x) => x.type === t.type);
function switchType(t: ExplainEventType) {
  if (!canSwitch(t)) return;
  aiOpen.value = false;
  type.value = t.type;
}
const typeAria = (t: ExplainEventType) =>
  [EVENT_TYPE_LABELS[t.type], `${fmtNum(t.rows)} 次`, typeState(t), canSwitch(t) ? '切換到這個類型' : ''].filter(Boolean).join(',');
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <GButton icon="refresh" :loading="loading || typesLoading" @click="() => void refresh()">重新整理</GButton>
      <GButton v-if="canAi && types.length" variant="primary" icon="sparkles" :disabled="!aiInput" @click="aiOpen = true">AI 摘要安全事件</GButton>
    </Teleport>

    <GAlert v-if="typesError" tone="danger" title="無法取得 log 類型">{{ describeError(typesError) }}</GAlert>

    <GCard v-if="types.length" padding="sm">
      <div class="stack" style="--gap: 12px">
        <GSegmented v-model="type" size="sm" :options="typeOptions" class="types" />
        <div class="filters">
          <DateRangeField v-model:from="range.from" v-model:to="range.to" :max-days="MAX_DAYS" :coverage="current?.coverage" :disabled="!current?.days.length" class="date" />
          <p class="small muted hint">
            <template v-if="data?.timeMin"
              >{{ data.label }}:{{ fmtTime(data.timeMin) }} ~ {{ fmtTime(data.timeMax) }},{{ data.files }} {{ data.source === 'clickhouse' ? '小時有資料' : '個 log 檔' }}</template
            >
            <template v-if="current?.days.length"> · {{ coverageText(current.coverage) }}</template>
          </p>
        </div>
        <p v-if="rangeError" class="small c-danger err">{{ rangeError }}</p>
      </div>
    </GCard>

    <GCard v-if="!typesLoading && !typesError && !types.length">
      <GEmpty icon="shield-alert" title="沒有設定其他類型 log 的 FTP 目錄" description="請系統負責人在 netops-api 設定威脅、URL 等 log 的 FTP 目錄" />
    </GCard>
    <GAlert v-if="current?.unavailable" tone="danger" title="PA log 資料庫暫時無法使用">{{ current.label }} 的資料在 ClickHouse,目前連不上,請稍後再試。</GAlert>
    <GCard v-else-if="current && !current.days.length && !typesLoading && current.source === 'clickhouse'">
      <GEmpty icon="shield-alert" :title="`還沒有${current.label} log 的資料`" description="PA-560 轉送的 log 會即時寫進 ClickHouse;收到第一筆後這裡就會有資料。" />
    </GCard>
    <GCard v-else-if="current && !current.days.length && !typesLoading">
      <GEmpty
        icon="folder"
        :title="`還沒有${current.label} log 的分析資料`"
        :description="`FTP 目錄 ${current.dir}。到「FTP Log 檔案」同步新檔案,系統會從 FTP 讀取並產生統計(原始 log 不存本機)。`"
      >
        <RouterLink :to="{ path: '/firewall/files', query: { path: current.dir } }"
          ><GButton variant="primary" icon="folder">前往 FTP Log 檔案</GButton></RouterLink
        >
      </GEmpty>
    </GCard>
    <GCard v-else-if="loadError && !data">
      <GEmpty tone="danger" icon="shield-alert" title="無法載入安全事件" :description="describeError(loadError)">
        <GButton icon="refresh" @click="load">重試</GButton>
      </GEmpty>
    </GCard>
    <div v-else-if="!data && current" class="grid grid-auto">
      <GCard v-for="i in 4" :key="i" padding="sm"><GSkeleton :lines="3" /></GCard>
    </div>

    <template v-if="data && current?.days.length">
      <GAlert v-if="loadError" tone="danger">重新載入失敗,以下是上次的結果:{{ describeError(loadError) }}</GAlert>
      <GAlert v-if="data.partial && data.coverage" tone="info" title="期間有一部分超過保留期限">{{ data.coverage.from }} 之前沒有資料,統計只含 {{ data.coverage.from }} 起。</GAlert>
      <GAlert v-if="incomplete" tone="warning" title="結果不完整">{{ incomplete }};沒有出現不代表沒有發生。</GAlert>

      <!-- KPI -->
      <div class="grid kpis">
        <GStatCard label="事件數" :value="fmtShort(data.rows)" icon="activity" :hint="`${fmtNum(data.rows)} 次(已乘上重複次數)`" />
        <GCard v-for="k in data.kpis" :key="k.key" padding="sm" :title="k.title">
          <ul class="kpi">
            <li v-for="x in k.items.slice(0, 6)" :key="x.key">
              <span class="ellipsis" :class="BAD_VALUES.test(x.key) ? 'c-danger strong' : ''">{{ x.key }}</span>
              <span class="num muted">{{ fmtNum(x.n) }}</span>
            </li>
          </ul>
          <p v-if="!k.items.length" class="small muted">沒有資料</p>
        </GCard>
      </div>

      <!-- 每小時 -->
      <GCard v-if="data.hours.length > 1" title="每小時事件數" icon="clock">
        <GAreaChart :labels="hourChart.labels" :series="hourChart.series" :height="180" unit=" 次" />
      </GCard>

      <!-- 排行 -->
      <div class="grid tops">
        <TopList
          v-for="t in tops"
          :key="t.key"
          :title="t.title"
          :items="t.items"
          :tone="toneOf(t.key)"
          :pickable="hasIp"
          pick-hint="到 AI 問答查詢這個 IP"
          @pick="pick"
        />
      </div>
      <p v-if="canAsk" class="xs faint"><GIcon name="sparkles" :size="12" /> 點排行中含 IP 的項目,會到 AI 問答並帶入問題(同時參考防火牆流量與這些 log)。</p>
    </template>

    <!-- AC6:AI 摘要安全事件(開啟時自動開始;換期間時清掉舊回答) -->
    <GModal v-if="canAi" v-model:open="aiOpen" title="AI 摘要安全事件" :subtitle="aiSubtitle" icon="sparkles" width="880px">
      <AiExplainPanel
        v-if="aiOpen"
        :input="aiInput"
        title="安全事件摘要"
        start-label="開始摘要"
        hint="只把四類安全事件的筆數、分布與排行(不是原始 log)送到公司內部的 AI 服務,不會傳到外部"
        frame="plain"
        auto-start
      >
        <template #default="{ meta }">
          <div v-if="aiTypes(meta).length" class="ev-ai">
            <p class="xs faint ev-ai__hint">AI 看到的四類筆數(點了切換到該類型)</p>
            <ul class="ev-ai__list" aria-label="四類安全事件筆數">
              <li v-for="t in aiTypes(meta)" :key="t.type">
                <button
                  type="button"
                  class="ev-ai__type"
                  :class="{ 'is-empty': t.empty, 'is-warn': t.partial }"
                  :disabled="!canSwitch(t)"
                  :aria-label="typeAria(t)"
                  @click="switchType(t)"
                >
                  <span class="ev-ai__label">{{ EVENT_TYPE_LABELS[t.type] }}</span>
                  <span class="num ev-ai__rows">{{ t.empty ? '—' : fmtShort(t.rows) }}</span>
                  <span v-if="typeState(t)" class="ev-ai__tag">{{ typeState(t) }}</span>
                </button>
              </li>
            </ul>
          </div>
        </template>
      </AiExplainPanel>
    </GModal>
  </div>
</template>

<style scoped>
.types {
  max-width: 100%;
  overflow-x: auto;
}
.types :deep(button) {
  white-space: nowrap;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  align-items: flex-end;
}
.date {
  width: 300px;
  max-width: 100%;
}
.hint {
  margin: 0 0 8px;
}
.err {
  margin: 0;
}
.kpis {
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}
.kpi {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
  font-size: var(--fs-sm);
}
.kpi li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.tops {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.ev-ai {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.ev-ai__hint {
  margin: 0;
}
.ev-ai__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.ev-ai__list li {
  display: flex;
}
.ev-ai__type {
  --type-tone: var(--c-primary);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--type-tone) 30%, var(--line));
  background: color-mix(in srgb, var(--type-tone) 6%, var(--glass-soft));
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease;
}
.ev-ai__type.is-warn {
  --type-tone: var(--c-warning);
}
.ev-ai__type.is-empty {
  --type-tone: var(--text-3);
}
.ev-ai__type:hover:not(:disabled) {
  border-color: var(--type-tone);
  transform: translateY(-1px);
}
.ev-ai__type:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
.ev-ai__type:disabled {
  cursor: default;
}
.ev-ai__label {
  font-size: var(--fs-sm, 0.875rem);
}
.ev-ai__rows {
  margin-left: auto;
  font-weight: 600;
}
.ev-ai__tag {
  flex-basis: 100%;
  font-size: var(--fs-xs, 0.75rem);
  color: color-mix(in srgb, var(--type-tone) 70%, var(--text));
}
@media (prefers-reduced-motion: reduce) {
  .ev-ai__type {
    transition: none;
  }
  .ev-ai__type:hover:not(:disabled) {
    transform: none;
  }
}
@media (max-width: 760px) {
  .ev-ai__list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .date {
    flex: 1 1 100%;
    width: auto;
  }
  .tops {
    grid-template-columns: 1fr;
  }
}
</style>
