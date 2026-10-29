import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '../router/index.js'
import { getToken, clearToken } from '../stores/token.js'

/** API 與前端同一個網站：開發時由 Vite 代理 /api，正式環境為 /NetOps/api */
export const apiBase = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}/g, '/')

const http = axios.create({ baseURL: apiBase, timeout: 60000 })

http.interceptors.request.use((cfg) => {
  const token = getToken()
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const status = err.response?.status
    const message = err.response?.data?.message || err.message || '系統連線異常'
    if (status === 401 && router.currentRoute.value.meta.public !== true) {
      clearToken()
      router.push({ name: 'Login', query: { redirect: router.currentRoute.value.fullPath } })
    }
    return Promise.reject(Object.assign(new Error(message), { status }))
  }
)

/** 呼叫 API，失敗時跳出錯誤訊息並回傳 null */
export async function call(promise, { silent = false } = {}) {
  try {
    return await promise
  } catch (err) {
    if (!silent) ElMessage.error(err.message)
    return null
  }
}

export default http
