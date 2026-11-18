<script setup lang="ts">
/**
 * 網通設定 › 網段設定(SEGMENT-SETTINGS-PLAN §2;SG-3 由 Gemini 組裝畫面)。
 *   暫時頁:路由與權限先就位。狀態與邏輯一律用 composables/useSegmentSettings.ts(說明見該檔開頭),頁面不直接呼叫 API。
 */
import { useSegmentSettings } from '@/composables/useSegmentSettings';
import { GEmpty } from '@/ui';

const s = useSegmentSettings();
</script>

<template>
  <GEmpty v-if="s.error.value" tone="danger" icon="alert" title="無法載入網段設定" :description="s.error.value.message" />
  <GEmpty v-else icon="gateway" title="網段設定(畫面製作中)" :description="s.meta.value ? `目前 ${s.draft.segments.length} 個網段,版本 ${s.meta.value.version}` : '載入中…'" />
</template>
