/**
 * 插槽名稱檢查(驗收 2026-11-10 §4.1):頁面對共用元件(src/ui 的 G* 元件、src/components)用 <template #名稱> 時,
 * 名稱必須是該元件真的有的 <slot>。用了不存在的插槽 Vue 不會報錯,內容只是不顯示(例如 GCard 沒有 #extra,
 * 即時監控的排行切換與暫停鈕因此沒有渲染)。元件的插槽名稱是動態的(例如 GTable 的 cell-欄位)時略過。
 */
import { parse as parseSfc } from 'vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

// 全部 .vue 原始碼(路徑 → 內容);用 Vite 的 glob,不需要 Node 型別
const SOURCES = import.meta.glob<string>('../src/**/*.vue', { query: '?raw', import: 'default', eager: true });
const ELEMENT = 1;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

interface Node {
  type: number;
  tag?: string;
  props?: { type: number; name: string; value?: { content: string }; arg?: { content: string; isStatic: boolean }; exp?: unknown }[];
  children?: Node[];
  loc: { start: { line: number } };
}

function templateAst(file: string): Node | null {
  const { descriptor } = parseSfc(SOURCES[file]!, { filename: file });
  return (descriptor.template?.ast as unknown as Node) ?? null;
}

const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1, -'.vue'.length);

function walk(n: Node, fn: (n: Node) => void) {
  fn(n);
  for (const c of n.children ?? []) walk(c, fn);
}

/** 元件宣告的插槽;有動態名稱(:name)時回 null(無法靜態檢查) */
function declaredSlots(file: string): Set<string> | null {
  const ast = templateAst(file);
  const slots = new Set<string>();
  let dynamic = false;
  if (ast)
    walk(ast, (n) => {
      if (n.type !== ELEMENT || n.tag !== 'slot') return;
      const name = n.props?.find((p) => p.type === ATTRIBUTE && p.name === 'name');
      if (name) slots.add(name.value?.content ?? 'default');
      else if (n.props?.some((p) => p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'name')) dynamic = true;
      else slots.add('default');
    });
  return dynamic ? null : slots;
}

const pascal = (kebab: string) => kebab.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());

// 共用元件:src/ui/components、src/ui/charts 的 G*.vue 與 src/components/*.vue
const shared = new Map<string, Set<string> | null>();
for (const f of Object.keys(SOURCES).filter((f) => /^\.\.\/src\/(ui|components)\//.test(f))) shared.set(basename(f), declaredSlots(f));

describe('共用元件的插槽名稱', () => {
  it('GCard 只有 header / actions / footer 與預設插槽(沒有 extra)', () => {
    expect([...(shared.get('GCard') ?? [])].sort()).toEqual(['actions', 'default', 'footer', 'header']);
  });

  it('所有頁面與元件只使用元件真的有的插槽', () => {
    const wrong: string[] = [];
    for (const file of Object.keys(SOURCES)) {
      const ast = templateAst(file);
      if (!ast) continue;
      walk(ast, (n) => {
        if (n.type !== ELEMENT || !n.tag) return;
        const slots = shared.get(pascal(n.tag));
        if (!slots) return;
        for (const child of n.children ?? []) {
          if (child.type !== ELEMENT || child.tag !== 'template') continue;
          const slot = child.props?.find((p) => p.type === DIRECTIVE && p.name === 'slot');
          if (!slot) continue;
          const name = slot.arg ? (slot.arg.isStatic ? slot.arg.content : null) : 'default';
          if (name && !slots.has(name)) wrong.push(`${file.slice('../src/'.length)}:${child.loc.start.line} <${n.tag}> #${name}(可用:${[...slots].join('、')})`);
        }
      });
    }
    expect(wrong).toEqual([]);
  });
});
