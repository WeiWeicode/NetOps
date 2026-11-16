<script setup lang="ts">
/** 對話框:v-model:open 控制;Esc 與點背景關閉(persistent 時不關);footer slot 放按鈕 */
import { onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ title?: string; subtitle?: string; icon?: string; width?: string; persistent?: boolean; tone?: string }>(), {
  width: '520px',
  tone: 'primary',
});
const open = defineModel<boolean>('open', { default: false });
/** 後開的對話框在上層(confirm、公告閱讀可能疊在其他對話框之上;Teleport 的 DOM 順序不代表開啟順序) */
const z = ref(100);

function close() {
  if (!props.persistent) open.value = false;
}
function onKey(e: KeyboardEvent) {
  // 疊在上面的對話框才處理 Esc
  if (e.key === 'Escape' && z.value === Math.max(...openZ)) close();
}
watch(
  open,
  (v) => {
    if (v) {
      z.value = ++topZ;
      openZ.add(z.value);
      document.addEventListener('keydown', onKey);
    } else {
      openZ.delete(z.value);
      document.removeEventListener('keydown', onKey);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  openZ.delete(z.value);
  document.removeEventListener('keydown', onKey);
});
</script>

<script lang="ts">
/** 所有 GModal 共用:下一個開啟的 z-index 與目前開著的 z-index */
let topZ = 100;
const openZ = new Set<number>();
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="g-modal-backdrop" :style="{ zIndex: z }" @mousedown.self="close">
        <div class="g-modal glass glass-edge" :class="`tone-${tone}`" role="dialog" aria-modal="true" :aria-label="title" :style="{ width }">
          <header v-if="title" class="head">
            <span v-if="icon" class="ic"><GIcon :name="icon" :size="18" /></span>
            <div>
              <h3>{{ title }}</h3>
              <p v-if="subtitle" class="sub">{{ subtitle }}</p>
            </div>
            <div class="spacer" />
            <GButton v-if="!persistent" variant="ghost" size="sm" square icon="x" aria-label="關閉" @click="open = false" />
          </header>
          <div class="body"><slot /></div>
          <footer v-if="$slots.footer" class="foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.g-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--overlay);
  backdrop-filter: blur(6px);
}
.g-modal {
  /* 以視窗寬度為上限:grid 置中時百分比上限不生效,窄螢幕會超出畫面 */
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--glass-strong);
  box-shadow: var(--shadow-lg);
  border-radius: var(--radius-xl);
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 22px 4px;
}
.ic {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) calc(var(--tone-bg-alpha) * 100%), transparent);
}
h3 {
  font-size: var(--fs-lg);
}
.sub {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.body {
  padding: 16px 22px;
  overflow: auto;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 22px 20px;
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 200ms var(--ease);
}
.modal-enter-active .g-modal,
.modal-leave-active .g-modal {
  transition: transform 260ms var(--ease);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .g-modal {
  transform: translateY(12px) scale(0.97);
}
</style>
