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
  it('ASCII 佔位符(<Category>、<threat_name>)當文字顯示,不會變成「如 , 等」', () => {
    // marked 只把 ASCII 標籤名當 HTML(中文 <名稱> 本來就會轉義);舊實作輸出原始 <Category> 交給 DOMPurify 清掉
    const md = '來源 IP 對目的 IP 產生大量 <Category> 類別威脅（如 <threat_name>, <Name2> 等）';
    const out = renderMarkdown(md, { ai: true });
    expect(text(out)).toContain('大量 <Category> 類別威脅（如 <threat_name>, <Name2> 等）');
    expect(out).not.toMatch(/<Category>|<threat_name>/);
  });

  it('屬性型 HTML、註解、<br> 只當文字;程式碼區塊與表格照常', () => {
    const md = ['<img src=x onerror=alert(1)> a<br>b <!-- c -->', '', '```', '<x> & y', '```', '', '| 欄 | 值 |', '| --- | --- |', '| <x> | 1 |'].join('\n');
    const out = renderMarkdown(md, { ai: true });
    expect(out).not.toMatch(/<img|<br|<!--/);
    expect(text(out)).toContain('<img src=x onerror=alert(1)>');
    expect(out).toContain('<pre><code>&lt;x&gt; &amp; y');
    expect(out).toContain('<table>');
    expect(text(out)).toContain('<x>');
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
