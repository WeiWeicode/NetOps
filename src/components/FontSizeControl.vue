<script setup>
import { ref } from 'vue'
import { ALargeSmall, Check } from 'lucide-vue-next'
import { FONT_SCALES, fontScale, scaleLabel, setFontScale, systemFontScale } from '../composables/useFontScale.js'

/** 個人字體大小（存在這台電腦的瀏覽器）；「依系統預設」= 管理員在樣式設定的設定 */
const system = ref(1)
const onVisible = (v) => v && (system.value = systemFontScale())
const current = () => (fontScale.value ? scaleLabel(fontScale.value) : `依系統預設（${scaleLabel(systemFontScale())}）`)
</script>

<template>
  <el-dropdown trigger="click" placement="bottom-end" @visible-change="onVisible" @command="(v) => setFontScale(v === 'system' ? null : v)">
    <button type="button" class="p-2 rounded-lg text-mute hover:text-ink hover:bg-brand-50 transition-colors" :aria-label="`字體大小：${current()}`" :title="`字體大小：${current()}`">
      <ALargeSmall :size="20" />
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item disabled class="!cursor-default">字體大小（只影響這台電腦）</el-dropdown-item>
        <el-dropdown-item command="system" divided>
          <Check :size="14" :class="['mr-2', fontScale ? 'invisible' : '']" />依系統預設（{{ scaleLabel(system) }}）
        </el-dropdown-item>
        <el-dropdown-item v-for="s in FONT_SCALES" :key="s.value" :command="s.value">
          <Check :size="14" :class="['mr-2', fontScale === s.value ? '' : 'invisible']" />
          <span :style="{ fontSize: `calc(${s.value}rem * 0.9)` }">{{ s.label }}</span>
          <span class="ml-2 text-xs text-dim">{{ Math.round(s.value * 100) }}%</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
