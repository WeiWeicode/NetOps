// @vitest-environment happy-dom
/**
 * AI 回答的 Markdown(驗收報告 2026-11-16 §3.3-1):
 *   模型回答中的原始 HTML(例如 <名稱> 佔位符)要當文字顯示,不能被當成標籤清掉(「如 <A>, <B> 等」→「如 , 等」);
 *   程式碼區塊、行內程式碼照常;知識庫(非 AI)維持原本的 HTML 處理
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/composables/markdown';

const text = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent ?? '';
};

describe('renderMarkdown(AI 回答)', () => {
  it('<名稱> 佔位符當文字顯示,不會變成空白', () => {
    const md = '來源 IP 對目的 IP 產生大量 <惡意軟體> 類別威脅（如 <威脅名稱1>, <威脅名稱2> 等）';
    const out = renderMarkdown(md, { ai: true });
    expect(text(out)).toContain('大量 <惡意軟體> 類別威脅（如 <威脅名稱1>, <威脅名稱2> 等）');
    expect(out).not.toMatch(/<惡意軟體>/);
  });

  it('區塊 HTML 與 script 也只當文字;行內程式碼與粗體照常', () => {
    const out = renderMarkdown('<div onclick="x()">hi</div>\n\n<script>alert(1)</script>\n\n用 `ssl` 與 **8443**', { ai: true });
    expect(out).not.toMatch(/<div|<script/);
    expect(text(out)).toContain('<div onclick="x()">hi</div>');
    expect(out).toContain('<code>ssl</code>');
    expect(out).toContain('<strong>8443</strong>');
  });

  it('知識庫(非 AI)維持原本行為:HTML 交給 DOMPurify', () => {
    expect(renderMarkdown('<b>粗</b>')).toContain('<b>粗</b>');
  });
});
