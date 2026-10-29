import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '../stores/user.js'
import { menuItems } from './menu.js'

const HOME = { name: 'Dashboard' }

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: HOME },
    { path: '/Login', name: 'Login', component: () => import('../views/Login.vue'), meta: { public: true } },
    { path: '/SyncLogin', name: 'SyncLogin', component: () => import('../views/SyncLogin.vue'), meta: { public: true } },
    {
      path: '/Main',
      component: () => import('../layouts/Main.vue'),
      children: [
        { path: '', redirect: HOME },
        ...menuItems.map((m) => ({
          path: m.path,
          name: m.name,
          component: m.component,
          props: m.props ?? false,
          // docTitle：瀏覽器分頁標題（AD 與防火牆的選單名稱相同時區分用）
          meta: { title: m.docTitle ?? m.title, icon: m.icon, parent: m.parent },
        })),
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: HOME },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  const user = useUserStore()
  if (!user.loaded && !(await user.fetchMe())) {
    return { name: 'Login', query: { redirect: to.fullPath } }
  }
  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - 資訊網通管理系統` : '資訊網通管理系統'
})

export default router
