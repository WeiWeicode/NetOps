<script setup>
import { Moon, Sun } from 'lucide-vue-next'
import { themeMode, toggleThemeMode } from '../composables/useThemeMode.js'
</script>

<template>
  <button type="button" @click="toggleThemeMode"
    class="p-2 rounded-lg text-mute hover:text-ink hover:bg-brand-50 transition-colors"
    :aria-label="themeMode === 'dark' ? '切換為明亮模式' : '切換為暗色模式'"
    :title="themeMode === 'dark' ? '切換為明亮模式' : '切換為暗色模式'">
    <Sun v-if="themeMode === 'dark'" :size="20" />
    <Moon v-else :size="20" />
  </button>
</template>
