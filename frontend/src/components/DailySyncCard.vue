<script setup lang="ts">
/**
 * 對帳後每日同步(IMPL-PLAN AC1;docs/API.md §5.4):每天自動對帳後,從 FTP 匯入解密、GlobalProtect、User-ID 與 AD。
 * 顯示今天這一輪的狀態,以及 FTP 保留期限內每個類型每一天的匯入狀態(格子:已匯入 / 處理中 / 失敗 / 尚無檔案)。
 * 防火牆 › FTP Log 檔案顯示全部類型;AD 網域 › FTP Log 檔案只顯示 AD(only = ['ad'])。
 * 連續 2 天以上 FTP 沒有檔的類型(stale)標「中斷」並提示 PA 匯出可能中斷;這些類型不擋當天完成(驗收報告 §3.2)。
 * 資料由頁面輪詢的匯入進度帶入(GET /ftp/pa/status、/ftp/ad/status 的 daily),本元件不自己呼叫 API。
 */
import { computed } from 'vue';
import type { DailySyncStatus } from '@/api/ftp';
import { fmtTime } from '@/api/format';
import { DAILY_DAY_STATE, DAILY_RUN_STATE, dailyCategories, dailyDayLabel, dailyDays, dailyErrors, dailyLatest, dailyStale } from '@/composables/ftpFiles';

const props = defineProps<{
  status: DailySyncStatus | null | undefined;
  /** 只顯示這些類型(省略 = 全部) */
  only?: string[];
}>();

const cats = computed(() => dailyCategories(props.status, props.only));
const days = computed(() => dailyDays(cats.value));
const latest = computed(() => dailyLatest(cats.value));
const errors = computed(() => dailyErrors(cats.value));
const stale = computed(() => dailyStale(cats.value));
const staleHint = computed(() => {
  const keys = cats.value.filter((c) => c.stale).map((c) => c.key);
  const pa = keys.some((k) => k !== 'ad') ? 'PA 排程匯出(Device › Scheduled Log Export)' : '';
  const ad = keys.includes('ad') ? 'AD 事件匯出排程' : '';
  return [pa, ad].filter(Boolean).join('、');
});
const run = computed(() => (props.status ? DAILY_RUN_STATE[props.status.state] : null));
const subtitle = computed(() => {
  const s = props.status;
  if (!s?.enabled) return '自動對帳後從 FTP 匯入解密、GlobalProtect、User-ID 與 AD 事件';
  const what = props.only?.length === 1 && props.only[0] === 'ad' ? ' AD 事件' : '解密、GlobalProtect、User-ID 與 AD 事件';
  return `每天 ${s.at ?? ''} 對帳後自動匯入${what};FTP 只保留 ${s.retentionDays} 天,請在期限內確認都已匯入`;
});
const legend = Object.values(DAILY_DAY_STATE);
const cellTitle = (label: string, day: string, state: keyof typeof DAILY_DAY_STATE) => `${label} ${day}:${DAILY_DAY_STATE[state].label}`;
</script>

<template>
  <GCard v-if="status" title="每日自動同步" :subtitle="subtitle" icon="calendar" padding="sm" class="daily">
    <template #actions>
      <GBadge v-if="run" :tone="run.tone" dot>{{ run.label }}</GBadge>
    </template>

    <p v-if="!status.enabled" class="small muted">
      未啟用(<code>NETOPS_DAILY_SYNC=0</code>、自動對帳關閉或沒有 ClickHouse)。這些資料只能在下方手動同步;FTP 只保留 {{ status.retentionDays }} 天,逾期就無法再匯入。
    </p>
    <template v-else>
      <div class="meta small">
        <span v-if="latest.day">
          前一天 <strong class="num">{{ latest.day }}</strong>:
          <span class="num" :class="latest.done === latest.total ? 'c-success' : 'c-warning'">{{ latest.done }} / {{ latest.total }}</span> 類已匯入<template v-if="latest.stale">(<span class="c-warning">{{ latest.stale }} 類 FTP 中斷,略過</span>)</template>
        </span>
        <span v-if="status.lastRunAt" class="faint">上次檢查 {{ fmtTime(status.lastRunAt) }}</span>
        <span v-if="status.lastSyncAt" class="faint hide-sm">上次列 FTP {{ fmtTime(status.lastSyncAt) }}</span>
        <span v-if="status.state === 'retrying'" class="faint">已試 {{ status.tries }} 次,每 10 分鐘再看一次</span>
        <span v-if="status.finishedAt" class="faint">{{ status.state === 'done' ? '完成於' : '停止於' }} {{ fmtTime(status.finishedAt) }}</span>
      </div>

      <GAlert v-if="status.state === 'gave-up'" tone="danger">
        前一天的檔一直沒有匯入完成,今天已停止自動重試;請確認 FTP 上有沒有這天的檔,再手動同步。
      </GAlert>
      <GAlert v-if="stale.length" tone="warning" title="FTP 匯出可能中斷">
        <ul class="stale-list">
          <li v-for="m in stale" :key="m">{{ m }}</li>
        </ul>
        這些類型不擋每日同步完成;請網管確認{{ staleHint }}與 FTP 帳號、目錄權限。
      </GAlert>
      <GAlert v-if="errors.length" tone="warning" title="有檔案匯入失敗">
        {{ errors.slice(0, 6).join('、') }}<template v-if="errors.length > 6"> 等 {{ errors.length }} 項</template>。下一輪會自動重試;一直失敗請看檔案清單的錯誤訊息。
      </GAlert>

      <div v-if="cats.length" class="scroll" role="region" aria-label="每日同步狀態" tabindex="0">
        <table class="grid-table">
          <caption class="sr-only">
            保留期限內每個類型每一天的匯入狀態(新的在前)
          </caption>
          <thead>
            <tr>
              <th scope="col" class="cat">類型</th>
              <th v-for="d in days" :key="d" scope="col" class="day">
                <span class="num">{{ dailyDayLabel(d).md }}</span>
                <span class="wd faint">{{ dailyDayLabel(d).wd }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in cats" :key="c.key">
              <th scope="row" class="cat">
                {{ c.label }}
                <GBadge v-if="c.stale" tone="warning" class="stale-badge">中斷</GBadge>
              </th>
              <td v-for="d in c.days" :key="d.day" class="cell">
                <span
                  class="mark"
                  :class="`tone-${DAILY_DAY_STATE[d.state].tone} s-${d.state}`"
                  :title="cellTitle(c.label, d.day, d.state)"
                  :aria-label="cellTitle(c.label, d.day, d.state)"
                  role="img"
                >
                  <GIcon :name="DAILY_DAY_STATE[d.state].icon" :size="13" :stroke="2.4" />
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="small muted">沒有要同步的類型(FTP 目錄都未設定)。</p>

      <ul class="legend xs muted" aria-label="圖例">
        <li v-for="l in legend" :key="l.label">
          <span class="mark sm" :class="`tone-${l.tone}`"><GIcon :name="l.icon" :size="11" :stroke="2.4" /></span>{{ l.label }}
        </li>
      </ul>
    </template>
  </GCard>
</template>

<style scoped>
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 16px;
  margin-bottom: 10px;
}
.daily :deep(.g-alert) {
  margin-bottom: 10px;
}
.scroll {
  overflow-x: auto;
  max-width: 100%;
  border-radius: var(--radius-sm);
}
.scroll:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}
.grid-table {
  border-collapse: separate;
  border-spacing: 0;
  min-width: 100%;
  font-size: var(--fs-sm);
}
.grid-table th,
.grid-table td {
  padding: 6px 4px;
  text-align: center;
  border-bottom: 1px solid var(--line);
}
.grid-table tbody tr:last-child th,
.grid-table tbody tr:last-child td {
  border-bottom: 0;
}
.grid-table .cat {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 112px;
  padding-right: 12px;
  text-align: left;
  font-weight: 600;
  white-space: nowrap;
  /* 卡片是半透明玻璃:固定欄要不透明,捲動時才不會和後面的格子重疊 */
  background: linear-gradient(var(--glass-strong), var(--glass-strong)), var(--bg);
}
.grid-table thead .cat {
  color: var(--text-2);
  font-weight: 500;
}
.day {
  min-width: 52px;
  color: var(--text-2);
  font-weight: 500;
  white-space: nowrap;
}
.day .num {
  display: block;
}
.wd {
  display: block;
  font-size: var(--fs-xs);
}
.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: color-mix(in srgb, var(--tone) 70%, var(--text));
  background: color-mix(in srgb, var(--tone) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent);
}
.mark.s-none {
  background: transparent;
  border-style: dashed;
  color: var(--text-3);
}
.mark.sm {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  margin-right: 5px;
}
.stale-list {
  margin: 0 0 4px;
  padding-left: 18px;
}
.stale-badge {
  margin-left: 4px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.legend li {
  display: inline-flex;
  align-items: center;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (max-width: 760px) {
  .hide-sm {
    display: none;
  }
  .grid-table .cat {
    min-width: 92px;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .mark.s-pending {
    animation: pulse 1.6s ease-in-out infinite;
  }
}
@keyframes pulse {
  50% {
    opacity: 0.55;
  }
}
</style>
