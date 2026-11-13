<script setup lang="ts">
/**
 * AC5「AI 說明這個威脅與處理建議」對話框(Log 明細查詢、時段明細抽屜的威脅列共用;docs/API.md §10.3 kind: threat)
 *   - 只送威脅名稱與期間;後端自己彙總嚴重度、類別、方向、動作、App / Port、國家與影響主機(不送原始 log)
 *   - 開啟時自動開始;關閉時面板卸載、串流中斷;換了威脅或期間時面板清掉舊回答(AiExplainPanel)
 *   - 嚴重度只做標示(色彩之外也有文字)
 */
import { computed } from 'vue';
import type { ExplainInput } from '@/api/ai';
import { formatRange } from '@/composables/vizTime';
import AiExplainPanel from './AiExplainPanel.vue';

const props = withDefaults(defineProps<{ name: string; from: string; to: string; severity?: string }>(), { severity: '' });
const open = defineModel<boolean>('open', { default: false });

const input = computed<ExplainInput | null>(() =>
  props.name.trim() && props.from && props.to ? { kind: 'threat', params: { name: props.name.trim(), from: props.from, to: props.to } } : null,
);
const range = computed(() => (props.from && props.to ? formatRange(props.from, props.to) : ''));
const SEVERITY: Record<string, { label: string; tone: string }> = {
  critical: { label: '嚴重', tone: 'danger' },
  high: { label: '高', tone: 'danger' },
  medium: { label: '中', tone: 'warning' },
  low: { label: '低', tone: 'info' },
  info: { label: '資訊', tone: 'neutral' },
  informational: { label: '資訊', tone: 'neutral' },
};
const sev = computed(() => SEVERITY[props.severity.toLowerCase()] ?? null);
</script>

<template>
  <GModal v-model:open="open" title="AI 說明這個威脅" :subtitle="range ? `期間 ${range}` : ''" icon="sparkles" width="880px">
    <div class="threat-ai">
      <div class="threat-ai__target">
        <GBadge v-if="sev" :tone="sev.tone" variant="soft" dot>嚴重度 {{ sev.label }}</GBadge>
        <code class="threat-ai__name" :title="name">{{ name }}</code>
      </div>
      <p class="xs faint threat-ai__note">依這個威脅在整段期間內的紀錄彙總(同名的全部紀錄,不只點選的這一筆)</p>
      <AiExplainPanel
        v-if="open"
        :input="input"
        title="威脅說明與處理建議"
        start-label="開始說明"
        hint="只把這個威脅在期間內的彙總(嚴重度、方向、動作、影響主機等,不是原始 log)送到公司內部的 AI 服務,不會傳到外部"
        frame="plain"
        auto-start
      />
    </div>
  </GModal>
</template>

<style scoped>
.threat-ai {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.threat-ai__target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.threat-ai__name {
  min-width: 0;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--glass-soft);
  font-size: var(--fs-sm, 0.875rem);
  overflow-wrap: anywhere;
}
.threat-ai__note {
  margin: 0;
}
</style>
