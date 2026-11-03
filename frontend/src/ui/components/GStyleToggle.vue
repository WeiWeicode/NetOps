<script setup lang="ts">
/**
 * 風格(玻璃 ↔ 扁平)與明暗切換按鈕(PRD FR-6.3–6.4、UI-GUIDE §2.1);切換立即生效、不重新載入,偏好記在瀏覽器。
 * 瀏覽器不支援模糊或已開啟「減少透明度」時,風格固定為扁平並停用按鈕。
 */
import { computed } from 'vue';
import { useTheme } from '@/composables/theme';

const { theme, style, styleForced, toggleTheme, toggleStyle } = useTheme();
const styleLabel = computed(() =>
  styleForced.value ? '目前為扁平風格(瀏覽器不支援模糊效果或已開啟「減少透明度」)' : style.value === 'glass' ? '切換為扁平風格' : '切換為玻璃風格',
);
</script>

<template>
  <div class="g-style-toggle">
    <GButton
      variant="ghost"
      square
      :icon="style === 'glass' ? 'layers' : 'square'"
      :aria-label="styleLabel"
      :title="styleLabel"
      :aria-pressed="style === 'flat'"
      :disabled="styleForced"
      @click="toggleStyle"
    />
    <GButton
      variant="ghost"
      square
      :icon="theme === 'dark' ? 'sun' : 'moon'"
      :aria-label="theme === 'dark' ? '切換明亮模式' : '切換黑暗模式'"
      :title="theme === 'dark' ? '切換明亮模式' : '切換黑暗模式'"
      @click="toggleTheme"
    />
  </div>
</template>

<style scoped>
.g-style-toggle {
  display: inline-flex;
  gap: 2px;
}
</style>
