<script setup lang="ts">
/**
 * 主框架(由入口網 layouts/AppLayout.vue 複製,UI-GUIDE §1):左側兩層選單(群組 → 功能,依權限過濾)、頂列(麵包屑、風格 / 明暗、應用切換、帳號)、內容區。
 * 頁面內的第三層切換使用 Tab(TabbedPage.vue)。≤ 960px 選單改為抽屜。
 * 側欄收合時只顯示群組圖示,滑鼠移上(或鍵盤聚焦、點擊)在右側浮出該群組的功能清單。
 * NetOps 差異:不接通知、不提供個人資料與變更密碼(在入口網);選單可有一般連結(href,另開分頁,D11、D18)。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { menuTitle, useAuth, type NetopsMe } from '@/api/gateway';
import { CURRENT_APP, resolveApps } from '@/composables/apps';
import { findActive } from '@/composables/menu';
import { netopsMenus } from '@/router';

const auth = useAuth();
const me = computed(() => auth.me.me as NetopsMe | null);
const route = useRoute();

const menus = computed(netopsMenus);
const apps = computed(() => resolveApps(me.value));
/** 只有一個功能且名稱與大項相同時直接是連結,不摺疊 */
const isDirect = (g: { title: string; children: { title: string; href?: string }[] }) => g.children.length === 1 && !g.children[0]!.href && g.children[0]!.title === g.title;

const COLLAPSE_KEY = 'netops.sidebar.collapsed';
const collapsed = ref(readCollapsed());
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}
watch(collapsed, (v) => {
  flyout.value = null;
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
  } catch {
    /* 無法保存時只影響下次開啟 */
  }
});
const drawer = ref(false);
const activeItem = computed(() => findActive(menus.value, route.path));
const openGroups = ref<Set<string>>(new Set(activeItem.value ? [activeItem.value.group.key] : []));
const userMenu = ref(false);

const crumbs = computed(() => {
  const out: string[] = [];
  if (activeItem.value) {
    if (!isDirect(activeItem.value.group)) out.push(activeItem.value.group.title);
    out.push(activeItem.value.item.title);
    // 不在選單的子頁(權限與選單項目不同)附上自己的標題
    const own = route.matched[1]?.meta;
    if (own?.title && own.permission !== activeItem.value.item.permission) out.push(menuTitle(own.permission, own.title));
  } else if (route.meta.title) out.push(route.meta.title);
  // Tab 名稱以 BFF 為準(與頁籤一致)
  if (route.meta.tab) out.push(menuTitle(route.meta.permission, route.meta.tab));
  return out;
});

function toggleGroup(key: string) {
  const s = new Set(openGroups.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  openGroups.value = s;
}

// ---- 收合時的浮出選單 ----
const flyout = ref<{ key: string; top: number; left: number } | null>(null);
const flyoutGroup = computed(() => menus.value.find((g) => g.key === flyout.value?.key) ?? null);
let closeTimer: ReturnType<typeof setTimeout> | undefined;
/** 抽屜模式(窄螢幕)下側欄已展開,不需浮出選單 */
const flyoutEnabled = () => collapsed.value && !matchMedia('(max-width: 960px)').matches;

function openFlyout(key: string, el: HTMLElement) {
  if (!flyoutEnabled()) return;
  clearTimeout(closeTimer);
  const r = el.getBoundingClientRect();
  const count = menus.value.find((g) => g.key === key)?.children.length ?? 0;
  // 預估高度,避免超出視窗底部
  const height = 56 + count * 46;
  flyout.value = { key, top: Math.max(8, Math.min(r.top - 6, innerHeight - height - 8)), left: r.right + 10 };
}
function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => (flyout.value = null), 180);
}
function keepOpen() {
  clearTimeout(closeTimer);
}
/** 收合時點擊只負責打開(滑鼠移入與聚焦時已打開,不做切換以免一點就關);關閉靠移開、Esc 或換頁 */
function onGroupClick(key: string, el: HTMLElement) {
  if (!flyoutEnabled()) return toggleGroup(key);
  openFlyout(key, el);
}
onBeforeUnmount(() => clearTimeout(closeTimer));

watch(
  () => route.fullPath,
  () => {
    drawer.value = false;
    userMenu.value = false;
    flyout.value = null;
    if (activeItem.value) openGroups.value = new Set([...openGroups.value, activeItem.value.group.key]);
  },
);

async function doLogout() {
  userMenu.value = false;
  await auth.logout(); // web-kit:呼叫 /api/auth/logout 後整頁導向 /login(所有應用同時登出,FR-1.6)
}
</script>

<template>
  <div class="shell" :class="{ collapsed, drawer }">
    <div class="scrim" @click="drawer = false" />
    <aside class="sidebar glass">
      <div class="brand">
        <GLogo :size="40" />
        <div class="brand-text">
          <strong>GigaNexus</strong>
          <span>資訊網通管理系統</span>
        </div>
      </div>

      <nav class="nav" aria-label="主選單">
        <template v-for="g in menus" :key="g.key">
          <RouterLink
            v-if="isDirect(g)"
            :to="g.children[0]!.path"
            class="group-btn direct"
            :class="{ current: activeItem?.group.key === g.key }"
            :title="collapsed ? g.title : undefined"
          >
            <span class="gi"><GIcon :name="g.icon" :size="19" /></span>
            <span class="gt"
              >{{ g.title }}<small>{{ g.subtitle }}</small></span
            >
          </RouterLink>
          <div
            v-else
            class="group"
            :class="{ open: openGroups.has(g.key), current: activeItem?.group.key === g.key, hover: flyout?.key === g.key }"
            @mouseenter="openFlyout(g.key, ($event.currentTarget as HTMLElement).querySelector('.group-btn')!)"
            @mouseleave="scheduleClose"
          >
            <button
              type="button"
              class="group-btn"
              :aria-expanded="collapsed ? flyout?.key === g.key : openGroups.has(g.key)"
              :aria-haspopup="collapsed ? 'menu' : undefined"
              @click="onGroupClick(g.key, $event.currentTarget as HTMLElement)"
              @focus="openFlyout(g.key, $event.currentTarget as HTMLElement)"
              @keydown.esc="flyout = null"
            >
              <span class="gi"><GIcon :name="g.icon" :size="19" /></span>
              <span class="gt"
                >{{ g.title }}<small>{{ g.subtitle }}</small></span
              >
              <GIcon name="chevron-down" :size="15" class="chev" />
            </button>
            <div class="items">
              <div class="items-inner">
                <template v-for="c in g.children" :key="c.path">
                  <a v-if="c.href" :href="c.href" target="_blank" rel="noopener noreferrer" class="item">
                    <i class="bullet" />
                    <span class="it">{{ c.title }}</span>
                    <GIcon name="external" :size="13" class="ext" />
                  </a>
                  <RouterLink v-else :to="c.path" class="item" :class="{ active: activeItem?.item.path === c.path }">
                    <i class="bullet" />
                    <span class="it"
                      >{{ c.title }}<small>{{ c.subtitle }}</small></span
                    >
                  </RouterLink>
                </template>
              </div>
            </div>
          </div>
        </template>
      </nav>

      <div class="side-foot">
        <div class="me-card" :title="collapsed ? me?.user.name : undefined">
          <GAvatar :name="me?.user.name ?? '?'" :size="34" />
          <span class="gt">
            <strong>{{ me?.user.name }}</strong>
            <span class="mono">{{ me?.user.employeeNo }}</span>
          </span>
        </div>
        <button type="button" class="collapse-btn" :aria-label="collapsed ? '展開選單' : '收合選單'" @click="collapsed = !collapsed">
          <GIcon :name="collapsed ? 'panel-open' : 'panel-close'" :size="18" />
          <span class="gt">收合選單</span>
        </button>
      </div>
    </aside>

    <div class="main-col">
      <header class="topbar glass">
        <GButton class="burger" variant="ghost" square icon="menu" aria-label="開啟選單" @click="drawer = true" />
        <ol class="crumbs" aria-label="目前位置">
          <li v-for="(c, i) in crumbs" :key="i" :class="{ last: i === crumbs.length - 1 }">{{ c }}</li>
        </ol>
        <div class="spacer" />
        <GStyleToggle />
        <GAppSwitcher :apps="apps.apps" :current="CURRENT_APP" :derived="apps.derived" />
        <div class="user" @keydown.esc="userMenu = false">
          <button type="button" class="user-btn" :aria-expanded="userMenu" aria-haspopup="menu" @click="userMenu = !userMenu">
            <GAvatar :name="me?.user.name ?? '?'" :size="34" />
            <span class="who hide-sm">
              <strong>{{ me?.user.name }}</strong>
              <span>{{ [me?.user.department, me?.user.title].filter(Boolean).join(' · ') || me?.user.employeeNo }}</span>
            </span>
            <GIcon name="chevron-down" :size="15" class="faint" />
          </button>
          <Transition name="pop">
            <div v-if="userMenu" class="menu glass glass-edge" role="menu">
              <div class="menu-head">
                <GAvatar :name="me?.user.name ?? '?'" :size="42" />
                <div>
                  <strong>{{ me?.user.name }}</strong>
                  <div class="faint small mono">{{ me?.user.employeeNo }}</div>
                </div>
              </div>
              <div class="menu-tags">
                <GBadge tone="primary" icon="building">{{ me?.user.department ?? '未指定部門' }}</GBadge>
                <GBadge v-if="me?.user.title" tone="storage" icon="id-card">{{ me?.user.title }}</GBadge>
                <GBadge tone="neutral" icon="key">{{ me?.user.authType === 'ad' ? 'AD 帳號' : '本機帳號' }}</GBadge>
              </div>
              <button type="button" class="menu-item danger" role="menuitem" @click="doLogout"><GIcon name="logout" />登出</button>
            </div>
          </Transition>
          <div v-if="userMenu" class="menu-scrim" @click="userMenu = false" />
        </div>
      </header>

      <main class="content">
        <RouterView v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" :key="route.matched[1]?.path" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <Teleport to="body">
      <Transition name="flyout">
        <div
          v-if="flyout && flyoutGroup"
          class="flyout glass glass-edge"
          role="menu"
          :aria-label="flyoutGroup.title"
          :style="{ top: `${flyout.top}px`, left: `${flyout.left}px` }"
          @mouseenter="keepOpen"
          @mouseleave="scheduleClose"
          @keydown.esc="flyout = null"
          @focusout="($event.relatedTarget as HTMLElement | null)?.closest('.flyout, .group-btn') || scheduleClose()"
        >
          <p class="fly-title"><GIcon :name="flyoutGroup.icon" :size="15" />{{ flyoutGroup.title }}</p>
          <template v-for="c in flyoutGroup.children" :key="c.path">
            <a v-if="c.href" :href="c.href" target="_blank" rel="noopener noreferrer" class="fly-item" role="menuitem">
              <i class="bullet" />{{ c.title }}<GIcon name="external" :size="13" class="ext" />
            </a>
            <RouterLink v-else :to="c.path" class="fly-item" :class="{ active: activeItem?.item.path === c.path }" role="menuitem">
              <i class="bullet" />{{ c.title }}
            </RouterLink>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
  padding: 14px;
  gap: 14px;
}
.sidebar {
  position: sticky;
  top: 14px;
  flex: none;
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  height: calc(100vh - 28px);
  border-radius: var(--radius-xl);
  transition: width 280ms var(--ease);
  overflow: hidden;
  z-index: 20;
}
.collapsed .sidebar {
  width: var(--sidebar-w-collapsed);
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 18px 16px;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  white-space: nowrap;
}
.brand-text strong {
  font-size: var(--fs-lg);
  letter-spacing: -0.01em;
}
.brand-text span {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.nav {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 12px;
}
.group {
  margin-bottom: 4px;
}
.group-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 0 10px;
  border: 0;
  border-radius: 12px;
  background: none;
  font: inherit;
  font-weight: 650;
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--dur),
    color var(--dur);
}
.group-btn:hover {
  background: var(--glass-soft);
  color: var(--text);
}
.group.current .group-btn,
.direct.current {
  color: var(--text);
}
.direct {
  margin-bottom: 4px;
  text-decoration: none;
}
.direct:hover {
  text-decoration: none;
}
/* 中文名稱 + 英文副標(參考畫面) */
.gt small,
.it small {
  display: block;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--text-3);
}
.gt,
.it {
  line-height: 1.25;
}
.gi {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  transition: all var(--dur);
}
.group.current .gi,
.direct.current .gi {
  color: var(--on-primary);
  background: var(--grad-primary);
  box-shadow: var(--shadow-glow);
}
.gt {
  flex: 1;
  text-align: left;
  overflow: hidden;
}
.chev {
  transition: transform var(--dur) var(--ease);
  color: var(--text-3);
}
.group.open .chev {
  transform: rotate(180deg);
}
.items {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 280ms var(--ease);
}
.group.open .items {
  grid-template-rows: 1fr;
}
.items-inner {
  overflow: hidden;
  padding-left: 26px;
  position: relative;
}
.items-inner::before {
  content: '';
  position: absolute;
  left: 25px;
  top: 4px;
  bottom: 8px;
  width: 1px;
  background: var(--line-strong);
}
.item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  margin: 2px 0;
  padding: 0 12px 0 18px;
  border-radius: 10px;
  color: var(--text-2);
  font-weight: 550;
  white-space: nowrap;
  text-decoration: none;
  transition: all var(--dur);
}
.item:hover {
  color: var(--text);
  background: var(--glass-soft);
  text-decoration: none;
}
.item .ext,
.fly-item .ext {
  margin-left: auto;
  color: var(--text-3);
}
.bullet {
  position: absolute;
  left: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bg);
  border: 1.5px solid var(--line-strong);
  transition: all var(--dur);
}
.item.active {
  color: var(--text);
  background: var(--glass-strong);
  box-shadow:
    var(--shadow-sm),
    inset 0 0 0 1px var(--glass-border-2);
}
.item.active .bullet {
  background: var(--c-primary);
  border-color: var(--c-primary);
  box-shadow: 0 0 0 4px var(--focus-ring);
}
/* 收合:只顯示群組圖示,子項目以浮出方式隱藏 */
.collapsed .brand-text,
.collapsed .gt,
.collapsed .chev,
.collapsed .items {
  display: none;
}
.collapsed .group-btn {
  justify-content: center;
  padding: 0;
}
.collapsed .group.hover .group-btn {
  background: var(--glass-soft);
  color: var(--text);
}
/* 浮出選單(Teleport 到 body,以 fixed 定位在收合側欄右側) */
.flyout {
  position: fixed;
  z-index: 40;
  min-width: 200px;
  padding: 8px;
  border-radius: var(--radius-md);
  background: var(--glass-strong);
  box-shadow: var(--shadow-lg);
}
/* 側欄與浮出選單之間的空隙也算在滑鼠範圍內,移過去不會關閉 */
.flyout::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -14px;
  width: 14px;
}
.fly-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 8px 6px;
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.fly-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  color: var(--text-2);
  font-weight: 550;
  white-space: nowrap;
  text-decoration: none;
  transition: all var(--dur);
}
.fly-item .bullet {
  position: static;
}
.fly-item:hover,
.fly-item:focus-visible {
  color: var(--text);
  background: var(--glass-soft);
  text-decoration: none;
}
.fly-item.active {
  color: var(--text);
  background: var(--glass-hover);
  box-shadow: inset 0 0 0 1px var(--glass-border-2);
}
.fly-item.active .bullet {
  background: var(--c-primary);
  border-color: var(--c-primary);
  box-shadow: 0 0 0 4px var(--focus-ring);
}
.flyout-enter-active,
.flyout-leave-active {
  transition:
    opacity 160ms var(--ease),
    transform 160ms var(--ease);
}
.flyout-enter-from,
.flyout-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}
.collapsed .brand {
  justify-content: center;
  padding-inline: 0;
}
.side-foot {
  display: grid;
  gap: 4px;
  padding: 10px 12px 14px;
  border-top: 1px solid var(--line);
}
.me-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 12px;
  color: var(--text);
  text-decoration: none;
  white-space: nowrap;
}
.me-card .gt {
  display: flex;
  flex-direction: column;
  font-size: var(--fs-sm);
}
.me-card .gt span {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.collapsed .me-card {
  justify-content: center;
  padding: 6px 0;
}
.collapsed .me-card .gt {
  display: none;
}
.collapse-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--text-3);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.collapsed .collapse-btn {
  justify-content: center;
  padding: 0;
}
.collapse-btn:hover {
  color: var(--text);
  background: var(--glass-soft);
}

.main-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.topbar {
  position: sticky;
  top: 14px;
  z-index: 15;
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--topbar-h);
  padding: 0 12px 0 20px;
  border-radius: var(--radius-lg);
}
.burger {
  display: none;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-sm);
  color: var(--text-3);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.crumbs li + li::before {
  content: '/';
  margin-right: 8px;
  opacity: 0.5;
}
.crumbs .last {
  color: var(--text);
  font-weight: 650;
}
.user {
  position: relative;
}
.user-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 4px 4px;
  border: 0;
  border-radius: 14px;
  background: none;
  font: inherit;
  color: var(--text);
  cursor: pointer;
}
.user-btn:hover {
  background: var(--glass-soft);
}
.who {
  display: flex;
  flex-direction: column;
  text-align: left;
  line-height: 1.25;
}
.who strong {
  font-size: var(--fs-sm);
}
.who span {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 10px);
  z-index: 30;
  width: 280px;
  padding: 8px;
  background: var(--glass-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}
.menu-scrim {
  position: fixed;
  inset: 0;
  z-index: 25;
}
.menu-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
}
.menu-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 10px 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 6px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: 10px;
  background: none;
  font: inherit;
  color: var(--text);
  cursor: pointer;
}
.menu-item:hover {
  background: var(--glass-soft);
}
.menu-item.danger {
  color: var(--c-danger);
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
.content {
  flex: 1;
  min-width: 0;
  padding: 6px 6px 24px;
}
.scrim {
  display: none;
}

@media (max-width: 960px) {
  .shell {
    padding: 10px;
  }
  .sidebar {
    position: fixed;
    top: 10px;
    left: 10px;
    bottom: 10px;
    height: auto;
    width: var(--sidebar-w) !important;
    transform: translateX(-110%);
    transition: transform 300ms var(--ease);
    background: var(--glass-strong);
  }
  .drawer .sidebar {
    transform: none;
  }
  .drawer .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 19;
    background: var(--overlay);
    backdrop-filter: blur(4px);
  }
  .collapsed .brand-text,
  .collapsed .gt,
  .collapsed .chev {
    display: initial;
  }
  .collapsed .items {
    display: grid;
  }
  .side-foot {
    display: none;
  }
  .burger {
    display: inline-flex;
  }
  .topbar {
    top: 10px;
    padding-left: 8px;
  }
  .content {
    padding: 2px 0 20px;
  }
}
@media (max-width: 760px) {
  .hide-sm {
    display: none;
  }
}
</style>
