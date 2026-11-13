/**
 * 最小的 Excel(.xlsx)讀寫(IP 對照表的範本、匯出與匯入;IMPL-PLAN AC3 AQ1):只處理第一個工作表的文字格,不需新增套件。
 *   寫:ZIP(不壓縮)+ inlineStr 文字格(不會被當成公式);可加下拉清單(資料驗證)
 *   讀:ZIP(stored / deflate)→ sharedStrings + 第一個工作表;解壓縮總量有上限(防 zip bomb)
 * 讀不懂的檔案丟 XlsxError(呼叫端轉成 400),不回傳內部細節。
 */
import zlib from 'node:zlib';

export class XlsxError extends Error {}

/* ───────── 寫 ───────── */

const xmlEsc = (s: string) =>
  s
    // XML 1.0 不允許的控制字元
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

export interface SheetOptions {
  /** 工作表名稱 */
  name?: string;
  /** 欄寬(字元數) */
  widths?: number[];
  /** 下拉清單:欄位索引 → 選項(套用到第 2 列到第 maxRow 列) */
  lists?: { col: number; options: readonly string[]; maxRow?: number }[];
}

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 檔名
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // 時間(0 = 1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** 文字表格 → .xlsx(第一列粗體當欄名) */
export function writeXlsx(rows: string[][], opts: SheetOptions = {}): Buffer {
  const sheetName = xmlEsc((opts.name ?? 'Sheet1').slice(0, 31));
  const cols = opts.widths?.length ? `<cols>${opts.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const body = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(String(v ?? ''))}</t></is></c>`).join('')}</row>`)
    .join('');
  const lists = opts.lists?.length
    ? `<dataValidations count="${opts.lists.length}">${opts.lists
        .map((l) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${colName(l.col)}2:${colName(l.col)}${l.maxRow ?? 5000}"><formula1>"${xmlEsc(l.options.join(','))}"</formula1></dataValidation>`)
        .join('')}</dataValidations>`
    : '';
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      'xl/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    ],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}">${cols}<sheetData>${body}</sheetData>${lists}</worksheet>`],
  ];
  return zip(files.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })));
}

/* ───────── 讀 ───────── */

/** 解壓縮後的總量上限(防 zip bomb) */
const MAX_INFLATED = 30 * 1024 * 1024;

function unzip(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  // End of central directory(檔尾,可能有最長 65535 位元組的註解)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('不是 Excel(.xlsx)檔');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Excel 檔損壞');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!wanted(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('Excel 檔損壞');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new XlsxError('Excel 檔損壞');
    const raw = buf.subarray(start, start + csize);
    total += usize;
    if (total > MAX_INFLATED) throw new XlsxError('Excel 檔內容太大');
    let data: Buffer;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_INFLATED });
      else throw new XlsxError('不支援的 Excel 壓縮格式');
    } catch (err) {
      if (err instanceof XlsxError) throw err;
      throw new XlsxError('Excel 檔損壞或內容太大');
    }
    out.set(name, data);
  }
  return out;
}

const xmlUnesc = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });

/** <si> / <is> 內所有 <t> 的文字(含 rich text 的多段 <r>,不含注音 <rPh>) */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlUnesc(m[1]!)).join('');

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** .xlsx 第一個工作表 → 文字表格(最多 maxRows 列、每列前 maxCols 欄) */
export function readXlsx(buf: Buffer, maxRows = 50_000, maxCols = 20): string[][] {
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  // 第一個工作表:workbook.xml 的第一個 <sheet> → rels 的 Target;找不到時用 sheet1.xml
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  const rid = wb && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (rid && rels) {
    // 屬性順序不固定:逐一取出 <Relationship> 再比對 Id
    const target = [...rels.matchAll(/<Relationship\b([^>]*)>/g)].map((m) => m[1]!).find((a) => /\bId="([^"]+)"/.exec(a)?.[1] === rid)?.match(/\bTarget="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = files.get(sheetPath) ?? [...files.entries()].find(([n]) => n.startsWith('xl/worksheets/'))?.[1];
  if (!sheet) throw new XlsxError('Excel 檔沒有工作表');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const rows: string[][] = [];
  for (const rm of sheet.toString('utf8').matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    if (rows.length >= maxRows) throw new XlsxError(`Excel 列數超過 ${maxRows} 列`);
    const attrs = rm[1] ?? rm[3] ?? '';
    const rIdx = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1) - 1;
    while (rows.length < rIdx) rows.push([]);
    const cells: string[] = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1]!;
      const ref = /\br="([A-Z]+)\d+"/.exec(a)?.[1];
      const ci = ref ? colIndex(ref) : cells.length;
      if (ci >= maxCols) continue;
      const t = /\bt="(\w+)"/.exec(a)?.[1];
      const inner = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let text = '';
      if (t === 's') text = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') text = textOf(inner);
      else if (v !== undefined) text = xmlUnesc(v);
      while (cells.length < ci) cells.push('');
      cells[ci] = text;
    }
    rows.push(cells);
  }
  return rows;
}

/* ───────── CSV ───────── */

/** CSV 文字 → 表格(RFC 4180:雙引號、欄內換行;BOM 去掉;最多 maxRows 列) */
export function parseCsv(text: string, maxRows = 50_000): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      if (rows.length > maxRows) throw new XlsxError(`CSV 列數超過 ${maxRows} 列`);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
