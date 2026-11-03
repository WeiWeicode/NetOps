<script setup lang="ts">
/** 玻璃卡片:title / subtitle / icon,右上 actions slot;glow 顯示 tone 色光暈 */
withDefaults(
  defineProps<{
    title?: string;
    subtitle?: string;
    icon?: string;
    tone?: string;
    glow?: boolean;
    padding?: 'none' | 'sm' | 'md' | 'lg';
    interactive?: boolean;
  }>(),
  { tone: 'primary', padding: 'md' },
);
</script>

<template>
  <section class="g-card glass glass-edge" :class="[`tone-${tone}`, `p-${padding}`, { glow, interactive }]">
    <header v-if="title || $slots.header || $slots.actions" class="head">
      <slot name="header">
        <span v-if="icon" class="ic"><GIcon :name="icon" :size="17" /></span>
        <div class="titles">
          <h3 class="title">{{ title }}</h3>
          <p v-if="subtitle" class="sub">{{ subtitle }}</p>
        </div>
      </slot>
      <div class="spacer" />
      <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
    </header>
    <div class="body"><slot /></div>
    <footer v-if="$slots.footer" class="foot"><slot name="footer" /></footer>
  </section>
</template>

<style scoped>
.g-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  transition:
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.g-card.glow::after {
  content: '';
  position: absolute;
  width: 220px;
  height: 220px;
  right: -70px;
  top: -90px;
  background: radial-gradient(circle, color-mix(in srgb, var(--tone) 45%, transparent), transparent 70%);
  filter: blur(10px);
  opacity: var(--card-glow-opacity);
  pointer-events: none;
}
.interactive {
  cursor: pointer;
}
.interactive:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
  background: var(--glass-hover);
}
.head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 0;
}
.p-sm .head {
  padding: 14px 16px 0;
}
.ic {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) calc(var(--tone-bg-alpha) * 100%), transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 25%, transparent);
}
.titles {
  min-width: 0;
}
.title {
  font-size: var(--fs-lg);
  font-weight: 650;
}
.sub {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.body {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
}
.p-sm .body {
  padding: 14px 16px 16px;
}
.p-md .body {
  padding: 16px 20px 20px;
}
.p-lg .body {
  padding: 24px 28px 28px;
}
.p-none .body {
  padding: 0;
}
.p-none .head {
  padding-bottom: 14px;
}
.foot {
  position: relative;
  z-index: 1;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
}
</style>
