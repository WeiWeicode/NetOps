/**
 * IP 旁邊顯示名稱(GIpLabel、GTable 的 ip 欄):ui 不知道名稱從哪裡來,由應用在 main.ts 以 provide 注入查詢函式
 * (NetOps:composables/ipNames.ts,資料來自 PA API 回應的 names;IMPL-PLAN AC3)。沒有注入時只顯示 IP。
 */
import type { InjectionKey } from 'vue';

export interface IpLabel {
  /** 顯示在 IP 旁邊的短文字(姓名,沒有時設備名稱或部門) */
  text: string;
  /** 完整說明(滑鼠提示與報讀文字:姓名、部門、設備) */
  title: string;
}
export type IpLabelResolver = (ip: string) => IpLabel | undefined;
export const IP_LABEL_KEY: InjectionKey<IpLabelResolver> = Symbol('ip-label');
