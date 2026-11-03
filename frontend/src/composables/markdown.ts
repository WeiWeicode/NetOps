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

export function renderMarkdown(text: string | null | undefined): string {
  const html = marked.parse((text ?? '').replace(/~/g, '～'), { gfm: true, async: false });
  return getPurifier().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style', 'download', 'srcset'],
  });
}
