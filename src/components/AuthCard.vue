<script setup>
import ThemeToggle from './ThemeToggle.vue'
import FontSizeControl from './FontSizeControl.vue'
import CompanyLogo from './CompanyLogo.vue'

defineProps({
  title: { type: String, required: true },
  wide: { type: Boolean, default: false },
})
</script>

<template>
  <div class="min-h-svh flex items-center justify-center p-4 sm:p-6">
    <div :class="['glass w-full rounded-3xl overflow-hidden', wide ? 'max-w-4xl' : 'max-w-lg']">
      <!-- 標誌在左、系統名稱與標題置中、切換明暗在右 -->
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-6 py-5 border-b border-glow bg-brand-50">
        <CompanyLogo variant="mark" :size="76" />
        <div class="text-center min-w-0">
          <p class="text-base text-mute m-0 tracking-wide">資訊網通管理系統</p>
          <h1 class="text-3xl font-bold text-ink m-0 mt-1">{{ title }}</h1>
        </div>
        <div class="w-[76px] flex justify-end self-start"><FontSizeControl /><ThemeToggle /></div>
      </div>
      <div class="p-7 md:p-10"><slot /></div>
      <div class="px-7 pb-7 text-center text-xs text-dim">
        © 2026 碩禾電子材料 資訊課 Information Technology Section.<br />建議使用 Chrome 或 Edge 瀏覽器以獲得最佳體驗
      </div>
    </div>
  </div>
</template>
