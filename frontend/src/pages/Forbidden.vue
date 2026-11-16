<script setup lang="ts">
/** 403(PRD FR-2.6):直接輸入沒有 menu / tab 權限的網址時顯示,不導回首頁 */
</script>

<template>
  <GCard class="state">
    <GEmpty icon="lock" tone="warning" title="沒有此功能的權限" description="您的角色、部門或職級沒有這個頁面的權限。如需使用,請洽 IT 申請。">
      <GButton variant="primary" icon="home" @click="$router.push('/')">回首頁</GButton>
    </GEmpty>
  </GCard>
</template>

<style scoped>
.state {
  max-width: 640px;
  margin: 48px auto;
}
</style>
