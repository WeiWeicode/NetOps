import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 是否為手機寬度（< 768px），表單標籤改放上方 */
export function useIsMobile() {
  const query = window.matchMedia('(max-width: 767px)')
  const isMobile = ref(query.matches)
  const update = (e) => (isMobile.value = e.matches)
  onMounted(() => query.addEventListener('change', update))
  onBeforeUnmount(() => query.removeEventListener('change', update))
  return isMobile
}
