<script setup lang="ts">
/** 顯示 toast 與 confirm(放在 App.vue 一次即可) */
import { computed } from 'vue';
import { dismiss, feedback } from '../feedback';

const ICON = { success: 'check-circle', danger: 'x-circle', info: 'info', warning: 'alert' } as const;

const confirmOpen = computed({
  get: () => !!feedback.confirm,
  set: (v) => {
    if (!v) answer(false);
  },
});
function answer(ok: boolean) {
  feedback.confirm?.resolve(ok);
  feedback.confirm = null;
}
</script>

<template>
  <Teleport to="body">
    <div class="toasts" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="t in feedback.toasts" :key="t.id" class="toast glass glass-edge" :class="`tone-${t.tone}`" role="status">
          <span class="ic"><GIcon :name="ICON[t.tone]" :size="18" /></span>
          <div class="txt">
            <strong>{{ t.title }}</strong>
            <p v-if="t.message">{{ t.message }}</p>
          </div>
          <button type="button" class="x" aria-label="關閉" @click="dismiss(t.id)"><GIcon name="x" :size="15" /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
  <GModal
    v-model:open="confirmOpen"
    :title="feedback.confirm?.title"
    :icon="feedback.confirm?.tone === 'danger' ? 'alert' : 'info'"
    :tone="feedback.confirm?.tone ?? 'primary'"
    width="420px"
  >
    <p class="msg">{{ feedback.confirm?.message }}</p>
    <template #footer>
      <GButton variant="ghost" @click="answer(false)">取消</GButton>
      <GButton :variant="feedback.confirm?.tone === 'danger' ? 'danger' : 'primary'" @click="answer(true)">{{
        feedback.confirm?.confirmText ?? '確定'
      }}</GButton>
    </template>
  </GModal>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: 16px;
  right: 16px;
  left: 16px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: min(380px, 100%);
  padding: 12px 12px 12px 14px;
  border-radius: var(--radius-md);
  background: var(--glass-strong);
  box-shadow: var(--shadow-lg);
}
.ic {
  color: var(--tone);
  margin-top: 1px;
}
.txt {
  flex: 1;
  min-width: 0;
}
.txt strong {
  font-size: var(--fs-md);
}
.txt p {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  word-break: break-word;
}
.x {
  border: 0;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px;
}
.msg {
  margin: 0;
  color: var(--text-2);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 260ms var(--ease);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.toast-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
