<script setup lang="ts">
/**
 * 戰情室系統狀態收摺抽屜(WR-5;WARROOM-GEMINI-HANDOFF §2、§3、WARROOM-PLAN Q1):
 *   - 顯示收集器狀態(collectorView、collectorBadges)、最後更新時間、介面流量(interfaceView)
 *   - 測試區暫停 / 繼續開關:controlView + w.setControl({ pollPaused, receivePaused })
 *   - 內嵌 C5 PA 精準查詢(PaQueryPanel)與歷史 Log 明細查詢入口連結
 */
import { computed, ref } from 'vue';
import { fmtNum, fmtSize, fmtTime } from '@/api/format';
import type { CollectorControl, PaLiveSnapshot } from '@/api/paLive';
import { collectorBadges, collectorView, controlView, fmtBps, interfaceView, latestSnapTime } from '@/composables/paLive';
import PaQueryPanel from '@/components/PaQueryPanel.vue';
import GDrawer from '@/ui/components/GDrawer.vue';
import { toast } from '@/ui/feedback';

const props = defineProps<{
  modelValue: boolean;
  snapshot: PaLiveSnapshot | null;
  connected: boolean;
  /** 測試區暫停開關權限(useWarroom().canManage) */
  canManage: boolean;
  streamError?: string;
  setControl: (change: { pollPaused?: boolean; receivePaused?: boolean }) => Promise<CollectorControl>;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const c = computed(() => props.snapshot?.collector ?? null);
const m = computed(() => props.snapshot?.metrics ?? null);
const view = computed(() => collectorView(c.value));
const badges = computed(() => collectorBadges(c.value));
const snapTime = computed(() => latestSnapTime(m.value));
const ifs = computed(() => interfaceView(c.value, m.value?.interfaces));
const ctl = computed(() => controlView(c.value, props.snapshot?.control, props.canManage));

const switching = ref<'poll' | 'receive' | null>(null);

async function toggle(which: 'poll' | 'receive') {
  const paused = !ctl.value[which].paused;
  switching.value = which;
  try {
    await props.setControl(which === 'poll' ? { pollPaused: paused } : { receivePaused: paused });
    const what = which === 'poll' ? '輪詢' : '接收';
    toast.success(`已要求${paused ? '暫停' : '繼續'}${what}`, `收集器${which === 'poll' ? '在下一次輪詢前' : '在 5 秒內'}套用`);
  } catch (e) {
    toast.fromError(e, '切換失敗');
  } finally {
    switching.value = null;
  }
}
</script>

<template>
  <GDrawer :model-value="modelValue" title="系統與收集器狀態" @update:model-value="emit('update:modelValue', $event)">
    <template #actions>
      <GBadge :tone="connected ? 'success' : 'neutral'" dot>{{ connected ? '串流連線中' : '串流未連線' }}</GBadge>
    </template>

    <div class="stack" style="--gap: 14px">
      <GAlert v-if="c && c.state !== 'ok'" :tone="view.tone === 'neutral' ? 'neutral' : view.tone" :title="view.title">
        {{ c.message }}
        <template v-if="c.updatedAt">（收集器最後更新 {{ fmtTime(c.updatedAt) }}）</template>
        <span v-if="c.poll.error" class="block small">輪詢錯誤：{{ c.poll.error }}（{{ fmtTime(c.poll.errorAt) }}）</span>
        <span v-if="c.redis.error" class="block small">Redis 寫入錯誤：{{ c.redis.error }}</span>
      </GAlert>

      <GAlert v-if="streamError" tone="warning">{{ streamError }}</GAlert>

      <GCard title="收集器狀態" icon="radio" padding="sm">
        <div class="sys-drawer__collector">
          <div class="sys-drawer__row">
            <GBadge v-if="!badges.length" tone="neutral" dot>{{ view.title }}</GBadge>
            <GBadge v-for="b in badges" :key="b.key" :tone="b.tone" dot>{{ b.text }}</GBadge>
          </div>
          <p class="small muted">設備狀態來自 SDK 輪詢；戰情室節點與即時 log 來自接收端點（HTTP / Syslog）。</p>
          <p class="small muted">設備狀態最後更新：{{ snapTime ? fmtTime(snapTime) : '—（沒有 60 秒內的資料）' }}</p>

          <div v-if="ctl.visible" class="sys-drawer__row sys-drawer__ctl">
            <span class="small strong">測試區開關</span>
            <GButton
              size="sm"
              :icon="ctl.poll.paused ? 'play' : 'pause'"
              :disabled="ctl.poll.disabled || switching !== null"
              :loading="switching === 'poll'"
              :title="ctl.poll.reason || undefined"
              @click="toggle('poll')"
            >
              輪詢：{{ ctl.poll.paused ? '開啟' : '停用' }}
            </GButton>
            <GButton
              size="sm"
              :icon="ctl.receive.paused ? 'play' : 'pause'"
              :disabled="ctl.receive.disabled || switching !== null"
              :loading="switching === 'receive'"
              :title="ctl.receive.reason || undefined"
              @click="toggle('receive')"
            >
              接收：{{ ctl.receive.paused ? '開啟' : '停用' }}
            </GButton>
            <span v-if="snapshot?.control?.updatedAt" class="small muted">
              最後由 {{ snapshot.control.updatedBy ?? '—' }} 於 {{ fmtTime(snapshot.control.updatedAt) }} 切換
            </span>
          </div>

          <p v-if="ctl.visible && (ctl.poll.reason || ctl.receive.reason)" class="small muted">
            <span v-if="ctl.poll.reason" class="block">輪詢：{{ ctl.poll.reason }}</span>
            <span v-if="ctl.receive.reason && ctl.receive.reason !== ctl.poll.reason" class="block">接收：{{ ctl.receive.reason }}</span>
          </p>
        </div>
      </GCard>

      <GCard title="設備指標明細" icon="cpu" padding="sm">
        <div class="sys-drawer__metrics">
          <div>
            <span class="small muted">管理平面 CPU</span>
            <strong>{{ m?.cpu?.mgmt != null ? `${Math.round(m.cpu.mgmt)}%` : '停止更新' }}</strong>
          </div>
          <div>
            <span class="small muted">資料平面 CPU</span>
            <strong>{{ m?.cpu?.dataplane != null ? `${Math.round(m.cpu.dataplane)}%` : '停止更新' }}</strong>
          </div>
          <div>
            <span class="small muted">記憶體</span>
            <strong>{{ m?.cpu?.memTotal ? `${fmtSize(m.cpu.memUsed)} / ${fmtSize(m.cpu.memTotal)}` : '—' }}</strong>
          </div>
          <div>
            <span class="small muted">Session 使用率</span>
            <strong>
              {{ m?.session?.active != null ? `${fmtNum(m.session.active)} / ${fmtNum(m.session.max)} (${Math.round(m.session.utilization ?? 0)}%)` : '停止更新' }}
            </strong>
          </div>
        </div>
      </GCard>

      <GCard v-if="ifs.visible" title="介面流量" icon="gateway" padding="sm">
        <p v-if="!ifs.items.length" class="small muted"><strong>停止更新</strong>（{{ ifs.stale }}）</p>
        <ul v-else class="sys-drawer__ifs">
          <li v-for="i in ifs.items" :key="i.name">
            <span class="mono">{{ i.name }}</span>
            <span class="muted small">↓ {{ fmtBps(i.rxBps) }} · ↑ {{ fmtBps(i.txBps) }}</span>
          </li>
        </ul>
      </GCard>

      <PaQueryPanel />

      <GCard title="歷史與進階查詢" icon="search" padding="sm">
        <p class="small muted" style="margin: 0 0 8px">
          即時監控只保留短期 Redis 資料（TRAFFIC 明細 1 小時、統計 1 天；其他類型 2 天）。查詢歷史明細或長期分析請前往：
        </p>
        <div class="sys-drawer__row">
          <RouterLink to="/firewall/search"><GButton size="sm" variant="secondary" icon="search">Log 明細查詢</GButton></RouterLink>
          <RouterLink to="/firewall/dashboard"><GButton size="sm" variant="secondary" icon="shield-check">流量總覽</GButton></RouterLink>
          <RouterLink to="/firewall/events"><GButton size="sm" variant="secondary" icon="shield-alert">安全事件</GButton></RouterLink>
        </div>
      </GCard>
    </div>
  </GDrawer>
</template>

<style scoped>
.sys-drawer__collector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sys-drawer__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sys-drawer__ctl {
  padding-top: 6px;
  border-top: 1px solid var(--line);
}
.sys-drawer__metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.sys-drawer__metrics div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sys-drawer__ifs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.sys-drawer__ifs li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.block {
  display: block;
}
</style>
