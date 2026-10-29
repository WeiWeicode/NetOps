<script setup>
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Loader2 } from 'lucide-vue-next'
import AuthCard from '../components/AuthCard.vue'
import http from '../api/http.js'
import { useUserStore } from '../stores/user.js'

// 從入口網站帶 SyncCode 同步登入
const route = useRoute()
const router = useRouter()
const user = useUserStore()
const error = ref('')

onMounted(async () => {
  try {
    const res = await http.get('/auth/sync', { params: { SyncCode: route.query.SyncCode } })
    await user.login(res.token)
    router.replace(String(route.query.redirect || '') || { name: 'Dashboard' })
  } catch (err) {
    error.value = err.message || '查無資料或認證逾時'
  }
})
</script>

<template>
  <AuthCard title="同步登入">
    <div v-if="!error" class="flex items-center justify-center gap-3 text-mute py-6">
      <Loader2 :size="22" class="animate-spin text-brand-500" /> 正在同步登入狀態...
    </div>
    <div v-else class="space-y-4">
      <div class="bg-warn/10 border border-warn/40 text-warn rounded-lg p-3">{{ error }}</div>
      <el-button type="primary" class="w-full" @click="router.replace({ name: 'Login' })">改用帳號密碼登入</el-button>
    </div>
  </AuthCard>
</template>
