import { config } from '../config.js'

/**
 * 公司內部 vLLM（OpenAI 相容 API，config.llm）
 * 與 Veeam 備份監控相同：串流回答，思考內容不顯示只回報字數
 */
let modelCache = { at: 0, id: '' }
const authHeader = () => (config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {})

/** 模型名稱（沒設定時取 /models 第一個，快取 10 分鐘） */
export async function llmModel() {
  if (config.llm.model) return config.llm.model
  if (modelCache.id && Date.now() - modelCache.at < 600000) return modelCache.id
  const res = await fetch(`${config.llm.url}/models`, { headers: authHeader(), signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`LLM 服務回應 ${res.status}`)
  const body = await res.json()
  const id = body.data?.[0]?.id
  if (!id) throw new Error('LLM 服務沒有可用的模型')
  modelCache = { at: Date.now(), id }
  return id
}

/** 一次取得完整回答（不串流、不思考），例如整理筆記 */
export async function chatOnce({ model, messages, maxTokens = 3000, temperature = 0.2, url = config.llm.url }) {
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    signal: AbortSignal.timeout(Math.min(config.llm.timeoutMs, 180000)),
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false }, messages }),
  })
  if (!res.ok) throw new Error(`AI 服務回應 ${res.status}：${(await res.text()).slice(0, 300)}`)
  const body = await res.json()
  return body.choices?.[0]?.message?.content ?? ''
}

/* ───────── 翻譯（與 AiService 會議翻譯相同：關閉思考、翻譯專用提示） ───────── */

export const LANGS = {
  en: 'English',
  zh: '繁體中文（台灣用語）',
  ja: '日本語（自然な丁寧語）',
  th: 'ภาษาไทย（泰文，自然的書面語）',
}

/** Markdown 依段落切塊（每塊約 3000 字），長文分段平行翻譯 */
function chunks(text, size = 3000) {
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

/** 文字（可含 Markdown）→ 目標語言；保留格式、IP、Port、規則名稱 */
export async function translate(text, target) {
  if (!LANGS[target]) throw new Error('不支援的語言')
  const model = config.translate.model || (await llmModel())
  const system =
    `你是專業的 IT / 網路資安文件翻譯員。請把使用者給的內容翻譯成${LANGS[target]}。\n` +
    '規則：\n' +
    '1. 只輸出譯文，不要加說明、原文或任何前綴。\n' +
    '2. 保留 Markdown 格式（標題、清單、表格、粗體、程式碼）與表情符號。\n' +
    '3. IP、Port、網段、防火牆規則名稱、App 名稱、主機名稱、數字、日期時間照原樣保留。\n' +
    '4. 專有名詞用該語言 IT 領域的慣用說法（例如 interzone-default、policy-deny 保留英文）。'
  const parts = await Promise.all(
    chunks(text).map((part) =>
      chatOnce({ model, url: config.translate.url, maxTokens: 6000, messages: [{ role: 'system', content: system }, { role: 'user', content: part }] })
    )
  )
  return parts.map((p) => p.trim()).join('\n\n')
}

/** 開始回應 SSE；回傳 send(event, data) */
export function startSse(res) {
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  return (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

/**
 * 串流呼叫 LLM，把回答轉成 SSE：thinking（思考字數）、content（回答片段）、done / error
 * 使用者關閉連線或超過 LLM_TIMEOUT_MS 時中斷；結束時關閉 res
 */
export async function streamChat(res, send, { model, messages, think = false }) {
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  const timer = setTimeout(() => abort.abort(), config.llm.timeoutMs)
  try {
    const upstream = await fetch(`${config.llm.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      signal: abort.signal,
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.3,
        max_tokens: think ? 12000 : 4000,
        chat_template_kwargs: { enable_thinking: think },
        messages,
      }),
    })
    if (!upstream.ok || !upstream.body) throw new Error(`AI 服務回應 ${upstream.status}：${(await upstream.text()).slice(0, 300)}`)

    // 解析 vLLM 的 SSE：data: {"choices":[{"delta":{"content":"...","reasoning":"..."}}]}
    const decoder = new TextDecoder()
    let buffer = ''
    let thinkingChars = 0
    let lastThinkingSent = 0
    let finish = ''
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const choice = json.choices?.[0]
        const delta = choice?.delta ?? {}
        const reasoning = delta.reasoning ?? delta.reasoning_content
        if (reasoning) {
          thinkingChars += reasoning.length
          // 思考內容不顯示，只回報進度（每 200 字一次）
          if (thinkingChars - lastThinkingSent >= 200) {
            lastThinkingSent = thinkingChars
            send('thinking', { chars: thinkingChars })
          }
        }
        if (delta.content) send('content', { text: delta.content })
        if (choice?.finish_reason) finish = choice.finish_reason
      }
    }
    send('done', { finish, truncated: finish === 'length' })
  } catch (err) {
    send('error', { message: abort.signal.aborted && !res.destroyed ? `AI 分析逾時（超過 ${Math.round(config.llm.timeoutMs / 1000)} 秒）` : `AI 分析失敗：${err.message}` })
  } finally {
    clearTimeout(timer)
    if (!res.writableEnded) res.end()
  }
}
