<script setup lang="ts">
/**
 * 防火牆 › 威脅特徵碼 — 分頁 3:命中比對(TS-4;計畫 §5.1、TS-Q8)
 *   - 範圍:近 N 天新特徵碼(預設)或指定特徵 ID(最多 500 個)
 *   - 天數:7 / 30 / 90 天(預設 30;90 天自動走背景工作模式並可取消)
 *   - TS-2 審查結論(嚴格遵守):
 *     - 歷史不足時顯示「自 YYYY-MM-DD 起統計」(用 hitsResult.since)
 *     - 命中比對的 IP / 名稱「只依後端回傳顯示」(hitsResult.includeIps / item.topSrc / item.topDst / sig.nameOfIp(ip)),前端本元件不自行判斷權限
 *   - 命中規則標註 unprotected(「此規則沒有防護,命中只是 log」),點擊開既有規則抽屜
 *   - 「看明細」連到既有 Log 明細(/firewall/search,type=THREAT)
 */
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { fmtNum, fmtTime } from '@/api/format';
import { describeError } from '@/api/gateway';
import type { IpNameLabel } from '@/api/ipNames';
import { PA_SIGNATURE_LIMITS, type HitQueryItem, type SignatureDays } from '@/api/paSignature';
import {
  searchLinkForSignature,
  severityMeta,
  SIG_DAYS_OPTIONS,
  SIG_KIND_META,
  type PaSignatureStore,
} from './types';

const props = defineProps<{
  sig: PaSignatureStore;
  ruleLinkable?: (name: string) => boolean;
}>();
const emit = defineEmits<{
  (e: 'open-signature', id: string): void;
  (e: 'open-rule', name: string): void;
}>();

const scope = ref<'new' | 'ids'>('new');
const idsText = ref('');
const idsError = ref('');

const SCOPE_OPTIONS = [
  { label: '新特徵碼', value: 'new' },
  { label: '指定特徵 ID', value: 'ids' },
];

const daysModel = computed({
  get: () => String(props.sig.filters.days ?? 30),
  set: (v: string) => {
    props.sig.setDays(Number(v) as SignatureDays);
  },
});

function parseIds(raw: string): { ids: string[]; error: string } {
  const parts = raw
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { ids: [], error: '請輸入至少一個純數字特徵 ID' };
  const invalid = parts.filter((x) => !/^\d{1,10}$/.test(x));
  if (invalid.length) return { ids: [], error: `特徵 ID 必須為純數字（格式錯誤：${invalid.slice(0, 3).join('、')}）` };
  const unique = [...new Set(parts)];
  if (unique.length > PA_SIGNATURE_LIMITS.hitIds) {
    return { ids: [], error: `單次最多查詢 ${PA_SIGNATURE_LIMITS.hitIds} 個特徵 ID（目前 ${unique.length} 個）` };
  }
  return { ids: unique, error: '' };
}

async function onQuery() {
  idsError.value = '';
  const days = (props.sig.filters.days ?? 30) as SignatureDays;
  if (scope.value === 'ids') {
    const parsed = parseIds(idsText.value);
    if (parsed.error) {
      idsError.value = parsed.error;
      return;
    }
    await props.sig.queryHits({ days, scope: 'ids', ids: parsed.ids });
    return;
  }
  await props.sig.queryHits({ days, scope: 'new' });
}

/** 只依後端回傳判斷是否顯示 IP 區塊(TS-2 審查結論:前端不自行判斷權限) */
const showIps = computed(() => Boolean(props.sig.hitsResult?.includeIps));

function formatIpName(label: IpNameLabel | null): string {
  if (!label) return '';
  return [label.name, label.department, label.device].filter(Boolean).join(' / ');
}

function actionEntries(actions: Record<string, number>): [string, number][] {
  return Object.entries(actions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function detailLink(item: HitQueryItem, ip?: string) {
  const r = props.sig.hitsResult;
  return searchLinkForSignature({
    id: item.id,
    name: item.name,
    ip,
    fromIso: r?.from,
    toIso: r?.to,
    days: r?.days,
  });
}
</script>

<template>
  <div class="hits-tab">
    <GCard class="ctrl-card">
      <form class="ctrl-row" @submit.prevent="onQuery">
        <div class="field-col">
          <span class="xs muted field-lbl">比對範圍</span>
          <GSegmented v-model="scope" size="sm" :options="SCOPE_OPTIONS" aria-label="命中比對範圍" />
        </div>

        <div class="field-col">
          <span class="xs muted field-lbl">統計天數</span>
          <GSegmented v-model="daysModel" size="sm" :options="SIG_DAYS_OPTIONS" aria-label="命中比對天數" />
        </div>

        <GInput
          v-if="scope === 'ids'"
          v-model="idsText"
          label="特徵 ID（逗號或空白分隔，最多 500 個）"
          placeholder="例：547000, 91001"
          :error="idsError"
          clearable
          class="ids-input"
        />

        <div class="ctrl-btns">
          <GButton v-if="sig.hitsLoading" type="button" variant="danger" icon="x" @click="sig.cancelHits()">
            停止查詢
          </GButton>
          <GButton v-else type="submit" variant="primary" icon="search">
            執行命中比對
          </GButton>
        </div>
      </form>

      <p v-if="(sig.filters.days ?? 30) > 30" class="xs muted mt-2 mb-0">
        90 天範圍將自動以背景工作執行（可隨時停止）；若要開 Log 明細，明細查詢最長帶入最近 30 天。
      </p>

      <div v-if="sig.hitsLoading" class="job-status small mt-2" role="status" aria-live="polite">
        <span class="spin-dot" aria-hidden="true" />
        <span>
          {{ sig.hitsJob ? `背景比對查詢中（狀態：${sig.hitsJob.status}）…` : '正在查詢 ClickHouse 威脅紀錄…' }}
        </span>
      </div>

      <GAlert v-if="sig.hitsError" tone="danger" class="mt-2">{{ describeError(sig.hitsError) }}</GAlert>
      <GAlert v-if="sig.hitsResult?.since" tone="info" class="mt-2">
        自 {{ sig.hitsResult.since }} 起統計（基準日晚於所選 {{ sig.hitsResult.days }} 天範圍）。
      </GAlert>
      <GAlert v-if="sig.hitsResult?.truncatedIds" tone="warning" class="mt-2">
        符合條件的特徵超過 500 個上限，本次只比對前 500 個特徵碼。
      </GAlert>
      <GAlert v-if="sig.namesError" tone="warning" class="mt-2">
        IP 對照表查詢失敗，目前僅顯示 IP 位址（{{ describeError(sig.namesError) }}）。
      </GAlert>
    </GCard>

    <GSkeleton v-if="sig.hitsLoading && !sig.hitsResult" :lines="6" />

    <GCard v-else-if="!sig.hitsResult">
      <GEmpty
        icon="activity"
        title="尚未執行命中比對"
        description="選擇比對範圍與天數後，按「執行命中比對」從 ClickHouse 威脅 log 比對命中紀錄與動作分布。"
      />
    </GCard>

    <template v-else>
      <div class="result-meta xs muted">
        <span>
          比對 <strong class="mono">{{ fmtNum(sig.hitsResult.queriedIds) }}</strong> 個特徵碼，
          命中 <strong class="mono">{{ fmtNum(sig.hitsResult.items.length) }}</strong> 個
        </span>
        <span>範圍：{{ fmtTime(sig.hitsResult.from) }} ~ {{ fmtTime(sig.hitsResult.to) }}</span>
        <span v-if="!showIps">（本次結果僅包含命中筆數與動作分布）</span>
      </div>

      <GCard v-if="!sig.hitsResult.items.length">
        <GEmpty
          icon="check-circle"
          title="這段期間沒有命中紀錄"
          :description="
            sig.hitsResult.queriedIds === 0
              ? '所選期間內沒有可比對的新特徵碼（可能尚在基準版本或期間內無新增）。'
              : `已比對 ${fmtNum(sig.hitsResult.queriedIds)} 個特徵碼，近 ${sig.hitsResult.days} 天在防火牆威脅 log 中均無命中。`
          "
        />
      </GCard>

      <div v-else class="hit-cards">
        <GCard v-for="item in sig.hitsResult.items" :key="item.id" class="hit-card">
          <header class="hit-head">
            <div class="hit-title">
              <GBadge v-if="item.severity" :tone="severityMeta(item.severity).tone">
                {{ severityMeta(item.severity).label }}
              </GBadge>
              <GBadge v-if="item.kind" :tone="SIG_KIND_META[item.kind].tone" variant="soft">
                {{ SIG_KIND_META[item.kind].label }}
              </GBadge>
              <button type="button" class="sig-link" @click="emit('open-signature', item.id)">
                <span class="mono">#{{ item.id }}</span> {{ item.name || '(未命名特徵)' }}
              </button>
            </div>

            <RouterLink :to="detailLink(item)">
              <GButton size="sm" variant="ghost" icon="search">看明細</GButton>
            </RouterLink>
          </header>

          <div class="hit-stats">
            <div class="stat-pill">
              <span class="xs muted">命中筆數</span>
              <strong class="mono">{{ fmtNum(item.hits) }}</strong>
              <span v-if="item.repeats > item.hits" class="xs muted">（含重複 {{ fmtNum(item.repeats) }} 次）</span>
            </div>
            <div class="stat-pill">
              <span class="xs muted">已攔截</span>
              <strong class="mono c-success">{{ fmtNum(item.blocked) }}</strong>
            </div>
            <div class="stat-pill">
              <span class="xs muted">僅告警 / 放行</span>
              <strong class="mono" :class="{ 'c-danger': item.alerted > 0 }">{{ fmtNum(item.alerted) }}</strong>
            </div>
            <div class="stat-pill">
              <span class="xs muted">首次 / 最後時間</span>
              <span class="mono xs">
                {{ item.firstSeen ? fmtTime(item.firstSeen) : '—' }} ~ {{ item.lastSeen ? fmtTime(item.lastSeen) : '—' }}
              </span>
            </div>
          </div>

          <div v-if="actionEntries(item.actions).length" class="sub-row xs">
            <span class="muted">動作分布：</span>
            <GBadge
              v-for="[act, cnt] in actionEntries(item.actions)"
              :key="act"
              :tone="act === 'alert' || act === 'allow' ? 'warning' : 'info'"
              variant="soft"
              mono
            >
              {{ act }}: {{ fmtNum(cnt) }}
            </GBadge>
          </div>

          <div v-if="item.ruleDetails.length" class="sub-row xs">
            <span class="muted">命中規則：</span>
            <span v-for="rd in item.ruleDetails" :key="rd.name" class="rule-chip-wrap">
              <button
                v-if="ruleLinkable?.(rd.name)"
                type="button"
                class="rule-btn mono"
                @click="emit('open-rule', rd.name)"
              >
                {{ rd.name }}
              </button>
              <span v-else class="mono">{{ rd.name }}</span>
              <GBadge v-if="rd.unprotected" tone="danger" variant="soft" class="mini-badge">
                此規則沒有防護，命中只是 log
              </GBadge>
            </span>
          </div>

          <!-- 只有後端回應 includeIps 為 true 且帶回 topSrc / topDst 時才顯示(TS-2 審查結論) -->
          <div v-if="showIps && ((item.topSrc?.length ?? 0) > 0 || (item.topDst?.length ?? 0) > 0)" class="ip-grid">
            <div class="ip-col">
              <h4 class="xs muted">前 10 來源 IP</h4>
              <ul v-if="item.topSrc?.length" class="ip-list">
                <li v-for="src in item.topSrc" :key="src.ip" class="ip-row xs">
                  <RouterLink :to="detailLink(item, src.ip)" class="ip-link mono">{{ src.ip }}</RouterLink>
                  <span v-if="formatIpName(sig.nameOfIp(src.ip))" class="ip-who">
                    {{ formatIpName(sig.nameOfIp(src.ip)) }}
                  </span>
                  <span class="mono muted ip-cnt">{{ fmtNum(src.count) }}</span>
                </li>
              </ul>
              <span v-else class="xs muted">—</span>
            </div>

            <div class="ip-col">
              <h4 class="xs muted">前 10 目的 IP</h4>
              <ul v-if="item.topDst?.length" class="ip-list">
                <li v-for="dst in item.topDst" :key="dst.ip" class="ip-row xs">
                  <RouterLink :to="detailLink(item, dst.ip)" class="ip-link mono">{{ dst.ip }}</RouterLink>
                  <span v-if="formatIpName(sig.nameOfIp(dst.ip))" class="ip-who">
                    {{ formatIpName(sig.nameOfIp(dst.ip)) }}
                  </span>
                  <span class="mono muted ip-cnt">{{ fmtNum(dst.count) }}</span>
                </li>
              </ul>
              <span v-else class="xs muted">—</span>
            </div>
          </div>
        </GCard>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hits-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ctrl-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-end;
}
.field-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-lbl {
  font-weight: 500;
}
.ids-input {
  min-width: 260px;
  flex: 1;
}
.ctrl-btns {
  display: flex;
  gap: 8px;
}
.mt-2 {
  margin-top: 12px;
}
.mb-0 {
  margin-bottom: 0;
}
.job-status {
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
  animation: hit-spin 0.8s linear infinite;
}
@keyframes hit-spin {
  to {
    transform: rotate(360deg);
  }
}
.result-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.hit-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hit-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hit-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hit-title {
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
  cursor: pointer;
  text-align: left;
}
.sig-link:hover {
  text-decoration: underline;
}
.hit-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.stat-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.sub-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.rule-chip-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.rule-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.rule-btn:hover {
  text-decoration: underline;
}
.mini-badge {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
}
.ip-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
@media (max-width: 720px) {
  .ip-grid {
    grid-template-columns: 1fr;
  }
}
.ip-col h4 {
  margin: 0 0 6px;
  font-weight: 600;
}
.ip-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ip-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ip-link {
  color: var(--c-primary-text);
  text-decoration: none;
}
.ip-link:hover {
  text-decoration: underline;
}
.ip-who {
  padding: 0 6px;
  border-radius: 5px;
  background: var(--grad-brand-soft);
  color: var(--c-primary-text);
  font-size: 11px;
}
.ip-cnt {
  margin-left: auto;
}
</style>
