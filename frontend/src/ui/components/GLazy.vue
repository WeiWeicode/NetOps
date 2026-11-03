<script setup lang="ts">
/**
 * 懶加載區塊:捲動到接近可視範圍時才渲染內容(內容元件的 onMounted 才會打 API)。
 * 用於頁面下半部、非第一眼需要的區塊,避免進頁面就一次載入全部資料。
 *   <GLazy min-height="320px"><WorkSection /></GLazy>
 * 瀏覽器不支援 IntersectionObserver 時直接渲染。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(defineProps<{ minHeight?: string; rootMargin?: string }>(), { minHeight: '200px', rootMargin: '200px 0px' });
const el = ref<HTMLElement>();
const visible = ref(false);
let io: IntersectionObserver | null = null;

onMounted(() => {
  if (!('IntersectionObserver' in window)) return void (visible.value = true);
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        visible.value = true;
        io?.disconnect();
      }
    },
    { rootMargin: props.rootMargin },
  );
  io.observe(el.value!);
});
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <div ref="el" class="g-lazy" :style="visible ? undefined : { minHeight }">
    <slot v-if="visible" />
    <slot v-else name="placeholder" />
  </div>
</template>

<style scoped>
.g-lazy {
  min-width: 0;
}
</style>
