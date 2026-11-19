<script setup lang="ts">
/**
 * 防火牆 › 安全規則 — 分頁 3:排序檢查(PR-4,資料來自 PR-5 usePaPolicyCheck)
 *   - 門檻輸入 c.unusedDays(預設 90)→ c.load()
 *   - c.summary 摘要數字;c.imprecise > 0 提示「有 N 條規則含無法精準比對的條件」
 *   - 依嚴重度(SEVERITY_LABELS)或項目(CHECK_LABELS)分組列出 c.items
 *   - 「無法判定」(undeterminable)不可顯示成沒問題,並列出 reasons
 *   - AI 判讀按鈕只在 c.canAi 時顯示 → c.runAi(),回答區上方固定顯示 AI_DISCLAIMER
 */
import { computed, ref } from 'vue';
import { fmtNum } from '@/api/format';
import { describeError } from '@/api/gateway';
import type { CheckCode, CheckItem, CheckSeverity } from '@/api/paPolicy';
import AiMarkdown from '@/components/AiMarkdown.vue';
import { AI_FLAG_LABELS } from '@/composables/useAiExplain';
import { AI_DISCLAIMER, CHECK_LABELS, SEVERITY_LABELS } from '@/composables/usePaPolicyCheck';
import { CHECK_CODES_ORDER, SEVERITY_TONES, type PaPolicyCheckStore } from './types';

const props = defineProps<{
  check: PaPolicyCheckStore;
}>();
const emit = defineEmits<{ (e: 'open-rule', name: string): void }>();

const groupBy = ref<'severity' | 'code'>('severity');
const GROUP_OPTIONS = [
  { label: '依嚴重度', value: 'severity' },
  { label: '依檢查項目', value: 'code' },
];
const SEVERITY_ORDER: CheckSeverity[] = ['high', 'medium', 'low', 'info'];

const unusedDaysModel = computed({
  get: () => String(props.check.unusedDays),
  set: (v: string) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) props.check.unusedDays = Math.floor(n);
  },
});

const summaryCards = computed(() => {
  const s = props.check.summary;
  if (!s) return [];
  return CHECK_CODES_ORDER.map((code) => ({
    code,
    label: CHECK_LABELS[code],
    count: s[code] ?? 0,
  }));
});

interface CheckGroup {
  key: string;
  label: string;
  tone: string;
  items: CheckItem[];
}

const groups = computed<CheckGroup[]>(() => {
  if (groupBy.value === 'severity') {
    return SEVERITY_ORDER.map((sev) => ({
      key: sev,
      label: `嚴重度：${SEVERITY_LABELS[sev]}`,
      tone: SEVERITY_TONES[sev],
      items: props.check.bySeverity(sev),
    })).filter((g) => g.items.length > 0);
  }
  return CHECK_CODES_ORDER.map((code) => ({
    key: code,
    label: CHECK_LABELS[code],
    tone: codeTone(code),
    items: props.check.byCode(code),
  })).filter((g) => g.items.length > 0);
});

function codeTone(code: CheckCode): string {
  if (code === 'conflict' || code === 'shadowed') return 'danger';
  if (code === 'broad-early' || code === 'redundant' || code === 'undeterminable') return 'warning';
  if (code === 'unused' || code === 'no-profile' || code === 'no-log-end') return 'info';
  return 'neutral';
}

const aiStarted = computed(
  () => props.check.ai.phase !== 'idle' || !!props.check.ai.text || !!props.check.ai.error || props.check.ai.notices.length > 0,
);
const aiRunning = computed(() => props.check.ai.running);

const hasUndeterminable = computed(() => props.check.byCode('undeterminable').length > 0);
</script>

<template>
  <div class="check-tab">
    <GCard class="ctrl-card">
      <div class="ctrl-row">
        <GInput
          v-model="unusedDaysModel"
          label="長期未命中門檻 (天)"
          type="number"
          class="days-input"
          @keydown.enter.prevent="check.load()"
        />
        <GButton variant="primary" icon="spec" :loading="check.loading" @click="check.load()">
          執行排序檢查
        </GButton>

        <GSegmented v-model="groupBy" :options="GROUP_OPTIONS" />

        <div class="spacer" />

        <template v-if="check.canAi">
          <GButton v-if="aiRunning" variant="danger" icon="x" @click="check.ai.stop()">
            停止 AI 判讀
          </GButton>
          <GButton
            v-else
            variant="secondary"
            icon="sparkles"
            :disabled="check.loading || check.info?.available === false"
            @click="check.runAi()"
          >
            {{ check.ai.text ? '重新 AI 判讀' : 'AI 判讀排序建議' }}
          </GButton>
        </template>
      </div>

      <GAlert v-if="check.error" tone="danger" class="mt-2">{{ describeError(check.error) }}</GAlert>
      <GAlert v-if="check.imprecise > 0" tone="warning" class="mt-2">
        有 <strong>{{ fmtNum(check.imprecise) }}</strong> 條規則含無法精準比對的條件(例如動態群組、應用群組、使用者群組或反向條件),已標示為「無法判定」,請人工確認,不可視為沒問題。
      </GAlert>
    </GCard>

    <GCard v-if="check.canAi && aiStarted" class="ai-card">
      <header class="ai-head">
        <div class="ai-title">
          <GIcon name="sparkles" :size="18" />
          <h3>AI 排序判讀與建議</h3>
        </div>
        <GButton v-if="aiRunning" size="sm" variant="danger" icon="x" @click="check.ai.stop()">停止</GButton>
      </header>

      <GAlert tone="warning">{{ AI_DISCLAIMER }}</GAlert>

      <p v-if="aiRunning" class="small muted status-line" role="status" aria-live="polite">
        <span class="spin-dot" aria-hidden="true" />
        {{ check.ai.statusText || 'AI 分析中…' }}
      </p>

      <GAlert v-for="n in check.ai.notices" :key="n.text" :tone="n.tone">{{ n.text }}</GAlert>
      <GAlert v-if="check.ai.error" tone="danger">{{ check.ai.error }}</GAlert>

      <p v-if="check.ai.flags !== null && check.ai.flags.length === 0" class="ai-verify-ok xs" role="status">
        <GIcon name="check-circle" :size="14" />
        系統比對:引用的規則編號都在檢查資料內
      </p>

      <GAlert
        v-else-if="check.ai.flags && check.ai.flags.length > 0"
        tone="warning"
        :title="`系統比對發現 ${fmtNum(check.ai.flags.length)} 處 AI 引用與檢查結果不符,請以排序檢查清單為準`"
      >
        <p class="xs muted verify-note">系統以關鍵字比對提醒,請對照下方排序檢查清單與規則原文:</p>
        <ul class="flag-list">
          <li v-for="(flag, idx) in check.ai.flags" :key="`${flag.kind}-${flag.position}-${idx}`" class="flag-item xs">
            <span class="flag-head">
              <strong class="mono">#{{ flag.position }}</strong>
              <GBadge tone="warning" variant="outline" class="mini-flag">{{ AI_FLAG_LABELS[flag.kind] }}</GBadge>
              <GBadge v-if="flag.kind === 'mismatch' && flag.code" tone="info" variant="soft" class="mini-flag">
                {{ CHECK_LABELS[flag.code as CheckCode] ?? flag.code }}
              </GBadge>
            </span>
            <span class="flag-line">{{ flag.reason }}</span>
          </li>
        </ul>
      </GAlert>

      <div v-if="check.ai.text" class="ai-body">
        <AiMarkdown :text="check.ai.text" />
      </div>
    </GCard>

    <section v-if="summaryCards.length" class="summary-grid">
      <div
        v-for="s in summaryCards"
        :key="s.code"
        class="sum-card"
        :class="{ 'is-zero': s.count === 0, 'is-und': s.code === 'undeterminable' && s.count > 0 }"
      >
        <span class="xs muted">{{ s.label }}</span>
        <strong class="mono sum-num">{{ fmtNum(s.count) }}</strong>
      </div>
    </section>

    <GSkeleton v-if="check.loading && !check.items.length" :rows="6" />

    <GCard v-else-if="check.info && check.info.available === false">
      <GEmpty icon="shield" title="尚無規則快照可供檢查" :description="check.info.message" />
    </GCard>

    <GCard v-else-if="!check.loading && check.summary && !check.items.length">
      <GEmpty
        icon="check-circle"
        title="未發現排序或設定項目"
        :description="
          check.imprecise > 0
            ? `有 ${fmtNum(check.imprecise)} 條規則含無法精準比對的條件,仍需人工確認。`
            : `門檻 ${check.unusedDays} 天內所有確定性檢查項目皆無異常。`
        "
      />
    </GCard>

    <div v-else-if="groups.length" class="groups-col">
      <GCard v-for="g in groups" :key="g.key" class="group-card">
        <header class="group-head">
          <GBadge :tone="g.tone">{{ g.label }}</GBadge>
          <span class="xs muted">{{ fmtNum(g.items.length) }} 項</span>
          <span v-if="g.key === 'undeterminable' || (groupBy === 'severity' && hasUndeterminable && g.key === 'info')" class="xs c-warning">
            ※ 無法判定不代表沒問題,請網通人工確認
          </span>
        </header>

        <div class="item-list">
          <article
            v-for="(item, idx) in g.items"
            :key="`${item.code}-${item.position}-${idx}`"
            class="chk-item"
            :class="{ 'is-undeterminable': item.code === 'undeterminable' }"
          >
            <div class="chk-top">
              <GBadge :tone="SEVERITY_TONES[item.severity]" variant="soft">
                {{ SEVERITY_LABELS[item.severity] }}
              </GBadge>
              <GBadge :tone="codeTone(item.code)" variant="outline">
                {{ CHECK_LABELS[item.code] }}
              </GBadge>
              <button type="button" class="rule-link mono" @click="emit('open-rule', item.name)">
                #{{ item.position }} {{ item.name }}
              </button>
            </div>

            <p class="chk-msg">{{ item.message }}</p>

            <div v-if="item.related.length" class="chk-related xs">
              <span class="muted">相關規則：</span>
              <button
                v-for="rel in item.related"
                :key="`${rel.position}-${rel.name}`"
                type="button"
                class="rel-chip mono"
                @click="emit('open-rule', rel.name)"
              >
                #{{ rel.position }} {{ rel.name }}
              </button>
            </div>

            <div v-if="item.reasons?.length" class="chk-reasons xs">
              <span class="reason-lbl">無法精準判定原因：</span>
              <ul>
                <li v-for="reason in item.reasons" :key="reason">{{ reason }}</li>
              </ul>
            </div>
          </article>
        </div>
      </GCard>
    </div>
  </div>
</template>

<style scoped>
.check-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ctrl-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.days-input {
  width: 170px;
}
.spacer {
  flex: 1;
}
.mt-2 {
  margin-top: 12px;
}
.ai-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-color: color-mix(in srgb, var(--c-primary) 35%, var(--line));
}
.ai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--c-primary-text);
}
.ai-title h3 {
  margin: 0;
  font-size: var(--fs-md);
}
.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.spin-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--c-primary) 30%, transparent);
  border-top-color: var(--c-primary);
  animation: chk-spin 0.8s linear infinite;
}
@keyframes chk-spin {
  to {
    transform: rotate(360deg);
  }
}
.ai-body {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  max-height: 55vh;
  overflow-y: auto;
}
.ai-verify-ok {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--c-success);
  font-weight: 600;
}
.verify-note {
  margin: 0 0 6px;
}
.flag-list {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.flag-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.flag-head {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.mini-flag {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
}
.flag-line {
  color: var(--text-2);
  word-break: break-word;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.sum-card {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--glass);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sum-card.is-zero {
  opacity: 0.65;
}
.sum-card.is-und {
  border-color: color-mix(in srgb, var(--c-warning) 50%, var(--line));
}
.sum-num {
  font-size: var(--fs-xl);
  font-weight: 700;
}
.groups-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.c-warning {
  color: var(--c-warning);
  font-weight: 600;
}
.item-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chk-item {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chk-item.is-undeterminable {
  border-left: 3px solid var(--c-warning);
}
.chk-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.rule-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-primary-text);
  font-weight: 600;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.rule-link:hover {
  text-decoration: underline;
}
.chk-msg {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.chk-related {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.rel-chip {
  padding: 2px 8px;
  border-radius: 99px;
  border: 1px solid color-mix(in srgb, var(--c-primary) 35%, var(--line));
  background: color-mix(in srgb, var(--c-primary) 8%, transparent);
  color: var(--c-primary-text);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.rel-chip:hover {
  background: color-mix(in srgb, var(--c-primary) 16%, transparent);
}
.chk-reasons {
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--c-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-warning) 30%, transparent);
}
.reason-lbl {
  font-weight: 600;
  color: var(--c-warning);
}
.chk-reasons ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
