<script setup lang="ts">
/**
 * 戰情室上方 AI 分析框(WR-5;WARROOM-GEMINI-HANDOFF §2、§3):
 *   - 旋轉光球(.aiorb.run)、逐字顯示、自動/手動與時間、模型名稱
 *   - 立即分析按鈕:v-if="allowed"、:disabled="!canRun"、cooldownSec 倒數
 *   - failed 顯示「本小時分析失敗」,runError / loadError 顯示錯誤提示
 *   - 回答內容經 AiMarkdown(DOMPurify,AGENT.md §7.4)
 */
import { computed, nextTick, ref, watch } from 'vue';
import { describeError } from '@/api/gateway';
import { fmtClock } from '@/api/format';
import type { HourlyInsight } from '@/api/warroom';
import AiMarkdown from '@/components/AiMarkdown.vue';

const props = withDefaults(defineProps<{
  text: string;
  insight: HourlyInsight | null;
  running: boolean;
  failed: boolean;
  /** 失敗原因(useWarroomAi().failReason) */
  failReason?: string;
  /** 後端是否啟用(useWarroomAi().enabled) */
  enabled?: boolean;
  runError: string;
  loadError?: Error | null;
  allowed: boolean;
  canRun: boolean;
  cooldownSec: number;
  centerX?: number | null;
}>(), { enabled: true, failReason: '', loadError: null, centerX: null });

const emit = defineEmits<{
  (e: 'run'): void;
}>();

const bodyEl = ref<HTMLElement | null>(null);

const metaText = computed(() => {
  const ins = props.insight;
  if (!ins || ins.status === 'none' || (!ins.hour && !ins.at)) {
    return '每整點自動分析';
  }
  const trig = ins.trigger === 'manual' ? '手動分析' : '自動分析';
  const timeStr = fmtClock(ins.at ?? ins.hour);
  const parts = ['每整點自動分析', timeStr ? `${trig} ${timeStr}` : trig];
  if (ins.model) parts.push(ins.model);
  if (ins.partial) parts.push('部分資料');
  return parts.join(' · ');
});

const btnLabel = computed(() => {
  if (props.running) return '分析中…';
  if (props.enabled === false) return '未啟用';
  if (props.cooldownSec > 0) return `冷卻 ${props.cooldownSec}s`;
  return '立即分析';
});

const styleObj = computed(() => (props.centerX ? { left: `${props.centerX}px` } : undefined));

watch(
  () => props.text,
  async () => {
    if (!props.running) return;
    await nextTick();
    if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
  },
);
</script>

<template>
  <section id="ai" class="wr-ov wr-ai" :style="styleObj" aria-label="AI 每小時分析">
    <h3 class="wr-ai__hd">
      <span class="aiorb" :class="{ run: running }" aria-hidden="true" />
      <span>AI 分析</span>
      <span class="meta">{{ metaText }}</span>
      <button
        v-if="allowed"
        id="aiBtn"
        type="button"
        class="wr-ai__btn"
        :disabled="!canRun"
        @click="emit('run')"
      >
        {{ btnLabel }}
      </button>
    </h3>

    <div ref="bodyEl" id="aiText" class="wr-ai__text">
      <div v-if="runError" class="wr-ai__err" role="alert">{{ runError }}</div>
      <div v-else-if="loadError && !text" class="wr-ai__err" role="alert">
        無法載入 AI 分析：{{ describeError(loadError) }}
      </div>

      <div v-if="failed && !running" class="wr-ai__failed" role="status">
        本小時分析失敗<span v-if="insight?.partial">（資料不完整）</span><span v-if="failReason">：{{ failReason }}</span>
      </div>
      <div v-else-if="running && !text" class="wr-ai__dim">
        彙整近一小時統計中…<span class="cur" />
      </div>
      <div v-else-if="text" class="wr-ai__md-wrap">
        <AiMarkdown :text="text" class="wr-ai__md" />
        <span v-if="running" class="cur" aria-hidden="true" />
      </div>
      <div v-else class="wr-ai__dim">尚無本小時分析紀錄，待整點排程或點擊立即分析。</div>
    </div>
  </section>
</template>

<style scoped>
.wr-ov {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: min(560px, calc(100% - 540px));
  min-width: 300px;
  background: rgba(10, 18, 34, 0.93);
  border: 1px solid #23406b;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12px;
  color: #cfe3ff;
  /* 不用 backdrop-filter:疊在動畫 Canvas 上每幀都要重算模糊 */
  box-shadow: 0 0 24px rgba(62, 168, 255, 0.15);
  z-index: 6;
}
.wr-ai {
  top: 62px;
}
.wr-ai__hd {
  margin: 0;
  font-size: 12px;
  letter-spacing: 1px;
  color: #8fc3ff;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.meta {
  color: #6f86a8;
  font-weight: normal;
  margin-left: auto;
  font-size: 11px;
}
.wr-ai__btn {
  background: linear-gradient(90deg, #1f6fd1, #7b4dff);
  color: #fff;
  border: 0;
  border-radius: 12px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.wr-ai__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.wr-ai__text {
  margin-top: 6px;
  line-height: 1.55;
  height: 74px;
  overflow: auto;
  color: #d8e8ff;
}
.wr-ai__dim {
  color: #6f86a8;
}
.wr-ai__failed {
  color: #ff4d5e;
  font-weight: 600;
}
.wr-ai__err {
  color: #ff4d5e;
  margin-bottom: 4px;
}
.wr-ai__md-wrap {
  display: inline;
}
.wr-ai__md {
  display: inline;
  font-size: 12px;
  line-height: 1.55;
}
.wr-ai__md :deep(p) {
  margin: 0 0 4px;
  display: inline;
}
.cur {
  display: inline-block;
  width: 7px;
  height: 12px;
  margin-left: 3px;
  background: #8fc3ff;
  animation: wr-blink 0.8s infinite;
  vertical-align: middle;
}
.aiorb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #fff, #7b4dff 50%, #1f6fd1);
  box-shadow: 0 0 10px #7b4dff;
  flex: none;
}
.aiorb.run {
  animation: wr-spin 1s linear infinite;
}
@keyframes wr-blink {
  50% {
    opacity: 0.2;
  }
}
@keyframes wr-spin {
  to {
    transform: rotate(360deg);
    filter: hue-rotate(90deg);
  }
}
@media (max-width: 1100px) {
  .wr-ov {
    width: min(520px, calc(100% - 280px));
  }
}
/* 窄版面:置中會蓋住核心,改排到右欄(事件欄在此寬度隱藏,同樣資訊在 Log 表) */
@container wrmain (max-width: 1400px) {
  .wr-ov {
    left: auto !important;
    right: 12px;
    transform: none;
    width: 270px;
    min-width: 0;
  }
  .wr-ai {
    max-height: calc(50% - 150px);
    overflow: auto;
  }
}
</style>
