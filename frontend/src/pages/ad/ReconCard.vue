<script setup lang="ts">
/**
 * AD › FTP Log 檔案:「ClickHouse 對帳與補漏」卡片(AD-3;docs/AD-AGENT-PLAN.md §5、§6.1):
 *   - 查詢保留期內、昨天以前的每日對帳結果(GET /api/netops/ad/reconciliations)
 *   - 503 NETOPS_CLICKHOUSE_UNAVAILABLE → 顯示「ClickHouse 尚未啟用或暫時無法使用」,不影響原本 FTP 檔案清單
 *   - 有管理權限(UI.adFilesManage,已含 netops.ftp.write)可「立即對帳」與「補漏」
 *   - 補漏工作每 2 秒輪詢直到 done / failed(頁面隱藏時停止、離開頁面時清除)
 */
import { computed, onMounted, ref } from 'vue';
import type { AdBackfillJob, AdBackfillScope, AdReconDay, AdReconItem } from '@/api/ad';
import { AD_CHANNEL } from '@/api/ftp';
import { can, describeError } from '@/api/gateway';
import { fmtNum, fmtTime } from '@/api/format';
import { UI } from '@/api/perms';
import {
  AD_BACKFILL_STATE,
  AD_RECON_ITEM_STATUS,
  AD_RECON_STATUS,
  backfillErrorTitle,
  useAdReconcile,
} from '@/composables/adReconcile';
import { toast } from '@/ui';

const props = withDefaults(
  defineProps<{
    /** 輪詢間隔(毫秒;測試可覆寫) */
    pollMs?: number;
  }>(),
  {},
);

const manage = computed(() => can(UI.adFilesManage));
const { list, loading, error, unavailable, runningDay, submittingKey, jobs, jobError, dayError, load, runDay, startBackfill } = useAdReconcile(props.pollMs);

const days = computed(() => list.value?.items ?? []);
const expanded = ref<Record<string, boolean>>({});
function toggleExpand(day: string) {
  expanded.value = { ...expanded.value, [day]: !expanded.value[day] };
}

const channelLabel = (c: string) => AD_CHANNEL[c] ?? c;
const latestJobOf = (d: AdReconDay): AdBackfillJob | null => {
  for (const id of d.backfills) if (jobs.value[id]) return jobs.value[id]!;
  return null;
};
const latestJobErrOf = (d: AdReconDay): Error | null => {
  const id = d.backfills[0];
  return id ? (jobError.value[id] ?? null) : null;
};

async function handleRun(day: string) {
  try {
    const r = await runDay(day);
    toast.success(`${day} 對帳完成`, `狀態:${AD_RECON_STATUS[r.status]?.label ?? r.status}`);
  } catch (e) {
    toast.fromError(e, `${day} 立即對帳失敗`);
  }
}

async function handleBackfill(day: string, scope?: AdBackfillScope[]) {
  try {
    const j = await startBackfill(day, scope);
    expanded.value = { ...expanded.value, [day]: true };
    toast.info(`${day} 已送出補漏工作`, `共 ${j.scope.length} 項,背景執行中`);
  } catch (e) {
    toast.fromError(e, backfillErrorTitle(e));
  }
}

const isItemSubmitting = (day: string, item: AdReconItem) =>
  submittingKey.value === day || submittingKey.value === `${day}|${item.computer}|${item.channel}`;

onMounted(() => void load());
</script>

<template>
  <GCard padding="sm" title="ClickHouse 對帳與補漏" icon="database">
    <template #actions>
      <span v-if="list?.window" class="xs muted num">對帳視窗 {{ list.window.from }} ~ {{ list.window.to }}</span>
      <GButton size="sm" variant="ghost" icon="refresh" :loading="loading" @click="load">重新整理</GButton>
    </template>

    <GAlert v-if="unavailable" tone="info" title="ClickHouse 尚未啟用或暫時無法使用">
      {{ describeError(error) }}
    </GAlert>
    <GAlert v-else-if="error" tone="danger" title="無法取得對帳結果">
      {{ describeError(error) }}
    </GAlert>

    <div v-if="loading && !list && !error">
      <GSkeleton :lines="3" />
    </div>

    <GEmpty
      v-else-if="list && (!list.window || !days.length)"
      icon="database"
      title="沒有可對帳的日子"
      description="只比對 AD 事件與 FTP 保留期間內、昨天以前的日子"
    />

    <div v-else-if="days.length" class="recon-list">
      <div v-for="d in days" :key="d.day" class="recon-day" :data-day="d.day">
        <div class="day-head">
          <div class="day-info">
            <GButton
              size="sm"
              variant="ghost"
              square
              :icon="expanded[d.day] ? 'chevron-down' : 'chevron-right'"
              :aria-expanded="!!expanded[d.day]"
              :aria-label="`展開 ${d.day} 對帳明細`"
              @click="toggleExpand(d.day)"
            />
            <span class="num strong nowrap">{{ d.day }}</span>
            <GBadge :tone="AD_RECON_STATUS[d.status]?.tone ?? 'neutral'" dot>{{ AD_RECON_STATUS[d.status]?.label ?? d.status }}</GBadge>
            <span class="xs muted num">
              FTP {{ fmtNum(d.ftpFiles) }} 檔 · 缺口 {{ fmtNum(d.gaps) }} · 多出 {{ fmtNum(d.excess) }}
            </span>
            <span class="xs muted num">對帳 {{ fmtTime(d.checkedAt) }}</span>
          </div>

          <div v-if="manage" class="day-actions">
            <GButton size="sm" variant="ghost" icon="refresh" :loading="runningDay === d.day" @click="handleRun(d.day)">立即對帳</GButton>
            <GButton
              v-if="d.gaps > 0"
              size="sm"
              variant="primary"
              icon="download"
              :loading="submittingKey === d.day"
              @click="handleBackfill(d.day)"
            >
              補漏
            </GButton>
          </div>
        </div>

        <!-- 補漏工作狀態與筆數 -->
        <div v-if="latestJobOf(d)" class="job-box small">
          <template v-for="job in [latestJobOf(d)!]" :key="job.id">
            <div class="job-head">
              <GBadge :tone="AD_BACKFILL_STATE[job.state]?.tone ?? 'neutral'" dot>{{ AD_BACKFILL_STATE[job.state]?.label ?? job.state }}</GBadge>
              <span class="xs muted num">
                讀取 {{ fmtNum(job.read) }} · 補寫 <strong class="text">{{ fmtNum(job.inserted) }}</strong> · 已存在 {{ fmtNum(job.skipped) }}
                <template v-if="job.invalid > 0"> · 無效 {{ fmtNum(job.invalid) }}</template>
              </span>
              <span v-if="job.finishedAt" class="xs muted num">完成 {{ fmtTime(job.finishedAt) }}</span>
            </div>
            <GProgress v-if="job.state === 'queued' || job.state === 'running'" :value="job.state === 'queued' ? 15 : 65" tone="info" :height="6" class="job-prog" />
            <p v-if="job.waitingAgent > 0" class="xs muted job-note">
              待 Agent 送出 {{ fmtNum(job.waitingAgent) }} 筆:Agent 之後會送,隔天對帳再看。
            </p>
            <p v-if="job.ambiguous > 0" class="xs c-warning job-note">
              世代不明 {{ fmtNum(job.ambiguous) }} 筆:判斷不出 Event Log 世代,未寫入,需人工確認。
            </p>
            <p v-if="job.error" class="xs c-danger job-note">工作錯誤:{{ job.error }}</p>
          </template>
        </div>
        <p v-else-if="latestJobErrOf(d)" class="xs c-danger job-note">無法查詢補漏進度:{{ describeError(latestJobErrOf(d)) }}</p>
        <p v-if="dayError[d.day]" class="xs c-danger job-note">重新對帳失敗:{{ describeError(dayError[d.day]) }}</p>

        <!-- 展開:DC × 記錄明細 -->
        <div v-if="expanded[d.day]" class="day-items">
          <p v-if="!d.items.length" class="xs muted empty-items">這一天沒有 DC × 記錄比對明細</p>
          <table v-else class="recon-table small">
            <thead>
              <tr>
                <th>DC</th>
                <th>記錄</th>
                <th class="num-col">FTP</th>
                <th class="num-col">ClickHouse(Agent / FTP 補寫)</th>
                <th class="num-col">差異</th>
                <th>狀態</th>
                <th v-if="manage" class="act-col" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in d.items" :key="`${it.computer}|${it.channel}`">
                <td class="mono">{{ it.computer }}</td>
                <td>{{ channelLabel(it.channel) }}</td>
                <td class="num-col num">{{ fmtNum(it.ftp) }}</td>
                <td class="num-col num">
                  {{ fmtNum(it.ch) }}
                  <span class="xs muted">({{ fmtNum(it.chAgent) }} / {{ fmtNum(it.chFtp) }})</span>
                </td>
                <td class="num-col num" :class="it.diff > 0 ? 'c-danger' : it.diff < 0 ? 'c-warning' : ''">{{ it.diff > 0 ? `+${fmtNum(it.diff)}` : fmtNum(it.diff) }}</td>
                <td>
                  <GBadge :tone="AD_RECON_ITEM_STATUS[it.status]?.tone ?? 'neutral'" dot>{{ AD_RECON_ITEM_STATUS[it.status]?.label ?? it.status }}</GBadge>
                </td>
                <td v-if="manage" class="act-col">
                  <GButton
                    v-if="it.status === 'gap'"
                    size="sm"
                    variant="secondary"
                    :loading="isItemSubmitting(d.day, it)"
                    @click="handleBackfill(d.day, [{ computer: it.computer, channel: it.channel }])"
                  >
                    補漏
                  </GButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </GCard>
</template>

<style scoped>
.recon-list {
  display: grid;
  gap: 8px;
}
.recon-day {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--glass-soft);
}
.day-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px 12px;
}
.day-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}
.day-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.job-box {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--glass-strong);
  display: grid;
  gap: 4px;
}
.job-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}
.job-prog {
  margin-top: 2px;
}
.job-note {
  margin: 2px 0 0;
  word-break: break-word;
}
.day-items {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  overflow-x: auto;
}
.empty-items {
  margin: 0;
}
.recon-table {
  width: 100%;
  border-collapse: collapse;
}
.recon-table th,
.recon-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.recon-table th {
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-weight: 600;
}
.recon-table .num-col {
  text-align: right;
}
.recon-table .act-col {
  text-align: right;
  width: 72px;
}
.strong {
  font-weight: 600;
}
.text {
  color: var(--text);
}
</style>
