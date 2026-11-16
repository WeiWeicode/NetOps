<script setup lang="ts">
/** 空狀態 / 錯誤狀態:tone=danger 用於載入失敗(附重試按鈕由 slot 提供) */
withDefaults(defineProps<{ icon?: string; title?: string; description?: string; tone?: string; compact?: boolean }>(), {
  icon: 'boxes',
  title: '沒有資料',
  tone: 'neutral',
});
</script>

<template>
  <div class="g-empty" :class="[`tone-${tone}`, { compact }]">
    <span class="ic"><GIcon :name="icon" :size="compact ? 20 : 26" /></span>
    <p class="t">{{ title }}</p>
    <p v-if="description" class="d">{{ description }}</p>
    <div v-if="$slots.default" class="act"><slot /></div>
  </div>
</template>

<style scoped>
.g-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 16px;
  gap: 6px;
}
.compact {
  padding: 20px 12px;
}
.ic {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: 6px;
  border-radius: 18px;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) calc(var(--tone-bg-alpha) * 100%), transparent);
  border: 1px dashed color-mix(in srgb, var(--tone) 35%, transparent);
}
.compact .ic {
  width: 40px;
  height: 40px;
  border-radius: 12px;
}
.t {
  margin: 0;
  font-weight: 650;
}
.d {
  margin: 0;
  max-width: 420px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.act {
  margin-top: 10px;
}
</style>
