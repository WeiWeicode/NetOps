<script setup>
/**
 * 碩禾電子材料 Logo（public/images/gsmc-mark.gif，透明底 GSMC 標誌）
 * 標誌放在白色圓形底上：GSMC 字是黑色，暗色模式也看得清楚
 * full：標誌 + 公司中英文名稱（文字用配色的顏色，明亮 / 暗色都清楚）
 * mark：只有標誌
 * stacked：標誌在上、名稱置中在下（登入畫面）
 */
defineProps({
  variant: { type: String, default: 'full' },
  size: { type: Number, default: 48 },
  stacked: { type: Boolean, default: false },
})
const src = `${import.meta.env.BASE_URL}images/gsmc-mark.gif`
</script>

<template>
  <span v-if="variant === 'mark'" class="logo-mark" :style="{ width: `${size}px`, height: `${size}px` }">
    <img :src="src" alt="碩禾電子材料" />
  </span>
  <span v-else :class="['logo-full', { stacked }]">
    <span class="logo-mark" :style="{ width: `${size}px`, height: `${size}px` }">
      <img :src="src" alt="" />
    </span>
    <span class="logo-text">
      <span class="logo-zh">碩禾電子材料股份有限公司</span>
      <span class="logo-en">GIGA SOLAR MATERIALS CORP.</span>
    </span>
  </span>
</template>

<style scoped>
.logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 0 0 1px var(--color-glow), 0 1px 4px rgba(0, 0, 0, 0.12);
}
.logo-mark img {
  width: 76%;
  height: 76%;
  object-fit: contain;
}
.logo-full {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  text-align: left;
}
.logo-full.stacked {
  flex-direction: column;
  gap: 10px;
  text-align: center;
}
.stacked .logo-text {
  align-items: center;
}
.stacked .logo-zh {
  font-size: calc(1.2rem * var(--font-scale));
}
.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}
.logo-zh {
  font-weight: 700;
  font-size: calc(1.05rem * var(--font-scale));
  letter-spacing: 0.08em;
  color: var(--color-ink);
}
.logo-en {
  font-size: calc(0.72rem * var(--font-scale));
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--color-run);
}
</style>
