<script setup lang="ts">
/**
 * 防火牆 › 安全規則(PR-4 由 Gemini 實作;交接見 docs/GEMINI-PROMPT-PR.md)。
 * 目前只放佔位畫面,讓路由與選單可以先接上;資料與邏輯在 composables/usePaPolicy.ts、usePaPolicyViz.ts、usePaPolicyCheck.ts。
 */
</script>

<template>
  <GCard class="state">
    <GEmpty icon="shield" title="安全規則頁製作中" description="清單、變更紀錄、排序檢查、規則圖四個分頁即將推出。" />
  </GCard>
</template>

<style scoped>
.state {
  max-width: 640px;
  margin: 48px auto;
}
</style>
