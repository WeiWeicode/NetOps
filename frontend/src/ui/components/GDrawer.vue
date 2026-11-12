<script setup lang="ts">
/**
 * 右側抽屜(V-b1 樸素版;介面見 ui/charts/viz-types.ts GDrawerProps)。畫面與滑入動畫由 Gemini 在 V-b2 改寫,props / emits 不變。
 *   Esc 關閉;開啟時焦點移到抽屜,關閉後焦點回到開啟前的元素(HANDOFF-GEMINI-VIZ §4.3)。
 */
import { nextTick, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ modelValue: boolean; title: string; width?: string; side?: 'right' }>(), { width: '560px', side: 'right' });
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const panel = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      opener = document.activeElement as HTMLElement | null;
      await nextTick();
      panel.value?.focus();
    } else opener?.focus?.();
  },
);
const close = () => emit('update:modelValue', false);
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="g-drawer" @keydown.esc="close">
      <div class="g-drawer__mask" @click="close" />
      <section ref="panel" class="g-drawer__panel" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" :style="{ width }">
        <header class="g-drawer__head">
          <h2>{{ title }}</h2>
          <slot name="actions" />
          <button type="button" class="g-drawer__close" aria-label="關閉" @click="close">×</button>
        </header>
        <div class="g-drawer__body"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.g-drawer {
  position: fixed;
  inset: 0;
  z-index: 50;
}
.g-drawer__mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 0.25);
}
.g-drawer__panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--glass-strong);
  color: var(--text);
  outline: none;
}
@media (max-width: 960px) {
  .g-drawer__panel {
    width: 100% !important;
  }
}
.g-drawer__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.g-drawer__head h2 {
  flex: 1;
  margin: 0;
  font-size: 16px;
}
.g-drawer__close {
  border: 0;
  background: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-2);
}
.g-drawer__body {
  flex: 1;
  overflow: auto;
  padding: 16px;
}
</style>
