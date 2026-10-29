import { defineStore } from 'pinia'
import http from '../api/http.js'
import { getToken, setToken, clearToken } from './token.js'

export const useUserStore = defineStore('user', {
  state: () => ({
    userid: '',
    name: '',
    deptName: '',
    comp: '',
    kbAdmin: false, // 知識庫管理者：可請 AI 記錄、新增 / 修改 / 刪除筆記
    loaded: false,
  }),
  getters: {
    isLoggedIn: (s) => Boolean(s.userid),
  },
  actions: {
    async login(token) {
      setToken(token)
      await this.fetchMe()
    },
    /** 依 token 取得登入者資料；沒有 token 或已失效回傳 false */
    async fetchMe() {
      if (!getToken()) return false
      try {
        const res = await http.get('/auth/me')
        Object.assign(this, res.data, { loaded: true })
        return true
      } catch (err) {
        // 只有 token 失效或沒有權限才清掉；API 暫時連不上（例如重新啟動中）保留 token
        if (err.status === 401 || err.status === 403) clearToken()
        this.$reset()
        return false
      }
    },
    logout() {
      clearToken()
      this.$reset()
    },
  },
})
