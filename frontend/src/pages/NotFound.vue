<template>
  <GCard class="state">
    <GEmpty icon="compass" title="找不到頁面" description="網址可能有誤,或此功能已移除。">
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
