<script setup lang="ts">
/**
 * 戰情室提示橫幅與 DB-IP 授權字樣(WR-5;WARROOM-GEMINI-HANDOFF §2、§3):
 *   - 完整顯示 w.notices[] 的所有提示(範例網段、網段設定錯誤、推估值、partial、GeoIP 不可用)
 *   - 顯示連線/輪詢錯誤(warroomError、riskError、streamError)與過期狀態(stale)
 *   - 當 geoAttribution 不為 null 時顯示「IP Geolocation by DB-IP」並連到 https://db-ip.com
 */
import { describeError } from '@/api/gateway';
import type { WarroomNotice } from '@/composables/useWarroom';

defineProps<{
  notices: readonly WarroomNotice[];
  geoAttribution: { text: string; url: string } | null;
  stale?: boolean;
  warroomError?: Error | null;
  riskError?: Error | null;
  streamError?: string;
}>();
</script>

<template>
  <div v-if="notices.length || stale || warroomError || riskError || streamError || geoAttribution" class="wr-notices" role="region" aria-label="戰情室狀態提示">
    <div class="wr-notices__list">
      <span v-if="stale" class="wr-notice is-warning" role="status">
        <span class="wr-notice__dot" />
        <span>戰情室資料已超過 15 秒未更新（等待重新同步）</span>
      </span>

      <span v-if="warroomError" class="wr-notice is-danger" role="alert">
        <span class="wr-notice__dot" />
        <span>戰情室聚合讀取失敗：{{ describeError(warroomError) }}</span>
      </span>

      <span v-if="riskError" class="wr-notice is-danger" role="alert">
        <span class="wr-notice__dot" />
        <span>高風險統計讀取失敗：{{ describeError(riskError) }}</span>
      </span>

      <span v-if="streamError" class="wr-notice is-warning" role="status">
        <span class="wr-notice__dot" />
        <span>{{ streamError }}</span>
      </span>

      <span
        v-for="n in notices"
        :key="n.key"
        class="wr-notice"
        :class="`is-${n.tone}`"
        :data-notice-key="n.key"
        :role="n.tone === 'danger' ? 'alert' : 'status'"
      >
        <span class="wr-notice__dot" />
        <span>{{ n.text }}</span>
      </span>
    </div>

    <a
      v-if="geoAttribution"
      :href="geoAttribution.url"
      target="_blank"
      rel="noopener noreferrer"
      class="wr-geo-attr"
    >
      {{ geoAttribution.text }}
    </a>
  </div>
</template>

<style scoped>
.wr-notices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 5px 14px;
  background: rgba(8, 15, 28, 0.92);
  border-bottom: 1px solid #1c2a44;
  font-size: 11px;
  color: #cfe3ff;
  z-index: 12;
}
.wr-notices__list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.wr-notice {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #23406b;
  background: rgba(16, 30, 54, 0.75);
  color: #cfe3ff;
  line-height: 1.4;
}
.wr-notice__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3ea8ff;
  flex: none;
}
.wr-notice.is-info {
  border-color: rgba(62, 168, 255, 0.45);
  background: rgba(62, 168, 255, 0.12);
  color: #bfe0ff;
}
.wr-notice.is-info .wr-notice__dot {
  background: #3ea8ff;
}
.wr-notice.is-warning {
  border-color: rgba(245, 176, 58, 0.55);
  background: rgba(245, 176, 58, 0.14);
  color: #ffe0a6;
}
.wr-notice.is-warning .wr-notice__dot {
  background: #f5b03a;
}
.wr-notice.is-danger {
  border-color: rgba(255, 77, 94, 0.6);
  background: rgba(255, 77, 94, 0.16);
  color: #ffc2c8;
}
.wr-notice.is-danger .wr-notice__dot {
  background: #ff4d5e;
}
.wr-geo-attr {
  margin-left: auto;
  color: #6f86a8;
  text-decoration: none;
  white-space: nowrap;
  font-size: 11px;
  transition: color 0.2s;
}
.wr-geo-attr:hover {
  color: #8fc3ff;
  text-decoration: underline;
}
</style>
