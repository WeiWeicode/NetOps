<script setup lang="ts">
/** 品牌標誌(太陽 + 能量閃電,綠能意象) */
withDefaults(defineProps<{ size?: number }>(), { size: 40 });
</script>

<template>
  <span class="g-logo" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle class="sun" cx="16" cy="16" r="9" />
      <path class="rays" d="M16 3v2.5M16 26.5V29M3 16h2.5M26.5 16H29M6.8 6.8l1.8 1.8M23.4 23.4l1.8 1.8M6.8 25.2l1.8-1.8M23.4 8.6l1.8-1.8" />
      <path class="bolt" d="M17.2 10.5 12.8 17h3.4l-1.4 4.5 4.4-6.5h-3.4z" />
    </svg>
  </span>
</template>

<style scoped>
.g-logo {
  display: grid;
  place-items: center;
  flex: none;
  border-radius: 30%;
  background: var(--grad-brand);
  box-shadow: var(--shadow-glow);
}
svg {
  width: 74%;
  height: 74%;
}
.sun {
  fill: rgb(255 255 255 / 0.22);
  stroke: #fff;
  stroke-width: 1.8;
}
.rays {
  fill: none;
  stroke: rgb(255 255 255 / 0.8);
  stroke-width: 1.8;
  stroke-linecap: round;
}
.bolt {
  fill: #fff;
}
</style>
