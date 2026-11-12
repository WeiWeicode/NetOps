/**
 * 「查詢該 IP 當下 PA 即時連線」(VIZ-RULES-DESIGN §4.1、§4.8):要等 C5(PA 精準查詢,netops.pa-query.read,只給 admin)。
 * C5 完成前 canQuery 一律 false,按鈕不顯示;query 不會呼叫任何 API。
 */
import { computed } from 'vue';

export function useLivePaQuery() {
  const canQuery = computed(() => false);
  async function query(_ip: string): Promise<never> {
    throw new Error('查詢即時連線要等 PA 精準查詢(C5)完成');
  }
  return { canQuery, query };
}
