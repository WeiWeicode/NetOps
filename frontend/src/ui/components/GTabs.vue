<script setup lang="ts">
/**
 * 頁籤:
 *   - 路由模式:items 帶 to,以 RouterLink 切換(頁面內 Tab 對應子路由,重新整理仍停在同一個 Tab)
 *   - 本地模式:items 帶 value,v-model 切換
 * item.permission 沒有權限時不顯示。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { can } from '@/api/gateway';

export interface TabItem {
  label: string;
  to?: string;
  value?: string;
  icon?: string;
  permission?: string;
  count?: number | string;
}

const props = defineProps<{ items: TabItem[]; modelValue?: string }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();
const route = useRoute();

const visible = computed(() => props.items.filter((t) => !t.permission || can(t.permission)));
const activeKey = computed(() => {
  if (props.modelValue !== undefined) return props.modelValue;
  // 最長前綴相符的 Tab 為目前 Tab
  const hits = visible.value.filter((t) => t.to && (route.path === t.to || route.path.startsWith(`${t.to}/`)));
  return hits.sort((a, b) => b.to!.length - a.to!.length)[0]?.to;
});
const keyOf = (t: TabItem) => t.to ?? t.value ?? t.label;

const bar = ref<HTMLElement>();
const indicator = ref({ left: 0, width: 0, ready: false });
async function measure() {
  await nextTick();
  const el = bar.value?.querySelector<HTMLElement>('.tab.active');
  if (el) indicator.value = { left: el.offsetLeft, width: el.offsetWidth, ready: true };
}
watch([activeKey, visible], measure);
onMounted(() => {
  measure();
  // 字型載入後寬度可能改變
  document.fonts?.ready.then(measure);
});
</script>

<template>
  <nav ref="bar" class="g-tabs glass" role="tablist">
    <span class="indicator" :class="{ ready: indicator.ready }" :style="{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }" />
    <template v-for="t in visible" :key="keyOf(t)">
      <RouterLink v-if="t.to" :to="t.to" class="tab" :class="{ active: activeKey === t.to }" role="tab" :aria-selected="activeKey === t.to">
        <GIcon v-if="t.icon" :name="t.icon" :size="16" />
        {{ t.label }}
        <span v-if="t.count !== undefined" class="count">{{ t.count }}</span>
      </RouterLink>
      <button
        v-else
        type="button"
        class="tab"
        :class="{ active: activeKey === t.value }"
        role="tab"
        :aria-selected="activeKey === t.value"
        @click="emit('update:modelValue', t.value!)"
      >
        <GIcon v-if="t.icon" :name="t.icon" :size="16" />
        {{ t.label }}
        <span v-if="t.count !== undefined" class="count">{{ t.count }}</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.g-tabs {
  position: relative;
  display: inline-flex;
  gap: 2px;
  padding: 4px;
  border-radius: var(--radius-md);
  max-width: 100%;
  overflow-x: auto;
  box-shadow: var(--shadow-sm);
}
.indicator {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 0;
  border-radius: 10px;
  background: var(--glass-strong);
  box-shadow:
    var(--shadow-sm),
    inset 0 0 0 1px color-mix(in srgb, var(--c-primary) 35%, transparent),
    var(--shadow-glow);
  opacity: 0;
  transition:
    transform 320ms var(--ease),
    width 320ms var(--ease);
}
.indicator.ready {
  opacity: 1;
}
.tab {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 16px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  font: inherit;
  font-weight: 600;
  font-size: var(--fs-md);
  color: var(--text-2);
  white-space: nowrap;
  cursor: pointer;
  text-decoration: none;
  transition: color var(--dur);
}
.tab:hover {
  color: var(--text);
  text-decoration: none;
}
.tab.active {
  color: var(--c-primary-text);
}
.count {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 99px;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
</style>
