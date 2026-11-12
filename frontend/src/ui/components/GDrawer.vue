<script setup lang="ts">
/**
 * 右側滑入抽屜(V-b2;HANDOFF-GEMINI-VIZ §4.3、§5):
 *   - 寬度預設 560px,≤ 960px 視窗時全寬
 *   - 右側滑入 200ms(prefers-reduced-motion 時直接出現)
 *   - Esc 關閉、Tab / Shift+Tab 焦點鎖在抽屜內、關閉後焦點回到觸發的元素
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ modelValue: boolean; title: string; width?: string; side?: 'right' }>(), {
  width: '560px',
  side: 'right',
});
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const panel = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function close() {
  emit('update:modelValue', false);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
    return;
  }
  if (e.key !== 'Tab' || !panel.value) return;
  const nodes = Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!nodes.length) {
    e.preventDefault();
    panel.value.focus();
    return;
  }
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey) {
    if (active === first || active === panel.value || !panel.value.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !panel.value.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      opener = document.activeElement as HTMLElement | null;
      await nextTick();
      panel.value?.focus();
    } else {
      const target = opener;
      opener = null;
      await nextTick();
      target?.focus?.();
    }
  },
);

onBeforeUnmount(() => {
  opener = null;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="g-drawer">
      <div v-if="modelValue" class="g-drawer" @keydown="onKeydown">
        <div class="g-drawer__mask" aria-hidden="true" @click="close" />
        <section
          ref="panel"
          class="g-drawer__panel glass-edge"
          :class="`is-${side}`"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
          :style="{ width }"
        >
          <header class="g-drawer__head">
            <div class="g-drawer__titles">
              <h2 class="g-drawer__title">{{ title }}</h2>
            </div>
            <div v-if="$slots.actions" class="g-drawer__actions">
              <slot name="actions" />
            </div>
            <button type="button" class="g-drawer__close" aria-label="關閉抽屜" @click="close">
              <GIcon name="x" :size="18" />
            </button>
          </header>
          <div class="g-drawer__body">
            <slot />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.g-drawer {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.g-drawer__mask {
  position: absolute;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
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
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-left: 1px solid var(--glass-border);
  box-shadow: var(--shadow-lg);
  color: var(--text);
  outline: none;
}
@media (max-width: 960px) {
  .g-drawer__panel {
    width: 100% !important;
    border-left: 0;
  }
}
.g-drawer__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--glass-soft) 60%, transparent);
}
.g-drawer__titles {
  flex: 1;
  min-width: 0;
}
.g-drawer__title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 700;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.g-drawer__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.g-drawer__close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.g-drawer__close:hover {
  background: var(--glass-soft);
  color: var(--text);
}
.g-drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 右側滑入 200ms(HANDOFF-GEMINI-VIZ §5) */
.g-drawer-enter-active,
.g-drawer-leave-active {
  transition: opacity 200ms var(--ease);
}
.g-drawer-enter-active .g-drawer__panel,
.g-drawer-leave-active .g-drawer__panel {
  transition:
    transform 200ms var(--ease),
    opacity 200ms var(--ease);
}
.g-drawer-enter-from,
.g-drawer-leave-to {
  opacity: 0;
}
.g-drawer-enter-from .g-drawer__panel,
.g-drawer-leave-to .g-drawer__panel {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .g-drawer-enter-active,
  .g-drawer-leave-active,
  .g-drawer-enter-active .g-drawer__panel,
  .g-drawer-leave-active .g-drawer__panel {
    transition-duration: 0ms !important;
  }
}
</style>
