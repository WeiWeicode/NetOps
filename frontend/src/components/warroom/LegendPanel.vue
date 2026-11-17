<script setup lang="ts">
/**
 * 戰情室左側說明面板(WR-5;WARROOM-GEMINI-HANDOFF §2):
 *   - 圖例與操作說明(對照樣稿 warroom-v5.html)
 *   - 可收摺,狀態記在 localStorage('wr-legend');收摺後通知父層放大 Canvas
 *   - 支援顯示 DB-IP 授權連結
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    geoAttribution?: { text: string; url: string } | null;
  }>(),
  {
    geoAttribution: null,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const STORAGE_KEY = 'wr-legend';

function toggle() {
  const next = !props.modelValue;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* 無法寫入 localStorage 時僅影響重整後記憶 */
  }
  emit('update:modelValue', next);
}
</script>

<script lang="ts">
export function readLegendOpen(): boolean {
  try {
    return localStorage.getItem('wr-legend') !== '0';
  } catch {
    return true;
  }
}
</script>

<template>
  <aside class="wr-legend" :class="{ mini: !modelValue }" aria-label="戰情室圖例與操作說明">
    <button
      id="lgBtn"
      type="button"
      class="wr-legend__btn"
      :title="modelValue ? '收摺說明' : '展開說明'"
      :aria-expanded="modelValue"
      aria-label="收摺或展開說明"
      @click="toggle"
    >
      «
    </button>

    <div class="wr-legend__body">
      <h3>圖例</h3>
      <div class="lg"><span class="dot is-ok" />允許流量</div>
      <div class="lg"><span class="dot is-bad" />阻擋 (deny/drop)</div>
      <div class="lg"><span class="dot is-warn" />威脅事件</div>
      <div class="lg wr-legend__desc">
        粒子密度 = 每秒連線量<br />
        節點大小 = 5 分鐘流量<br />
        連線顏色 = 阻擋比例<br />
        核心環 = 防火牆負載
      </div>

      <h3 class="wr-legend__sub">操作</h3>
      <div class="wr-legend__desc">
        滑過節點看明細<br />
        點節點聚焦(其他淡出)<br />
        點空白取消聚焦
      </div>

      <div v-if="geoAttribution" class="wr-legend__geo">
        <a :href="geoAttribution.url" target="_blank" rel="noopener noreferrer">
          {{ geoAttribution.text }}
        </a>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.wr-legend {
  position: absolute;
  top: 64px;
  left: 12px;
  width: 250px;
  background: rgba(12, 20, 36, 0.93);
  border: 1px solid #1c2a44;
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
  color: #cfe3ff;
  /* 不用 backdrop-filter:疊在動畫 Canvas 上每幀都要重算模糊(流暢度改善 2026-11-17) */
  transition: width 0.3s ease;
  z-index: 6;
}
.wr-legend h3 {
  margin: 0 0 8px;
  font-size: 12px;
  color: #6f86a8;
  letter-spacing: 1px;
}
.wr-legend__sub {
  margin-top: 14px !important;
}
.lg {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}
.dot.is-ok {
  background: #22d3a6;
}
.dot.is-bad {
  background: #ff4d5e;
}
.dot.is-warn {
  background: #f5b03a;
}
.wr-legend__desc {
  color: #6f86a8;
  line-height: 1.5;
}
.wr-legend__geo {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px dashed #1c2a44;
  font-size: 11px;
}
.wr-legend__geo a {
  color: #6f86a8;
  text-decoration: none;
}
.wr-legend__geo a:hover {
  color: #8fc3ff;
  text-decoration: underline;
}
.wr-legend__btn {
  position: absolute;
  top: 6px;
  right: 6px;
  background: #14223a;
  color: #cfe3ff;
  border: 1px solid #1c2a44;
  border-radius: 4px;
  width: 22px;
  height: 22px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.wr-legend__btn:hover {
  border-color: #3ea8ff;
}
.wr-legend.mini {
  width: 34px;
  height: 120px;
  padding: 0;
  overflow: hidden;
}
.wr-legend.mini .wr-legend__body {
  display: none;
}
.wr-legend.mini .wr-legend__btn {
  right: 5px;
  transform: rotate(180deg);
}
.wr-legend.mini::after {
  content: '說明';
  position: absolute;
  top: 40px;
  left: 9px;
  writing-mode: vertical-rl;
  color: #6f86a8;
  font-size: 12px;
  letter-spacing: 4px;
}
</style>
