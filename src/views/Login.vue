<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { User, Lock, LogIn } from 'lucide-vue-next'
import { ElMessage } from 'element-plus'
import AuthCard from '../components/AuthCard.vue'
import http from '../api/http.js'
import { useUserStore } from '../stores/user.js'

const REMEMBER_KEY = 'netops-userid'
const router = useRouter()
const route = useRoute()
const user = useUserStore()

const form = reactive({ username: '', password: '' })
const rememberMe = ref(false)
const loading = ref(false)

const goNext = () => router.replace(String(route.query.redirect || '') || { name: 'Dashboard' })

async function handleLogin() {
  if (!form.username || !form.password) {
    ElMessage.warning('請輸入帳號與密碼')
    return
  }
  loading.value = true
  try {
    const res = await http.post('/auth/login', { username: form.username.trim(), password: form.password })
    try {
      if (rememberMe.value) localStorage.setItem(REMEMBER_KEY, form.username.trim())
      else localStorage.removeItem(REMEMBER_KEY)
    } catch {
      // ignore
    }
    await user.login(res.token)
    ElMessage.success(`登入成功！歡迎回來，${user.name || user.userid}`)
    goNext()
  } catch (err) {
    ElMessage.error(err.message || '登入失敗，請檢查帳號密碼')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // 已登入（token 未過期）直接進入系統
  if (await user.fetchMe()) return goNext()
  try {
    const saved = localStorage.getItem(REMEMBER_KEY)
    if (saved) {
      form.username = saved
      rememberMe.value = true
    }
  } catch {
    // ignore
  }
})
</script>

<template>
  <AuthCard title="登入">
    <el-form label-position="top" size="large" @submit.prevent="handleLogin">
      <el-form-item label="員工工號">
        <el-input v-model="form.username" placeholder="請輸入工號 (e.g. S114099)" autocomplete="username" clearable>
          <template #prefix><User :size="18" /></template>
        </el-input>
      </el-form-item>
      <el-form-item label="登入密碼">
        <el-input v-model="form.password" type="password" placeholder="請輸入網域密碼" autocomplete="current-password" show-password>
          <template #prefix><Lock :size="18" /></template>
        </el-input>
      </el-form-item>
      <el-form-item>
        <el-checkbox v-model="rememberMe">記住工號</el-checkbox>
      </el-form-item>
      <el-button type="primary" native-type="submit" class="w-full" :loading="loading">
        <LogIn v-if="!loading" :size="18" class="mr-2" />{{ loading ? '網域驗證中...' : '立即登入' }}
      </el-button>
    </el-form>
  </AuthCard>
</template>
