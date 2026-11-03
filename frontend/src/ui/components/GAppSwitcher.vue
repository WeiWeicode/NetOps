<script setup lang="ts">
/**
 * 應用切換(PRD FR-2.2、FRONTEND-GUIDE §7.4、UI-GUIDE §3):頂列帳號旁的圖示按鈕 + 下拉,列出 me.apps 並標示目前所在應用;
 * 點選以整頁導向該應用 basePath(Cookie 同網域共用,不需再登入)。apps 只有一個以下時不顯示。
 * 外觀與行為需與 GigaItApp 的同名元件一致(兩邊同步修改)。
 */
import { ref } from 'vue';

export interface SwitcherApp {
  code: string;
  name: string;
  basePath: string;
  icon: string;
}

defineProps<{
  apps: SwitcherApp[];
  current: string;
  /** true = 清單由權限暫時推導(Gateway /api/auth/me 尚未提供 apps),在下拉底部標示 */
  derived?: boolean;
}>();

const open = ref(false);

function go(app: SwitcherApp, current: string) {
  open.value = false;
  if (app.code !== current) location.assign(app.basePath);
}
</script>

<template>
  <div v-if="apps.length > 1" class="g-app-switcher" @keydown.esc="open = false">
    <GButton variant="ghost" square icon="apps" aria-label="切換應用" title="切換應用" :aria-expanded="open" aria-haspopup="menu" @click="open = !open" />
    <Transition name="pop">
      <div v-if="open" class="panel glass glass-edge" role="menu" aria-label="切換應用">
        <p class="head">切換應用</p>
        <button
          v-for="a in apps"
          :key="a.code"
          type="button"
          class="app"
          :class="{ current: a.code === current }"
          role="menuitem"
          :aria-current="a.code === current ? 'true' : undefined"
          @click="go(a, current)"
        >
          <span class="ic"><GIcon :name="a.icon" :size="18" /></span>
          <span class="name">{{ a.name }}</span>
          <GBadge v-if="a.code === current" tone="primary">目前所在</GBadge>
          <GIcon v-else name="arrow-right" :size="15" class="go" />
        </button>
        <p v-if="derived" class="note">暫時做法:應用清單依權限推導,待 Gateway 提供 apps</p>
      </div>
    </Transition>
    <div v-if="open" class="scrim" @click="open = false" />
  </div>
</template>

<style scoped>
.g-app-switcher {
  position: relative;
}
.panel {
  position: absolute;
  right: 0;
  top: calc(100% + 10px);
  z-index: 30;
  width: 260px;
  padding: 8px;
  background: var(--glass-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
}
.scrim {
  position: fixed;
  inset: 0;
  z-index: 25;
}
.head {
  margin: 4px 10px 6px;
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.app {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 46px;
  padding: 6px 10px;
  border: 0;
  border-radius: 10px;
  background: none;
  font: inherit;
  font-weight: 600;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.app:hover,
.app:focus-visible {
  background: var(--glass-soft);
}
.app.current {
  background: var(--glass-hover);
  box-shadow: inset 0 0 0 1px var(--glass-border-2);
  cursor: default;
}
.ic {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  color: var(--on-primary);
  background: var(--grad-primary);
}
.name {
  flex: 1;
}
.go {
  color: var(--text-3);
}
.note {
  margin: 6px 10px 2px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.pop-enter-active,
.pop-leave-active {
  transition: all 180ms var(--ease);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
</style>
