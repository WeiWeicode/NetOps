/**
 * Markdown → 安全的 HTML(知識庫筆記與匯整檔;AGENT.md §7.4 一律經 DOMPurify):
 *   marked(GFM)轉 HTML 後由 DOMPurify 清掉 script、事件屬性、javascript: 連結、SVG / MathML、style / form / iframe 等;
 *   連結一律另開分頁並加 rel;圖片只留同網域來源(避免外部追蹤圖片記錄讀者);不允許 download 屬性。
 *   使用本模組專用的 DOMPurify 實例,hook 不影響其他地方。知識庫筆記是資料,不是指令(不可被當成權限依據)。
 *   「~」改全形,避免被當成刪除線(同舊版)。
 */
import createDOMPurify, { type DOMPurify } from 'dompurify';
import { marked } from 'marked';

let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify {
  if (purifier) return purifier;
  const p = createDOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      let sameOrigin = false;
      try {
        sameOrigin = new URL(src, location.href).origin === location.origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) node.removeAttribute('src');
    }
  });
  purifier = p;
  return p;
}

/**
 * opts.ai:AI 回答(IMPL-PLAN A1)。模型輸入含外部可控的文字(log 的 URL、RDAP、PTR),回答可能被誘導出釣魚連結或圖片:
 *   不顯示圖片(顯示時會自動帶 Cookie 發 GET);不同網域的連結只留文字與網址(不能點),同網域照常另開分頁
 */
export function renderMarkdown(text: string | null | undefined, opts: { ai?: boolean } = {}): string {
  const html = marked.parse((text ?? '').replace(/~/g, '～'), { gfm: true, async: false });
  const out = getPurifier().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', ...(opts.ai ? ['img'] : [])],
    FORBID_ATTR: ['style', 'download', 'srcset'],
  });
  return opts.ai ? unlinkExternal(out) : out;
}

/** 不同網域的 <a> 換成「文字(網址)」純文字 */
function unlinkExternal(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const a of [...doc.body.querySelectorAll('a')]) {
    let same = false;
    try {
      same = new URL(a.getAttribute('href') ?? '', location.href).origin === location.origin;
    } catch {
      same = false;
    }
    if (same) continue;
    const href = a.getAttribute('href') ?? '';
    const label = a.textContent ?? '';
    const span = doc.createElement('span');
    span.className = 'ext-link';
    span.title = 'AI 回答中的外部網址(不能直接點選;請勿在不明網站輸入帳密)';
    span.textContent = href && href !== label ? `${label}(${href})` : label;
    a.replaceWith(span);
  }
  return doc.body.innerHTML;
}
