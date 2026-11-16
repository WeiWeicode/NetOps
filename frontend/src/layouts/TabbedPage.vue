<script setup lang="ts">
/**
 * 第二層功能頁的外框:頁首 + 頁籤(Tab)+ 子路由內容(PRD FR-3.1)。
 * 標題、英文副標、說明、圖示與 Tab 定義在路由 meta(router.ts),子路由就是各個 Tab;沒有權限的 Tab 由 GTabs 隱藏。
 * 標題、圖示與 Tab 名稱以 BFF 為準(GigaItApp「選單管理」可改名),與側欄一致(同 GigaItApp)。
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { menuIcon, menuTitle } from '@/api/gateway';

const route = useRoute();
const page = computed(() => {
  const m = route.matched[1]!.meta;
  return {
    ...m,
    title: menuTitle(m.permission, m.title ?? ''),
    icon: m.icon ? menuIcon(m.permission, m.icon) : m.icon,
    tabs: m.tabs?.map((t) => ({ ...t, label: menuTitle(t.permission, t.label) })),
  };
});
</script>

<template>
  <div class="tabbed stack">
    <GPageHeader :title="page.title" :description="page.description" :icon="page.icon" :eyebrow="page.subtitle">
      <div id="page-actions" class="row" />
    </GPageHeader>
    <GTabs v-if="page.tabs && page.tabs.length > 1" :items="page.tabs" />
    <RouterView v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" :key="route.path" />
      </Transition>
    </RouterView>
  </div>
</template>

<style scoped>
.tabbed {
  --gap: 20px;
}
</style>
