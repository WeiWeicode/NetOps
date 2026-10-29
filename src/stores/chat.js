import { ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * AI 問答的對話：放在 store，切換頁面回來還在；PA 防火牆（messages）與 AD 網域（adMessages）分開
 * 重新整理瀏覽器就清空（不存到伺服器）
 */
export const useChatStore = defineStore('chat', () => {
  const messages = ref([]) // { role, content, kind?, evidence?, notes?, ... }
  const adMessages = ref([])
  return { messages, adMessages }
})
