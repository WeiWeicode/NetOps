<script setup lang="ts">
/** 頁首:標題、說明、右側動作按鈕 */
defineProps<{ title: string; description?: string; icon?: string; eyebrow?: string }>();
</script>

<template>
  <header class="g-page-header">
    <div v-if="icon" class="ic"><GIcon :name="icon" :size="22" /></div>
    <div class="text">
      <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
      <h1>{{ title }}</h1>
      <p v-if="description" class="desc">{{ description }}</p>
    </div>
    <div class="spacer" />
    <div v-if="$slots.default" class="actions"><slot /></div>
  </header>
</template>

<style scoped>
.g-page-header {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.ic {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 14px;
  color: var(--on-primary);
  background: var(--grad-primary);
  box-shadow: var(--shadow-glow);
}
.eyebrow {
  margin: 0 0 2px;
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
}
h1 {
  font-size: var(--fs-2xl);
  font-weight: 750;
}
.desc {
  margin: 4px 0 0;
  color: var(--text-2);
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
