/**
 * AC3 IP 對照表:核心(正規化、範圍小的優先、名稱搜尋範圍)、Excel / CSV、API(單筆編輯、匯入預覽與確認、匯出)、
 * PA API 附 names、Log 明細名稱搜尋 = IP 搜尋、匯出名稱欄、AI 提示詞、日誌與稽核不含姓名與部門
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { trafficWhere } from '../../src/infra/clickhouse/reader.js';
import { buildIndex, collectIps, diffImport, ipsInText, parseIp, rowsToInputs, TEMPLATE_SAMPLES, COLUMNS, type IpNameEntry } from '../../src/modules/ip-names/core.js';
import { aiNamesSection } from '../../src/modules/ip-names/service.js';
import { parseCsv, readXlsx, writeXlsx, XlsxError } from '../../src/shared/xlsx.js';
import { createFakeReader, trafficRecord, type FakeReader } from '../fixtures/fake-ch.js';
import { createFakeFtp } from '../fixtures/fake-ftp.js';
import { createTestApp, waitFor, type TestApp } from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = (ip: string, name: string, department = '', extra: Partial<IpNameEntry> = {}): IpNameEntry => ({
  id: ip,
  ip,
  name,
  department,
  device: '',
  deviceType: '',
  note: '',
  updatedAt: '',
  updatedBy: '',
  ...extra,
});

describe('核心', () => {
  it('parseIp:正規化網段、/32 寫成單一 IP、不合法回 null', () => {
    assert.equal(parseIp('10.1.2.3/24')?.key, '10.1.2.0/24');
    assert.equal(parseIp(' 10.1.2.3／32 ')?.key, '10.1.2.3');
    assert.equal(parseIp('0.0.0.0/0')?.key, '0.0.0.0/0');
    for (const bad of ['10.1.2', '10.1.2.256', '10.1.2.3/33', '010.1.1.1', '::1', '10.1.2.3/24/1', 'abc']) assert.equal(parseIp(bad), null, bad);
  });

  it('lookup:網段重疊時範圍最小的優先', () => {
    const idx = buildIndex([entry('10.0.0.0/8', '全公司'), entry('10.1.0.0/16', '新竹廠'), entry('10.1.2.3', '王小明')]);
    assert.equal(idx.lookup('10.1.2.3')?.name, '王小明');
    assert.equal(idx.lookup('10.1.9.9')?.name, '新竹廠');
    assert.equal(idx.lookup('10.9.9.9')?.name, '全公司');
    assert.equal(idx.lookup('192.168.1.1'), undefined);
    assert.deepEqual(Object.keys(idx.labels(['10.1.2.3', '8.8.8.8', 'x'])), ['10.1.2.3']);
  });

  it('match:扣掉裡面名稱不符合的更小範圍,更裡面又符合的加回來', () => {
    const idx = buildIndex([entry('10.1.0.0/24', '', '資訊處'), entry('10.1.0.0/28', '', '業務部'), entry('10.1.0.5', '張三', '資訊處'), entry('10.1.0.200', '李四', '業務部')]);
    assert.deepEqual(idx.match('資訊處'), {
      ranges: [
        ['10.1.0.5', '10.1.0.5'],
        ['10.1.0.16', '10.1.0.199'],
        ['10.1.0.201', '10.1.0.255'],
      ],
      entries: 2,
    });
    assert.deepEqual(idx.match('沒有這個人'), { ranges: [], entries: 0 });
    assert.deepEqual(idx.match('  '), { ranges: [], entries: 0 });
  });

  it('rowsToInputs:檢查欄名列、略過範例列與空白列、同 IP 以最後一列為準、錯誤不含姓名', () => {
    const r = rowsToInputs([
      [...COLUMNS],
      ...TEMPLATE_SAMPLES,
      ['10.1.1.5', '王小明', '資訊處', 'NB-1', '筆電', ''],
      ['', '', '', '', '', ''],
      ['10.1.1.999', '機密姓名', '機密部門', '', '', ''],
      ['10.1.1.6', '陳小華', '', '', '平板', ''],
      ['10.1.1.5', '王小明', '資訊處', 'NB-2', '筆電', "'=SUM(A1)"],
    ]);
    assert.equal(r.skipped, 2);
    assert.equal(r.inputs.length, 1);
    assert.equal(r.inputs[0]!.device, 'NB-2');
    assert.equal(r.inputs[0]!.note, '=SUM(A1)');
    assert.deepEqual(r.errors.map((e) => e.row), [6, 7, 8]);
    assert.ok(!JSON.stringify(r.errors).includes('機密'), '錯誤訊息不可含姓名與部門');
    assert.equal(rowsToInputs([['IP', '姓名']]).errors[0]!.row, 1);
  });

  it('diffImport:檔案沒有的視為刪除,內容相同保留原紀錄', () => {
    const cur = [entry('10.1.1.1', 'A'), entry('10.1.1.2', 'B'), entry('10.1.1.3', 'C')];
    const { diff, next } = diffImport(cur, [{ ...entry('10.1.1.1', 'A') }, { ...entry('10.1.1.2', 'B2') }, { ...entry('10.1.1.4', 'D') }], { at: 't', by: 'x', newId: () => 'new' });
    assert.equal(diff.unchanged, 1);
    assert.deepEqual(diff.changed.map((c) => c.after.name), ['B2']);
    assert.deepEqual(diff.added.map((e) => e.ip), ['10.1.1.4']);
    assert.deepEqual(diff.removed.map((e) => e.ip), ['10.1.1.3']);
    assert.equal(next.length, 3);
    assert.equal(next[0], cur[0]);
  });

  it('collectIps / ipsInText:只收整個值是 IPv4 的字串;文字中的 IP 不含版本號', () => {
    assert.deepEqual([...collectIps({ a: '10.1.1.1', b: ['8.8.8.8', 'x 1.1.1.1'], c: { d: 3, e: '10.1.1.1' } })], ['10.1.1.1', '8.8.8.8']);
    assert.deepEqual(ipsInText('來源 10.1.1.1、目的 8.8.8.8。版本 1.2.3.4.5 不算,結尾 10.2.2.2.'), ['10.1.1.1', '8.8.8.8', '10.2.2.2']);
  });

  it('aiNamesSection:附上姓名、部門、設備(AQ2 不遮罩);沒有對照時不附', () => {
    const idx = buildIndex([entry('10.1.1.5', '王小明', '資訊處', { device: 'NB-1', deviceType: '筆電' })]);
    const svc = { labels: idx.labels, size: () => idx.size };
    const s = aiNamesSection(svc, 'Top 來源 10.1.1.5 與 8.8.8.8');
    assert.match(s, /10\.1\.1\.5:王小明,部門 資訊處;設備 NB-1,筆電/);
    assert.ok(!s.includes('8.8.8.8'));
    assert.equal(aiNamesSection(svc, '只有 8.8.8.8'), '');
  });

  it('trafficWhere:名稱範圍比對來源、目的與 NAT,值放參數;空範圍查不到', () => {
    const w = trafficWhere({ fromMs: 0, toMs: 1000, ipRanges: [['10.1.0.0', '10.1.0.255']] });
    const sql = w.where.join(' AND ');
    assert.match(sql, /arrayExists\(\(a, b\) -> src BETWEEN a AND b/);
    assert.match(sql, /nat_dst != toIPv6\('::'\)/);
    assert.ok(!sql.includes('10.1.0.0'), 'IP 不可直接寫進 SQL');
    assert.ok(Object.values(w.params).includes("['10.1.0.0']"));
    assert.ok(trafficWhere({ fromMs: 0, toMs: 1000, ipRanges: [] }).where.includes('0'));
  });
});

/** 模擬 Excel 存的檔:deflate 壓縮、sharedStrings(含 rich text 與注音)、工作表檔名不是 sheet1、rels 屬性順序不同 */
function excelLike(): Buffer {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const strings = [...COLUMNS, '10.20.1.5', '<r><t>林</t></r><r><rPr><b/></rPr><t>小美</t></r><rPh><t>リン</t></rPh>', '品保部', 'QA-PC-07', '桌機'];
  const ss = strings.map((x) => (x.startsWith('<') ? `<si>${x}</si>` : `<si><t>${x}</t></si>`)).join('');
  const c = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const row1 = COLUMNS.map((_, k) => c(`${String.fromCharCode(65 + k)}1`, k)).join('');
  const row2 = `${c('A3', 6)}${c('B3', 7)}${c('C3', 8)}${c('D3', 9)}${c('E3', 10)}<c r="F3"><v>12</v></c>`;
  const files: [string, string][] = [
    ['xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="資料" sheetId="1" r:id="rId3"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships><Relationship Target="styles.xml" Id="rId1" Type="t"/><Relationship Target="worksheets/data.xml" Type="${rel}/worksheet" Id="rId3"/></Relationships>`],
    ['xl/sharedStrings.xml', `<sst xmlns="${ns}">${ss}</sst>`],
    ['xl/worksheets/data.xml', `<worksheet xmlns="${ns}"><sheetData><row r="1">${row1}</row><row r="2"/><row r="3">${row2}</row></sheetData></worksheet>`],
  ];
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(zlib.crc32(data), 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    parts.push(h, n, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(zlib.crc32(data), 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(off, 42);
    central.push(cd, n);
    off += 30 + n.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

describe('Excel / CSV', () => {
  it('writeXlsx → readXlsx 來回一致(含特殊字元、跳欄)', () => {
    const rows = [[...COLUMNS], ['10.1.1.5', '王<小>明 & "A"', '', 'NB', '筆電', '=1+1']];
    const back = readXlsx(writeXlsx(rows, { lists: [{ col: 4, options: ['筆電', '桌機'] }] }));
    assert.deepEqual(back, rows);
  });

  it('readXlsx 讀 deflate 壓縮、sharedStrings 的檔(Excel 存檔格式)', () => {
    const rows = readXlsx(excelLike());
    assert.deepEqual(rows[0], [...COLUMNS]);
    assert.deepEqual(rows[1], [], '空白列(<row/>)不可吃掉下一列');
    assert.equal(rows[2]![0], '10.20.1.5');
    assert.equal(rows[2]![1], '林小美');
  });

  it('不是 xlsx 丟 XlsxError;CSV 支援引號、欄內換行與 BOM', () => {
    assert.throws(() => readXlsx(Buffer.from('hello')), XlsxError);
    assert.deepEqual(parseCsv('﻿a,"b,1","c ""q"""\r\n"x\ny",2\n'), [
      ['a', 'b,1', 'c "q"'],
      ['x\ny', '2'],
    ]);
  });
});

describe('API', () => {
  let t: TestApp;
  let reader: FakeReader;
  const logs: string[] = [];
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
  const csvOf = (rows: string[][]) => [COLUMNS.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const PERSONAL = ['王小明', '資訊處', '陳業務', '業務部'];

  before(async () => {
    reader = createFakeReader(Array.from({ length: 30 }, (_, i) => trafficRecord(`2026/11/11 00:${String(i).padStart(2, '0')}:00`, i)));
    t = await createTestApp({
      ftp: createFakeFtp(),
      chReader: reader,
      chNow: () => Date.parse('2026-11-11T03:10:00+08:00'),
      env: { NETOPS_CH_SUMMARY_MINUTES: '0', PA_SEARCH_LIMIT: '50', LOG_LEVEL: 'trace' },
      logStream: { write: (m: string) => void logs.push(m) },
    });
  });
  after(async () => t.close());

  it('OpenAPI:對照表 API 權限 netops.ip-name.read / write、稽核 meta(不記內容);PA API 附名稱沿用原權限', async () => {
    const doc = (await t.app.inject('/openapi.json')).json();
    const ops = Object.entries(doc.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap(([p, m]) => Object.entries(m).map(([verb, op]) => ({ p, verb, op })));
    const mine = ops.filter((o) => o.p.startsWith('/v1/ip-name'));
    assert.equal(mine.length, 9);
    for (const { p, verb, op } of mine) {
      assert.equal(op['x-permission'], verb === 'get' || p === '/v1/ip-name-searches' ? 'netops.ip-name.read' : 'netops.ip-name.write', `${verb} ${p}`);
      assert.notEqual(op['x-audit-level'], 'body', `${verb} ${p} 不可記錄內容`);
    }
    assert.equal(doc.paths['/v1/pa/log-searches/{id}/rows'].get['x-permission'], 'netops.pa-log.read');
  });

  let id = '';
  it('單筆新增 / 修改 / 刪除;重複 IP 409、不合法 400、不存在 404', async () => {
    const res = await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.1.3', name: '王小明', department: '資訊處', device: 'NB-01', deviceType: '筆電' } });
    assert.equal(res.statusCode, 201, res.body);
    id = res.json().id;
    assert.equal(res.json().updatedBy, 'S112009 測試S112009');
    assert.equal((await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.1.3/32', name: 'x' } })).json().code, 'NETOPS_IP_NAME_DUPLICATE');
    assert.equal((await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.1', name: 'x' } })).statusCode, 400);
    assert.equal((await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.2.1' } })).statusCode, 400);
    assert.equal((await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.2.1', name: 'x', deviceType: '平板' } })).statusCode, 400);
    const net = await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.1.77/24', department: '業務部', device: '業務網段' } });
    assert.equal(net.json().ip, '10.10.1.0/24');
    const upd = await t.call({ method: 'PUT', url: `/v1/ip-names/${net.json().id}`, payload: { ip: '10.10.1.0/24', name: '陳業務', department: '業務部' } });
    assert.equal(upd.statusCode, 200);
    assert.equal(upd.json().device, '');
    assert.equal((await t.call({ method: 'PUT', url: `/v1/ip-names/${net.json().id}`, payload: { ip: '10.10.1.3', name: 'x' } })).statusCode, 409);
    assert.equal((await t.call({ method: 'PUT', url: '/v1/ip-names/6f1c9e4e-2a5b-4c1f-9d7e-1a2b3c4d5e6f', payload: { ip: '10.10.9.9', name: 'x' } })).statusCode, 404);
    const tmp = await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.9.9', name: '暫時' } });
    assert.equal((await t.call({ method: 'DELETE', url: `/v1/ip-names/${tmp.json().id}` })).statusCode, 204);
    assert.equal((await t.call({ method: 'DELETE', url: `/v1/ip-names/${tmp.json().id}` })).statusCode, 204);
    const list = (await t.call({ method: 'POST', url: '/v1/ip-name-searches', payload: { q: '業務' } })).json();
    assert.deepEqual(list.items.map((e: IpNameEntry) => e.ip), ['10.10.1.0/24']);
    assert.equal((await t.call({ url: '/v1/ip-names' })).json().total, 2);
  });

  it('PA API 附 names(只含本回應出現的 IP,範圍小的優先);名稱搜尋 = IP 搜尋;匯出多名稱欄', async () => {
    const submit = async (body: object) => {
      const r = await t.call({ method: 'POST', url: '/v1/pa/log-searches', payload: { from: '2026-11-11T00:00:00+08:00', to: '2026-11-11T00:59:00+08:00', ...body } });
      assert.equal(r.statusCode, 202, r.body);
      const jid = r.json().id;
      await waitFor(async () => !['queued', 'running'].includes((await t.call({ url: `/v1/pa/log-searches/${jid}` })).json().status));
      return jid as string;
    };
    const byName = await submit({ name: '王小明' });
    const byIp = await submit({ ip: '10.10.1.3' });
    const rowsName = (await t.call({ url: `/v1/pa/log-searches/${byName}/rows?pageSize=100` })).json();
    const rowsIp = (await t.call({ url: `/v1/pa/log-searches/${byIp}/rows?pageSize=100` })).json();
    assert.ok(rowsIp.total > 0);
    assert.deepEqual(rowsName.items, rowsIp.items);
    assert.deepEqual(rowsName.names['10.10.1.3'], { name: '王小明', department: '資訊處', device: 'NB-01', deviceType: '筆電' });
    assert.deepEqual(Object.keys(rowsName.names), ['10.10.1.3'], '只含本回應出現的 IP(8.8.8.x 沒有對照)');
    // 網段:扣掉 10.10.1.3(範圍小的優先)
    const byDept = await submit({ name: '業務部' });
    const rowsDept = (await t.call({ url: `/v1/pa/log-searches/${byDept}/rows?pageSize=100` })).json();
    assert.equal(rowsDept.total, 30 - rowsIp.total);
    assert.ok(rowsDept.items.every((r: { src: string }) => r.src !== '10.10.1.3'));
    assert.equal(rowsDept.names['10.10.1.1'].name, '陳業務');
    // 對照表沒有符合的名稱
    const none = await t.call({ method: 'POST', url: '/v1/pa/log-searches', payload: { from: '2026-11-11T00:00:00+08:00', to: '2026-11-11T00:59:00+08:00', name: '沒有這個人' } });
    assert.equal(none.statusCode, 400);
    const csv = (await t.call({ url: `/v1/pa/log-searches/${byName}/export` })).body;
    const [head, first] = csv.replace(/^﻿/, '').split('\r\n');
    assert.ok(head!.endsWith(',來源名稱,目的名稱'));
    assert.ok(first!.endsWith(',王小明 / 資訊處,'));
  });

  it('匯入:預覽不寫入、確認後整份取代;別人不能確認;預覽後被改過 409;欄名不符 400', async () => {
    const file = csvOf([['10.10.1.3', '王小明', '資訊處', 'NB-02', '筆電', ''], ['10.10.2.0/24', '', '研發部', '研發網段', '網路設備', ''], ['bad', 'x', '', '', '', '']]);
    const pre = await t.call({ method: 'POST', url: '/v1/ip-name-imports', payload: { fileName: 'a.csv', format: 'csv', data: b64(file) } });
    assert.equal(pre.statusCode, 200, pre.body);
    const p = pre.json();
    assert.deepEqual(p.counts, { added: 1, changed: 1, removed: 1, unchanged: 0 });
    assert.equal(p.errors.length, 1);
    assert.equal((await t.call({ url: '/v1/ip-names' })).json().total, 2, '預覽不寫入');
    assert.equal((await t.call({ method: 'POST', url: `/v1/ip-name-imports/${p.id}/confirm`, emp: 'S999999' })).statusCode, 404);
    const ok = await t.call({ method: 'POST', url: `/v1/ip-name-imports/${p.id}/confirm` });
    assert.deepEqual(ok.json(), { added: 1, changed: 1, removed: 1, unchanged: 0, total: 2 });
    assert.deepEqual((await t.call({ url: '/v1/ip-names' })).json().items.map((e: IpNameEntry) => e.ip), ['10.10.1.3', '10.10.2.0/24']);
    assert.equal((await t.call({ method: 'POST', url: `/v1/ip-name-imports/${p.id}/confirm` })).statusCode, 404, '確認過不能再確認');
    // Excel 匯入 + 預覽後有人改過
    const xlsx = writeXlsx([[...COLUMNS], ...TEMPLATE_SAMPLES, ['10.10.1.3', '王小明', '資訊處', 'NB-02', '筆電', '']]);
    const p2 = (await t.call({ method: 'POST', url: '/v1/ip-name-imports', payload: { fileName: 'b.xlsx', format: 'xlsx', data: b64(xlsx) } })).json();
    assert.equal(p2.skipped, 2);
    assert.deepEqual(p2.counts, { added: 0, changed: 0, removed: 1, unchanged: 1 });
    await t.call({ method: 'POST', url: '/v1/ip-names', payload: { ip: '10.10.3.3', name: '新同仁' } });
    assert.equal((await t.call({ method: 'POST', url: `/v1/ip-name-imports/${p2.id}/confirm` })).json().code, 'NETOPS_IP_NAME_IMPORT_STALE');
    const empty = await t.call({ method: 'POST', url: '/v1/ip-name-imports', payload: { fileName: 'e.csv', format: 'csv', data: b64(csvOf([...TEMPLATE_SAMPLES])) } });
    assert.equal(empty.json().code, 'NETOPS_IP_NAME_IMPORT_INVALID', '只有範例列不可整份清空');
    const bad = await t.call({ method: 'POST', url: '/v1/ip-name-imports', payload: { fileName: 'c.csv', format: 'csv', data: b64('IP,姓名\r\n10.1.1.1,x') } });
    assert.equal(bad.json().code, 'NETOPS_IP_NAME_IMPORT_INVALID');
    assert.equal((await t.call({ method: 'POST', url: '/v1/ip-name-imports', payload: { fileName: 'c.xlsx', format: 'xlsx', data: b64('not a zip') } })).json().code, 'NETOPS_IP_NAME_IMPORT_INVALID');
    const p3 = (await t.call({ method: 'POST', url: '/v1/ip-name-imports', payload: { fileName: 'a.csv', format: 'csv', data: b64(file) } })).json();
    assert.equal((await t.call({ method: 'DELETE', url: `/v1/ip-name-imports/${p3.id}` })).statusCode, 204);
    assert.equal((await t.call({ method: 'POST', url: `/v1/ip-name-imports/${p3.id}/confirm` })).statusCode, 404);
  });

  it('匯出與範本(Excel / CSV;欄位同範本,可直接再匯入)', async () => {
    const x = await t.call({ url: '/v1/ip-names?format=xlsx' });
    assert.equal(x.statusCode, 200);
    assert.match(String(x.headers['content-type']), /spreadsheetml/);
    const rows = readXlsx(x.rawPayload);
    assert.deepEqual(rows[0], [...COLUMNS]);
    assert.equal(rows.length, 4);
    const c = await t.call({ url: '/v1/ip-names?format=csv' });
    assert.match(String(c.headers['content-type']), /text\/csv/);
    assert.equal(rowsToInputs(parseCsv(c.body)).inputs.length, 3);
    const tpl = readXlsx((await t.call({ url: '/v1/ip-name-template' })).rawPayload);
    assert.deepEqual(tpl, [[...COLUMNS], ...TEMPLATE_SAMPLES]);
    assert.deepEqual(rowsToInputs(tpl).inputs, [], '範本的範例列匯入時略過');
    assert.ok(readXlsx((await t.call({ url: '/v1/ip-name-template' })).rawPayload));
    assert.match((await t.call({ url: '/v1/ip-name-template?format=csv' })).body, /^﻿IP或網段,使用者姓名/);
  });

  it('服務日誌不含姓名與部門', () => {
    const text = logs.join('');
    assert.ok(text.length > 0, '有日誌');
    for (const s of PERSONAL) assert.ok(!text.includes(s), `日誌含個資:${s}`);
  });
});

describe('gateway-rbac.yaml', () => {
  it('IP 對照表選單與按鈕只給 netops-admin;viewer 沒有(呼叫對照表 API 由 BFF 回 403),但有 PA 畫面', () => {
    const yaml = fs.readFileSync(path.join(here, '../../../deploy/gateway-rbac.yaml'), 'utf8');
    const role = (code: string) => yaml.slice(yaml.indexOf(`- code: ${code}`)).split(/\n  - code: /)[0]!;
    assert.match(yaml, /code: netops\.ip-name-page\.read,.*kind: menu, parent: netops\.group\.knowledge.*includes: \[netops\.ip-name\.read\]/);
    assert.match(yaml, /code: netops\.ip-name-page\.write,.*kind: button.*includes: \[netops\.ip-name\.write\]/);
    assert.match(role('netops-admin'), /- netops\.ip-name-page\.read\n\s+- netops\.ip-name-page\.write/);
    assert.ok(!role('netops-viewer').includes('ip-name'));
    assert.match(role('netops-viewer'), /- netops\.pa-search\.read/);
  });
});
