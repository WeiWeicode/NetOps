<script setup lang="ts">
/**
 * 防火牆 › 威脅特徵碼 — 分頁 5:AI 摘要(TS-3 / TS-4;計畫 §5.3)
 *   - 權限:netops.pa-signature-page.ai(includes: netops.ai.use + netops.pa-signature.read)
 *   - 只送統計(內容版本、最多 50 筆新增高危特徵、近 30 天熱門 App、命中統計與規則覆蓋缺口條數),不含 IP、姓名與原始 log
 *   - 「AI 建議,需網通確認」固定只放開頭(同 PR-5 決定),不在結尾重複
 */
import { computed, ref } from 'vue';
import { fmtNum } from '@/api/format';
import type { SignatureDays } from '@/api/paSignature';
import AiMarkdown from '@/components/AiMarkdown.vue';
import { PA_SIGNATURE_AI_DISCLAIMER } from '@/composables/usePaSignature';
import { SIG_DAYS_OPTIONS, type PaSignatureStore } from './types';

const props = defineProps<{
  sig: PaSignatureStore;
}>();

const think = ref(false);

const daysModel = computed({
  get: () => String(props.sig.filters.days ?? 30),
  set: (v: string) => {
    props.sig.setDays(Number(v) as SignatureDays);
  },
});

const aiMeta = computed(() => (props.sig.ai.meta?.kind === 'pa-signature' ? props.sig.ai.meta : null));
const aiStarted = computed(
  () => props.sig.ai.phase !== 'idle' || !!props.sig.ai.text || !!props.sig.ai.error || props.sig.ai.notices.length > 0,
);

function onRun() {
  const days = (props.sig.filters.days ?? 30) as SignatureDays;
  void props.sig.runAi(days, { think: think.value });
}
</script>

<template>
  <div class="ai-tab">
    <GCard v-if="!sig.canAi">
      <GEmpty
        icon="lock"
        title="沒有使用 AI 摘要的權限"
        description="使用威脅特徵碼 AI 摘要需具備 netops.pa-signature-page.ai 權限。"
      />
    </GCard>

    <template v-else>
      <GCard class="ctrl-card">
        <div class="ctrl-row">
          <div class="field-col">
            <span class="xs muted field-lbl">分析期間（新特徵範圍）</span>
            <GSegmented v-model="daysModel" size="sm" :options="SIG_DAYS_OPTIONS" aria-label="AI 摘要天數" />
          </div>

          <GCheckbox v-model="think" label="深入思考（較耗時）" />

          <div class="spacer" />

          <GButton v-if="sig.ai.running" variant="danger" icon="x" @click="sig.ai.stop()">
            停止 AI 摘要
          </GButton>
          <GButton
            v-else
            variant="primary"
            icon="sparkles"
            :disabled="sig.info?.available === false"
            @click="onRun"
          >
            {{ sig.ai.text ? '重新產生 AI 摘要' : '產生 AI 摘要' }}
          </GButton>
        </div>

        <p class="xs muted privacy-note">
          只將內容版本、最多 50 筆新增高危特徵（含總數）、近 30 天本環境熱門 App、命中筆數與動作分布、規則覆蓋缺口條數送至公司內部 AI 服務，不含任何 IP、姓名或原始 log。
        </p>
      </GCard>

      <GCard v-if="aiStarted" class="ai-card">
        <header class="ai-head">
          <div class="ai-title">
            <GIcon name="sparkles" :size="18" />
            <h3>威脅特徵碼 AI 摘要</h3>
          </div>
          <div v-if="aiMeta" class="meta-chips xs muted">
            <GBadge tone="primary" variant="soft" mono>v{{ aiMeta.threatVersion }}</GBadge>
            <span>近 {{ aiMeta.days }} 天</span>
            <span>新增高危 {{ fmtNum(aiMeta.totalHighRiskNew ?? 0) }} 筆（送出 {{ fmtNum(aiMeta.sentSignatures ?? 0) }} 筆）</span>
            <span v-if="aiMeta.model" class="mono">{{ aiMeta.model }}</span>
          </div>
        </header>

        <!-- 「AI 建議,需網通確認」固定只放開頭(同 PR-5 決定) -->
        <GAlert tone="warning">{{ PA_SIGNATURE_AI_DISCLAIMER }}</GAlert>

        <p v-if="sig.ai.running" class="small muted status-line" role="status" aria-live="polite">
          <span class="spin-dot" aria-hidden="true" />
          {{ sig.ai.statusText || '整理統計並等待 AI 回應…' }}
          <span v-if="sig.ai.elapsed > 0" class="mono xs">({{ sig.ai.elapsed }}s)</span>
        </p>

        <GAlert v-for="n in sig.ai.notices" :key="n.text" :tone="n.tone">{{ n.text }}</GAlert>
        <GAlert v-if="sig.ai.error" tone="danger">{{ sig.ai.error }}</GAlert>
        <GAlert v-if="sig.ai.truncated" tone="warning">
          AI 回答因長度上限或連線中斷而被截斷，內容可能不完整。
        </GAlert>

        <div v-if="sig.ai.text" class="ai-body">
          <AiMarkdown :text="sig.ai.text" />
        </div>
      </GCard>

      <GCard v-else>
        <GEmpty
          icon="sparkles"
          title="尚未產生 AI 摘要"
          description="選擇新特徵統計期間（7 / 30 / 90 天）後，點擊「產生 AI 摘要」評估哪些新增高危特徵與本環境相關及建議檢查的規則缺口。"
        />
      </GCard>
    </template>
  </div>
</template>

<style scoped>
.ai-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ctrl-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 16px;
}
.field-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-lbl {
  font-weight: 500;
}
.spacer {
  flex: 1;
}
.privacy-note {
  margin: 10px 0 0;
  line-height: 1.5;
}
.ai-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-color: color-mix(in srgb, var(--c-primary) 35%, var(--line));
}
.ai-head {
  display: flex;
  flex-wrap: wrap;
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
.meta-chips {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
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
  animation: ai-spin 0.8s linear infinite;
}
@keyframes ai-spin {
  to {
    transform: rotate(360deg);
  }
}
.ai-body {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--glass-soft);
  border: 1px solid var(--line);
  max-height: 60vh;
  overflow-y: auto;
}
</style>
