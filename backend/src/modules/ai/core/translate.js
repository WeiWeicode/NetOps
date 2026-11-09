/**
 * 翻譯(由舊版 server/lib/llm.js 搬移,IMPL-PLAN A1):語言清單、長文分段與翻譯提示,內容與舊版相同。
 * 呼叫模型由 infra/llm 負責;翻譯沿用 LLM_URL / LLM_MODEL(關閉思考模式,PA-LIVE-PLAN §6,2026-11-04 決定)。
 */

export const LANGS = {
  en: 'English',
  zh: '繁體中文（台灣用語）',
  ja: '日本語（自然な丁寧語）',
  th: 'ภาษาไทย（泰文，自然的書面語）',
}

/** Markdown 依段落切塊（每塊約 3000 字），長文分段平行翻譯 */
export function chunks(text, size = 3000) {
  const parts = []
  let cur = ''
  for (const p of String(text).split(/\n(?=#{1,6} |\n)/)) {
    if (cur && cur.length + p.length > size) {
      parts.push(cur)
      cur = ''
    }
    cur += (cur ? '\n' : '') + p
  }
  if (cur) parts.push(cur)
  return parts
}

/** 翻譯用的系統提示；保留格式、IP、Port、規則名稱 */
export const translateSystem = (target) =>
  `你是專業的 IT / 網路資安文件翻譯員。請把使用者給的內容翻譯成${LANGS[target]}。\n` +
  '規則：\n' +
  '1. 只輸出譯文，不要加說明、原文或任何前綴。\n' +
  '2. 保留 Markdown 格式（標題、清單、表格、粗體、程式碼）與表情符號。\n' +
  '3. IP、Port、網段、防火牆規則名稱、App 名稱、主機名稱、數字、日期時間照原樣保留。\n' +
  '4. 專有名詞用該語言 IT 領域的慣用說法（例如 interzone-default、policy-deny 保留英文）。'

/** 各段譯文 → 全文（舊版 translate 的合併方式） */
export const joinParts = (parts) => parts.map((p) => p.trim()).join('\n\n')
