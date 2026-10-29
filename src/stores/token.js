const KEY = 'netops-token'

export const getToken = () => {
  try {
    return localStorage.getItem(KEY) || ''
  } catch {
    return ''
  }
}

export const setToken = (token) => {
  try {
    localStorage.setItem(KEY, token)
  } catch {
    // 無法儲存時只在這次分頁有效
  }
}

export const clearToken = () => {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
