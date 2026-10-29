<script setup>
import { computed, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { LogOut, Menu, X, User, PanelLeftClose, PanelLeftOpen, ExternalLink } from 'lucide-vue-next'
import ThemeToggle from '../components/ThemeToggle.vue'
import FontSizeControl from '../components/FontSizeControl.vue'
import CompanyLogo from '../components/CompanyLogo.vue'
import { useUserStore } from '../stores/user.js'
import http from '../api/http.js'
import { menuGroups } from '../router/menu.js'
import { useIsMobile } from '../composables/useIsMobile.js'

const user = useUserStore()
const route = useRoute()
const router = useRouter()
const isMobileMenuOpen = ref(false)

/** 收合側邊選單（只剩圖示，桌面版才有），選擇記在瀏覽器 */
const MINI_KEY = 'netops-sidebar-mini'
const isMobile = useIsMobile()
const miniSaved = ref((() => {
  try {
    return localStorage.getItem(MINI_KEY) === '1'
  } catch {
    return false
  }
})())
const mini = computed(() => miniSaved.value && !isMobile.value)
function toggleMini() {
  miniSaved.value = !miniSaved.value
  try {
    localStorage.setItem(MINI_KEY, miniSaved.value ? '1' : '0')
  } catch {
    // 存不了就只在這次瀏覽有效
  }
}

const groups = computed(() => menuGroups.map((g) => ({ ...g, items: g.items.filter((m) => !m.hidden) })).filter((g) => g.items.length))

watch(() => route.fullPath, () => (isMobileMenuOpen.value = false))

/**
 * 同步登入到其他系統：先開空白分頁（在點擊當下開，才不會被瀏覽器擋彈出視窗），
 * 取得 {系統}/SyncLogin?SyncCode=... 後導過去；失敗時改開一般登入頁
 */
async function openJump(e, m) {
  e.preventDefault()
  const win = window.open('', '_blank')
  try {
    const res = await http.post(`/jump/${m.jump}`)
    if (win) win.location.href = res.data.url
    else window.location.href = res.data.url
  } catch (err) {
    ElMessage.warning(`無法同步登入 ${m.title}（${err.message}），改開登入頁`)
    if (win) win.location.href = m.href
  }
}

const handleLogout = () => {
  user.logout()
  ElMessage({ message: '已成功登出系統', type: 'info', plain: true })
  router.push({ name: 'Login' })
}

const linkClass = [
  'flex items-center gap-3 py-2 rounded-lg text-mute hover:text-ink hover:bg-brand-50 transition-colors border border-transparent',
]
</script>

<template>
  <div class="app-shell flex h-svh w-full overflow-hidden">
    <!-- 手機版頂部列 -->
    <header class="no-print md:hidden glass border-x-0 border-t-0 h-16 flex items-center justify-between px-4 fixed top-0 inset-x-0 z-40">
      <div class="flex items-center gap-2">
        <CompanyLogo variant="mark" :size="34" />
        <span class="font-bold text-ink tracking-wide">資訊網通管理系統</span>
      </div>
      <div class="flex items-center gap-1">
        <FontSizeControl />
        <ThemeToggle />
        <button type="button" class="p-2 rounded-lg text-mute hover:text-ink hover:bg-brand-50 transition-colors"
          :aria-label="isMobileMenuOpen ? '關閉選單' : '開啟選單'" @click="isMobileMenuOpen = !isMobileMenuOpen">
          <X v-if="isMobileMenuOpen" :size="24" />
          <Menu v-else :size="24" />
        </button>
      </div>
    </header>

    <div v-if="isMobileMenuOpen" class="md:hidden fixed inset-0 bg-overlay z-40" @click="isMobileMenuOpen = false"></div>

    <!-- 側邊欄 -->
    <aside :class="[
      'no-print glass border-y-0 border-l-0 flex flex-col shrink-0 fixed md:static inset-y-0 left-0 z-50 transition-[transform,width] duration-300',
      mini ? 'w-16' : 'w-64',
      isMobileMenuOpen ? 'translate-x-0 bg-glass-strong' : '-translate-x-full md:translate-x-0',
    ]">
      <div :class="['h-16 flex items-center border-b border-glow', mini ? 'justify-center px-2' : 'justify-between px-5']">
        <div class="flex items-center gap-2.5 min-w-0">
          <CompanyLogo variant="mark" :size="38" />
          <div v-if="!mini" class="min-w-0 leading-tight">
            <p class="m-0 text-lg font-bold text-ink truncate">資訊網通</p>
            <p class="m-0 text-xs text-mute truncate">NetOps</p>
          </div>
        </div>
        <ThemeToggle v-if="!mini" class="hidden md:inline-flex" />
      </div>

      <nav :class="['flex-1 overflow-y-auto overflow-x-hidden', mini ? 'p-2 space-y-2' : 'p-3 space-y-2']">
        <div v-for="(g, gi) in groups" :key="g.title">
          <div v-if="mini && gi > 0" class="mx-2 border-t border-glow" />
          <p v-if="!mini" class="px-3 py-1 m-0 text-xs font-semibold text-dim tracking-widest">{{ g.title }}</p>
          <div :class="['space-y-0.5', mini ? 'mt-2' : 'mt-1']">
            <template v-for="m in g.items" :key="m.name">
              <!-- 其他系統：另開分頁 -->
              <a v-if="m.href" :href="m.href" target="_blank" rel="noopener" @click="(e) => m.jump && openJump(e, m)" :title="mini ? `${m.title}（另開分頁）` : '另開分頁'" :aria-label="`${m.title}（另開分頁）`"
                :class="[...linkClass, mini ? 'justify-center px-0' : 'px-3']">
                <component :is="m.icon" :size="mini ? 20 : 18" class="shrink-0" />
                <span v-if="!mini" class="text-sm truncate flex-1">{{ m.title }}</span>
                <ExternalLink v-if="!mini" :size="13" class="shrink-0 text-dim" />
              </a>
              <RouterLink v-else :to="{ name: m.name }" :title="mini ? m.title : undefined" :aria-label="m.title"
                :class="[...linkClass, mini ? 'justify-center px-0' : 'px-3', route.meta.parent === m.name ? '!text-ink bg-brand-500/15 !border-glow' : '']"
                active-class="!text-ink bg-brand-500/15 !border-glow">
                <component :is="m.icon" :size="mini ? 20 : 18" class="shrink-0" />
                <span v-if="!mini" class="text-sm truncate">{{ m.title }}</span>
              </RouterLink>
            </template>
          </div>
        </div>
      </nav>

      <!-- 收合 / 展開側邊選單（桌面版） -->
      <button type="button" :title="mini ? '展開側邊選單' : '收合側邊選單'" :aria-label="mini ? '展開側邊選單' : '收合側邊選單'" @click="toggleMini"
        :class="['hidden md:flex items-center gap-2 border-t border-glow text-sm text-mute hover:text-ink hover:bg-brand-50 transition-colors', mini ? 'justify-center py-3' : 'px-5 py-2.5']">
        <PanelLeftOpen v-if="mini" :size="18" />
        <template v-else><PanelLeftClose :size="18" />收合選單</template>
      </button>

      <div :class="['border-t border-glow', mini ? 'p-2 flex flex-col items-center gap-2' : 'p-4']">
        <template v-if="mini"><FontSizeControl /><ThemeToggle /></template>
        <div :class="['flex items-center gap-3', mini ? '' : 'mb-3']" :title="mini ? `${user.name} ${user.userid}` : undefined">
          <div class="w-10 h-10 rounded-full bg-brand-500/15 text-brand-500 ring-1 ring-glow flex items-center justify-center shrink-0">
            <User :size="20" />
          </div>
          <div v-if="!mini" class="min-w-0 text-sm">
            <p class="m-0 font-bold text-ink truncate">{{ user.name }} <span class="font-normal text-mute">{{ user.userid }}</span></p>
            <p class="m-0 text-xs text-mute truncate">{{ user.deptName }}</p>
          </div>
          <FontSizeControl v-if="!mini" class="ml-auto shrink-0" />
        </div>
        <button type="button" :title="mini ? '登出' : undefined" aria-label="登出" @click="handleLogout"
          :class="['flex items-center justify-center gap-2 py-2 text-sm rounded-lg border border-glow text-mute hover:text-white hover:bg-danger hover:border-danger transition-colors', mini ? 'w-10' : 'w-full']">
          <LogOut :size="16" /><span v-if="!mini">登出</span>
        </button>
      </div>
    </aside>

    <main class="flex-1 min-w-0 overflow-y-auto pt-16 md:pt-0">
      <div class="p-3 md:p-4 max-w-[1800px] mx-auto h-full flex flex-col">
        <RouterView :key="String(route.name)" />
      </div>
    </main>
  </div>
</template>
