<script setup lang="ts">
/**
 * 防火牆 › 即時監控(R1,PA-LIVE-PLAN §8、docs/API.md §3.2):
 *   設備狀態(快照 + 最近 1 小時趨勢)、即時排行(5 / 15 / 60 分鐘)、即時 log(SSE,可篩選、暫停)。
 *   資料來源是收集器 netops-pa 寫入的 Redis;收集器停止、未啟用或 Redis 連不上時明確顯示「停止更新」,
 *   不把舊資料當即時(AGENT.md §5)。超過保留期間(TRAFFIC 明細 1 小時、統計 1 天;其他 2 天)引導到 Log 明細查詢與總覽(FTP)。
 *   頁首分開顯示輪詢(設備狀態的來源)與接收(排行、即時 log 的來源)狀態;測試區另有暫停 / 繼續按鈕(UI.paLiveManage,2026-11-09 需求方決定)。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { can, describeError } from '@/api/gateway';
import { UI } from '@/api/perms';
import { toast } from '@/ui/feedback';
import { fmtNum, fmtShort, fmtSize, fmtTime } from '@/api/format';
import { LOG_TYPES, paLive, type LiveLog, type LogType, type PaLiveSnapshot, type PaLiveTop } from '@/api/paLive';
import type { Column } from '@/ui/components/GTable.vue';
import TopList from '@/components/TopList.vue';
import { collectorBadges, collectorView, controlView, fmtBps, interfaceView, latestSnapTime, logSource, parseFilter, useLiveStream } from '@/composables/paLive';
import { usePolling } from '@/composables/usePolling';

// ---------- 設備狀態(串流的 snapshot 事件;串流連不上時退回每 10 秒輪詢) ----------
const snap = shallowRef<PaLiveSnapshot | null>(null);
const snapError = ref<Error | null>(null);
const view = computed(() => collectorView(snap.value?.collector));
// 快照取得失敗(API 錯誤)時不顯示上一次的數字(AGENT.md §5)
const m = computed(() => (snapError.value ? undefined : snap.value?.metrics));
const c = computed(() => snap.value?.collector);
const badges = computed(() => (snapError.value ? [] : collectorBadges(c.value)));
// 排行與即時 log 來自接收端點(與設備狀態的輪詢分開說明)
const source = computed(() => logSource(snapError.value ? null : c.value));
const snapTime = computed(() => latestSnapTime(m.value));
// 介面流量:輪詢暫停或快照過期時顯示「停止更新」,不顯示暫停前最後一輪的值(驗收 2026-11-10 §4.4-1)
const ifs = computed(() => interfaceView(snapError.value ? null : c.value, m.value?.interfaces));

// ---------- 測試區暫停 / 繼續(正式區 control.available 為 false,不顯示) ----------
const ctl = computed(() => controlView(snapError.value ? null : c.value, snap.value?.control, can(UI.paLiveManage)));
const switching = ref<'poll' | 'receive' | null>(null);
async function toggle(which: 'poll' | 'receive') {
  const paused = !ctl.value[which].paused;
  switching.value = which;
  try {
    const control = await paLive.setControl(which === 'poll' ? { pollPaused: paused } : { receivePaused: paused });
    if (snap.value) snap.value = { ...snap.value, control };
    const what = which === 'poll' ? '輪詢' : '接收';
    toast.success(`已要求${paused ? '暫停' : '繼續'}${what}`, `收集器${which === 'poll' ? '在下一次輪詢前' : '在 5 秒內'}套用;頁首狀態會在下一次更新時改變`);
    void snapPoll.run();
  } catch (e) {
    toast.fromError(e, '切換失敗');
  } finally {
    switching.value = null;
  }
}

const stream = useLiveStream((s) => {
  snap.value = s;
  snapError.value = null;
});

// 串流超過 40 秒沒有任何事件(心跳 15 秒)= 連線可能卡住
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 5000);
const streamStale = computed(() => stream.lastEventAt.value !== null && now.value - stream.lastEventAt.value > 40_000);

const snapPoll = usePolling(
  () => paLive.snapshot(),
  (r) => {
    if (r instanceof Error) snapError.value = r;
    else {
      snap.value = r;
      snapError.value = null;
    }
    // 串流正常時不輪詢(串流每 10 秒送 snapshot);串流卡住(40 秒沒有事件)時照樣輪詢
    return !stream.connected.value || streamStale.value;
  },
  10_000,
);

// ---------- 趨勢(每分鐘更新) ----------
type Point = Record<string, unknown> & { time?: string };
const cpuSeries = shallowRef<Point[]>([]);
const sessSeries = shallowRef<Point[]>([]);
const thrSeries = shallowRef<Point[]>([]);
const seriesError = ref<Error | null>(null);
const seriesPoll = usePolling(
  () => Promise.all([paLive.series('cpu'), paLive.series('session'), paLive.series('throughput')]),
  (r) => {
    if (r instanceof Error) seriesError.value = r;
    else {
      const [cpu, sess, thr] = r;
      cpuSeries.value = cpu.points as Point[];
      sessSeries.value = sess.points as Point[];
      thrSeries.value = thr.points as Point[];
      seriesError.value = null;
    }
    return true;
  },
  60_000,
);
const hhmm = (p: Point) => (p.time ? new Date(p.time).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const cpuChart = computed(() => ({
  labels: cpuSeries.value.map(hhmm),
  series: [
    { name: '管理平面', values: cpuSeries.value.map((p) => num(p.mgmt)), area: true },
    { name: '資料平面', values: cpuSeries.value.map((p) => num(p.dataplane)) },
  ],
}));
const sessChart = computed(() => ({ labels: sessSeries.value.map(hhmm), series: [{ name: 'Session', values: sessSeries.value.map((p) => num(p.active)), area: true }] }));
const thrChart = computed(() => ({ labels: thrSeries.value.map(hhmm), series: [{ name: 'Mbps', values: thrSeries.value.map((p) => Math.round(num(p.bps) / 1e5) / 10), area: true }] }));

// ---------- 即時排行 ----------
const TOP_MINUTES = [
  { label: '5 分鐘', value: '5' },
  { label: '15 分鐘', value: '15' },
  { label: '60 分鐘', value: '60' },
];
const topType = ref<LogType>('traffic');
const topMinutesStr = ref('15');
const topMinutes = computed(() => Number(topMinutesStr.value) as 5 | 15 | 60);
const top = shallowRef<PaLiveTop | null>(null);
const topError = ref<Error | null>(null);
const topLoading = ref(false);
const DIM_TITLES: Record<string, string> = {
  src: '來源 IP',
  dst: '目的 IP',
  app: 'App',
  rule: '規則',
  port: 'Port',
  srcBytes: '來源 IP(流量)',
  dstBytes: '目的 IP(流量)',
  appBytes: 'App(流量)',
  name: '名稱',
  host: '網站',
  category: '類別',
  user: '使用者',
  filetype: '檔案類型',
  error: '錯誤',
  sni: '網站(SNI)',
  publicIp: '外部 IP',
  region: '地區',
  ip: 'IP',
  action: 'Action',
  proto: '協定',
  severity: '嚴重度',
  subtype: '類型',
  direction: '方向',
  verdict: '判定',
  status: '狀態',
  errIndex: '錯誤階段',
  tls: 'TLS 版本',
  eventId: '事件',
};
const topPoll = usePolling(
  () => {
    topLoading.value = true;
    return paLive.top(topType.value, topMinutes.value, 10);
  },
  (r) => {
    topLoading.value = false;
    if (r instanceof Error) topError.value = r;
    else {
      top.value = r;
      topError.value = null;
    }
    return true;
  },
  30_000,
);
watch([topType, topMinutes], () => {
  top.value = null;
  void topPoll.run();
});
const topLists = computed(() =>
  Object.entries(top.value?.tops ?? {})
    .filter(([, items]) => items.length)
    .map(([dim, items]) => ({
      dim,
      title: DIM_TITLES[dim] ?? dim,
      byBytes: dim.endsWith('Bytes'),
      items: items.map((x) => (dim.endsWith('Bytes') ? { key: x.key, n: 0, bytes: x.value } : { key: x.key, n: x.value })),
    })),
);
const kpiLists = computed(() => Object.entries(top.value?.kpis ?? {}).map(([k, v]) => ({ key: k, items: Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 6) })));

// ---------- 即時 log ----------
const logType = ref<LogType>('traffic');
const raw = reactive({ ip: '', port: '', action: '' });
const parsed = computed(() => parseFilter(raw));
const applied = ref(parseFilter(raw).filter);
const earliest = ref<string | null>(null);
const preloadError = ref<Error | null>(null);

let logSeq = 0;
async function startLogs() {
  const my = ++logSeq;
  const filter = applied.value;
  stream.connect([logType.value], filter);
  try {
    const r = await paLive.logs(logType.value, filter, 100);
    // 期間已切換類型或篩選:丟棄舊請求的結果,不混進新清單
    if (my !== logSeq) return;
    earliest.value = r.earliest;
    preloadError.value = null;
    stream.preload(r.items);
  } catch (e) {
    if (my === logSeq) preloadError.value = e as Error;
  }
}
function applyFilter() {
  if (parsed.value.error) return;
  applied.value = parsed.value.filter;
  void startLogs();
}
watch(logType, () => void startLogs());

const logColumns = computed<Column[]>(() => {
  const base: Column[] = [{ key: 'receivedAt', label: '收到時間', width: '96px' }];
  if (logType.value === 'traffic')
    return [
      ...base,
      { key: 'action', label: 'Action', width: '84px' },
      { key: 'src', label: '來源', mono: true },
      { key: 'dst', label: '目的', mono: true },
      { key: 'dport', label: 'Port', width: '70px', align: 'right' },
      { key: 'app', label: 'App' },
      { key: 'rule', label: '規則', hideSm: true },
      { key: 'bytes', label: '位元組', align: 'right', hideSm: true },
    ];
  if (logType.value === 'globalprotect')
    return [...base, { key: 'status', label: '結果' }, { key: 'user', label: '帳號' }, { key: 'publicIp', label: '外部 IP', mono: true }, { key: 'eventId', label: '事件' }];
  if (logType.value === 'userid') return [...base, { key: 'subtype', label: '事件' }, { key: 'ip', label: 'IP', mono: true }, { key: 'user', label: '使用者' }];
  return [
    ...base,
    { key: 'action', label: 'Action', width: '84px' },
    { key: 'severity', label: '嚴重度', width: '84px' },
    { key: 'src', label: '來源', mono: true },
    { key: 'dst', label: '目的', mono: true },
    // PA 的 HTTP Payload 要加 sport 變數才有值;沒有或為 0 顯示「—」
    { key: 'sport', label: '來源 Port', width: '84px', align: 'right', hideSm: true },
    // URL 過濾的 threatid 固定是 9999(名稱欄只會是「9999(9999)」),改顯示 URL 類別(驗收 2026-11-10 §4.4-4)
    logType.value === 'url' ? { key: 'category', label: 'URL 類別' } : { key: 'name', label: '名稱' },
    { key: 'url', label: 'URL / 檔名', hideSm: true },
  ];
});
const clock = (iso: unknown) => (typeof iso === 'string' ? new Date(iso).toLocaleTimeString('zh-TW', { hour12: false }) : '—');
const BAD = /^(deny|drop|reset|block|critical|high|failure|malware|phishing)/i;
const retentionText = computed(() => (logType.value === 'traffic' ? '最近 1 小時' : '最近 2 天'));
const rows = computed(() => stream.logs.value.map((x: LiveLog) => ({ ...x, key: `${x.type}:${x.id}` }) as LiveLog & { key: string }));


onMounted(() => {
  void snapPoll.run();
  void seriesPoll.run();
  void topPoll.run();
  void startLogs();
});
// 串流斷線或卡住:恢復輪詢快照
watch([stream.connected, streamStale], ([on, stale]) => {
  if (!on || stale) void snapPoll.run();
});
onBeforeUnmount(() => {
  clearInterval(tick);
  stream.close();
});

function refresh() {
  void snapPoll.run();
  void seriesPoll.run();
  void topPoll.run();
  void startLogs();
}
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <GBadge :tone="stream.connected.value && !streamStale ? 'success' : 'neutral'" dot>{{ stream.connected.value && !streamStale ? '串流連線中' : '串流未連線' }}</GBadge>
      <GButton icon="refresh" @click="refresh">重新整理</GButton>
    </Teleport>

    <!-- 收集器狀態:不是 ok 一律明確提示 -->
    <GAlert v-if="snapError" tone="danger" title="無法取得即時監控狀態,資料停止更新">{{ describeError(snapError) }}</GAlert>
    <GAlert v-else-if="c && c.state !== 'ok'" :tone="view.tone === 'neutral' ? 'neutral' : view.tone" :title="view.title">
      {{ c.message }}
      <template v-if="c.updatedAt">(收集器最後更新 {{ fmtTime(c.updatedAt) }})</template>
      <span v-if="c.poll.error" class="block small">輪詢錯誤:{{ c.poll.error }}({{ fmtTime(c.poll.errorAt) }})</span>
      <span v-if="c.redis.error" class="block small">Redis 寫入錯誤:{{ c.redis.error }}</span>
      <span v-if="!view.live" class="block small">更早或歷史資料請用「Log 明細查詢」與「流量總覽 / 安全事件」(FTP)。</span>
    </GAlert>
    <GAlert v-if="stream.streamError.value" tone="warning">{{ stream.streamError.value }}</GAlert>

    <!-- 收集器狀態:輪詢 → 設備狀態;接收 → 排行與即時 log(驗收 §7.4-1、§7.4-2) -->
    <GCard v-if="badges.length || ctl.visible" title="收集器" icon="radio" padding="sm">
      <div class="collector">
        <div class="row">
          <GBadge v-for="b in badges" :key="b.key" :tone="b.tone" dot>{{ b.text }}</GBadge>
          <span class="small muted">設備狀態來自 SDK 輪詢;排行與即時 log 來自接收端點(HTTP / Syslog)</span>
        </div>
        <div v-if="ctl.visible" class="row">
          <span class="small strong">測試區開關</span>
          <GButton
            size="sm"
            :icon="ctl.poll.paused ? 'play' : 'pause'"
            :disabled="ctl.poll.disabled || switching !== null"
            :loading="switching === 'poll'"
            :title="ctl.poll.reason || undefined"
            @click="toggle('poll')"
            >輪詢:{{ ctl.poll.paused ? '開啟' : '停用' }}</GButton
          >
          <GButton
            size="sm"
            :icon="ctl.receive.paused ? 'play' : 'pause'"
            :disabled="ctl.receive.disabled || switching !== null"
            :loading="switching === 'receive'"
            :title="ctl.receive.reason || undefined"
            @click="toggle('receive')"
            >接收:{{ ctl.receive.paused ? '開啟' : '停用' }}</GButton
          >
          <span v-if="snap?.control?.updatedAt" class="small muted">最後由 {{ snap.control.updatedBy ?? '—' }} 於 {{ fmtTime(snap.control.updatedAt) }} 切換</span>
        </div>
        <p v-if="ctl.visible && (ctl.poll.reason || ctl.receive.reason)" class="small muted">
          <span v-if="ctl.poll.reason" class="block">輪詢:{{ ctl.poll.reason }}</span>
          <span v-if="ctl.receive.reason && ctl.receive.reason !== ctl.poll.reason" class="block">接收:{{ ctl.receive.reason }}</span>
        </p>
      </div>
    </GCard>

    <p class="small muted">設備狀態最後更新:{{ snapTime ? fmtTime(snapTime) : '—(沒有 60 秒內的資料)' }}</p>

    <!-- 設備狀態 -->
    <div class="grid kpis">
      <GStatCard
        label="Session"
        icon="activity"
        :value="m?.session?.active != null ? fmtShort(m.session.active) : '停止更新'"
        :hint="m?.session ? `使用率 ${m.session.utilization ?? '—'}%(上限 ${fmtNum(m.session.max)})` : '沒有 60 秒內的資料'"
        :tone="m?.session ? 'primary' : 'neutral'"
      />
      <GStatCard
        label="管理平面 CPU"
        icon="cpu"
        :value="m?.cpu?.mgmt != null ? `${m.cpu.mgmt}%` : '停止更新'"
        :hint="m?.cpu?.memTotal ? `記憶體 ${fmtSize(m.cpu.memUsed)} / ${fmtSize(m.cpu.memTotal)}` : '沒有 60 秒內的資料'"
        :tone="m?.cpu ? 'primary' : 'neutral'"
      />
      <GStatCard label="資料平面 CPU" icon="gauge" :value="m?.cpu?.dataplane != null ? `${m.cpu.dataplane}%` : '停止更新'" :tone="m?.cpu ? 'primary' : 'neutral'" />
      <GStatCard
        label="整體流量"
        icon="zap"
        :value="m?.throughput ? fmtBps(m.throughput.bps) : '停止更新'"
        :hint="m?.throughput ? `${fmtNum(m.throughput.pps)} pps · 每秒新連線 ${fmtNum(m.throughput.cps)}` : '沒有 60 秒內的資料'"
        :tone="m?.throughput ? 'primary' : 'neutral'"
      />
    </div>

    <GAlert v-if="seriesError" tone="warning">趨勢載入失敗:{{ describeError(seriesError) }}</GAlert>
    <div class="grid charts">
      <GCard title="CPU(最近 1 小時)" icon="cpu">
        <GAreaChart v-if="cpuSeries.length > 1" :labels="cpuChart.labels" :series="cpuChart.series" :height="160" unit="%" />
        <p v-else class="small muted">沒有趨勢資料</p>
      </GCard>
      <GCard title="Session(最近 1 小時)" icon="activity">
        <GAreaChart v-if="sessSeries.length > 1" :labels="sessChart.labels" :series="sessChart.series" :height="160" />
        <p v-else class="small muted">沒有趨勢資料</p>
      </GCard>
      <GCard title="流量(最近 1 小時)" icon="zap">
        <GAreaChart v-if="thrSeries.length > 1" :labels="thrChart.labels" :series="thrChart.series" :height="160" unit=" Mbps" />
        <p v-else class="small muted">沒有趨勢資料</p>
      </GCard>
    </div>

    <GCard v-if="ifs.visible" title="介面流量" icon="gateway" padding="sm">
      <p v-if="!ifs.items.length" class="small muted"><strong>停止更新</strong>({{ ifs.stale }})</p>
      <ul v-else class="ifs">
        <li v-for="i in ifs.items" :key="i.name">
          <span class="mono">{{ i.name }}</span>
          <span class="muted small">↓ {{ fmtBps(i.rxBps) }} · ↑ {{ fmtBps(i.txBps) }}</span>
        </li>
      </ul>
    </GCard>

    <!-- 即時排行 -->
    <GCard title="即時排行" icon="trending-up">
      <template #actions>
        <div class="row">
          <GSelect v-model="topType" :options="LOG_TYPES.map((t) => ({ label: t.label, value: t.value }))" size="sm" />
          <GSegmented v-model="topMinutesStr" size="sm" :options="TOP_MINUTES" />
        </div>
      </template>
      <GAlert v-if="topError" tone="danger">{{ describeError(topError) }}</GAlert>
      <GSkeleton v-else-if="!top && topLoading" :lines="4" />
      <template v-else-if="top">
        <GAlert v-if="!source.live && topLists.length" tone="warning">{{ source.stale }}</GAlert>
        <p class="small muted">
          最近 {{ top.minutes }} 分鐘:{{ fmtNum(top.totals.count ?? 0) }} 筆<template v-if="top.totals.bytes">、{{ fmtSize(top.totals.bytes) }}</template>
          <template v-if="top.type !== 'traffic'">(已乘上重複次數)</template>;每分鐘只保留前 200 名,排行為近似值。
        </p>
        <div v-if="kpiLists.length" class="grid kpis">
          <div v-for="k in kpiLists" :key="k.key" class="kpi">
            <strong class="small">{{ DIM_TITLES[k.key] ?? k.key }}</strong>
            <ul>
              <li v-for="[key, n] in k.items" :key="key">
                <span class="ellipsis" :class="BAD.test(key) ? 'c-danger strong' : ''">{{ key }}</span><span class="num muted">{{ fmtNum(n) }}</span>
              </li>
            </ul>
          </div>
        </div>
        <div v-if="topLists.length" class="grid tops">
          <TopList v-for="t in topLists" :key="t.dim" :title="t.title" :items="t.items" :by-bytes="t.byBytes" :show-bytes="t.byBytes" :pickable="() => false" />
        </div>
        <GEmpty v-else icon="activity" :title="source.live ? '這段期間沒有資料' : '沒有 log 來源'" :description="source.empty" />
      </template>
    </GCard>

    <!-- 即時 log -->
    <GCard title="即時 log" icon="radio">
      <template #actions>
        <GButton size="sm" :icon="stream.paused.value ? 'play' : 'pause'" @click="stream.setPaused(!stream.paused.value)">{{ stream.paused.value ? '繼續' : '暫停' }}</GButton>
      </template>
      <div class="stack" style="--gap: 10px">
        <GSegmented v-model="logType" size="sm" :options="LOG_TYPES.map((t) => ({ label: t.label, value: t.value }))" class="types" />
        <form class="filters" @submit.prevent="applyFilter">
          <GInput v-model="raw.ip" label="IP" placeholder="10.1.2.3" class="f" />
          <GInput v-model="raw.port" label="Port" placeholder="443" class="f-sm" />
          <GInput v-model="raw.action" label="Action" placeholder="deny" class="f-sm" />
          <GButton type="submit" icon="filter" :disabled="!!parsed.error">套用</GButton>
          <p v-if="parsed.error" class="small c-danger">{{ parsed.error }}</p>
        </form>
        <p class="small muted">
          只保留{{ retentionText }}<template v-if="earliest">(Redis 最早 {{ fmtTime(earliest) }})</template>,畫面最多顯示 500 筆;更早的到
          <RouterLink to="/firewall/search">Log 明細查詢</RouterLink>(FTP)。
          <template v-if="stream.paused.value"><strong>已暫停</strong>,新的 log 先暫存。</template>
          <template v-if="stream.skipped.value"> 流量太大時部分 log 未顯示({{ fmtNum(stream.skipped.value) }} 次)。</template>
        </p>
        <GAlert v-if="stream.degraded.value" tone="warning">{{ stream.degraded.value.types.join('、') }} 讀取失敗,log 暫停更新:{{ stream.degraded.value.message }}</GAlert>
        <GAlert v-if="!source.live && rows.length" tone="warning">{{ source.stale }}</GAlert>
        <GAlert v-if="preloadError" tone="danger">最近的 log 載入失敗:{{ describeError(preloadError) }}</GAlert>
        <GTable :columns="logColumns" :rows="rows" row-key="key" :page-size="50" dense empty-title="還沒有 log" :empty-description="source.live ? '等待新的 log…' : source.empty">
          <template #cell-receivedAt="{ row }">{{ clock(row.receivedAt) }}</template>
          <template #cell-action="{ row }"><span :class="BAD.test(String(row.action ?? '')) ? 'c-danger strong' : ''">{{ row.action ?? '—' }}</span></template>
          <template #cell-severity="{ row }"><span :class="BAD.test(String(row.severity ?? '')) ? 'c-danger strong' : ''">{{ row.severity ?? '—' }}</span></template>
          <template #cell-sport="{ row }">{{ typeof row.sport === 'number' && row.sport > 0 ? row.sport : '—' }}</template>
          <template #cell-bytes="{ row }">{{ typeof row.bytes === 'number' ? fmtSize(row.bytes) : '—' }}</template>
          <template #cell-url="{ row }"><span class="ellipsis url">{{ row.url ?? '—' }}</span></template>
        </GTable>
      </div>
    </GCard>
  </div>
</template>

<style scoped>
.kpis {
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}
.charts {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.tops {
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.block {
  display: block;
}
.collector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ifs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 4px 16px;
}
.ifs li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.kpi ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: var(--fs-sm);
}
.kpi li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.types {
  max-width: 100%;
  overflow-x: auto;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  align-items: flex-end;
}
.f {
  width: 200px;
}
.f-sm {
  width: 120px;
}
.url {
  max-width: 320px;
  display: inline-block;
}
</style>
