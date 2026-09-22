import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, Table, TableRow, TableCell } from 'docx';
import PDFDocument from 'pdfkit';
import { parseImport } from '../server/importer.ts';
import { createApp } from '../server/app.ts';

const headers = ['手机号', '姓名', '公司', '身份', '备注'];
const values = ['13800138000', '张晓', '相遇科技', '嘉宾', '<script>alert(1)</script>'];
async function xlsxFixture(rows = [headers, values]) {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('嘉宾名单'); rows.forEach(row => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function docxFixture() {
  const table = new Table({ rows: [headers, values].map(row => new TableRow({ children: row.map(text => new TableCell({ children: [new Paragraph(text)] })) })) });
  return Packer.toBuffer(new Document({ sections: [{ children: [table] }] }));
}
async function pdfFixture() {
  return new Promise<Buffer>(resolve => { const chunks: Buffer[] = []; const doc = new PDFDocument(); doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); const x = [50, 190, 330]; ['phone', 'Name', 'Company'].forEach((value, index) => doc.text(value, x[index], 50)); ['13900139000', 'Li Ran', 'Future Design'].forEach((value, index) => doc.text(value, x[index], 80)); doc.end(); });
}

test('XLSX: preserve custom columns, numeric phones, report invalid and duplicate rows', async () => {
  const input = await xlsxFixture([headers, values, ['13800138000', 'Duplicate'], ['invalid', 'Bad'], ['13900139000', '李然', '未来设计']]);
  const result = await parseImport(input, '名单.xlsx');
  assert.equal(result.records.length, 2); assert.equal(result.records[0].fields.姓名, '张晓'); assert.equal(result.records[0].fields.备注, values[4]); assert.equal(result.warnings.length, 2);
  const book = new ExcelJS.Workbook(); book.addWorksheet('Sheet1').addRows([headers, [13800138000, '数字手机号']]);
  assert.equal((await parseImport(Buffer.from(await book.xlsx.writeBuffer()), 'numeric.xlsx')).records[0].phone, '13800138000');
});
test('Word: actual DOCX table keeps the phone to identity association', async () => {
  const result = await parseImport(await docxFixture(), '报名信息.docx'); assert.equal(result.records[0].phone, values[0]); assert.equal(result.records[0].fields.公司, values[2]);
});
test('XLSX: namespace-prefixed workbook and sheets retain identity and blank columns', async () => {
  const source = await xlsxFixture([headers, [values[0], values[1], '', values[3], values[4]]]);
  for (const paths of [['xl/workbook.xml'], ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']]) {
    const zip = await JSZip.loadAsync(source);
    for (const name of paths) {
      const xml = await zip.file(name)!.async('string');
      zip.file(name, xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:spread="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)([A-Za-z_]\w*)(?=[\s/>])/g, '<$1spread:$2'));
    }
    const result = await parseImport(await zip.generateAsync({ type: 'nodebuffer' }), 'namespaced.xlsx');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].phone, values[0]);
    assert.equal(result.records[0].fields.姓名, values[1]);
    assert.equal(result.records[0].fields.身份, values[3]);
    assert.equal(result.records[0].fields.公司, undefined);
    assert.equal(result.records[0].fields.备注, values[4]);
  }
});
test('XLSX: unreadable uploads return an actionable message', async () => {
  await assert.rejects(parseImport(Buffer.from('not an Excel file'), 'invalid.xlsx'), /Excel 文件无法读取/);
});
test('PDF: actual text PDF table retains column names and identity', async () => {
  const result = await parseImport(await pdfFixture(), 'list.pdf'); assert.equal(result.records[0].phone, '13900139000'); assert.equal(result.records[0].fields.Name, 'Li Ran'); assert.equal(result.records[0].fields.Company, 'Future Design');
});
test('Word narrative: retain original information and require preview', async () => {
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('手机号：13800138000'), new Paragraph('姓名：张晓'), new Paragraph('公司：相遇科技'), new Paragraph('手机号：13900139000'), new Paragraph('姓名：李然')] }] }));
  const result = await parseImport(buffer, 'info.docx'); assert.equal(result.records.length, 2); assert.equal(result.records[0].fields.姓名, '张晓'); assert.equal(result.records[0].fields.公司, '相遇科技'); assert.equal(result.records[1].fields.姓名, '李然'); assert.ok(result.warnings.length);
});
test('CSV: BOM, +86 prefix, quoted comma, headerless records and unsupported formats', async () => {
  const result = await parseImport(Buffer.from('\uFEFF手机号,姓名,备注\n+86 13800138000,张晓,"第一场,嘉宾"'), 'list.csv'); assert.equal(result.records[0].phone, '13800138000'); assert.equal(result.records[0].fields.备注, '第一场,嘉宾');
  const headerless = await parseImport(Buffer.from('13800138000,张晓\n13900139000,李然'), 'list.csv'); assert.equal(headerless.records.length, 2);
  await assert.rejects(parseImport(Buffer.from('hi'), 'file.doc'), /另存/); await assert.rejects(parseImport(Buffer.from('手机号,姓名\ninvalid,Bad'), 'list.csv'), /未找到/);
});

test('Production bootstrap: require a password before exposure and never overwrite persisted credentials', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meet-in-bootstrap-'));
  const original = { NODE_ENV: process.env.NODE_ENV, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  try {
    process.env.NODE_ENV = 'production'; delete process.env.ADMIN_PASSWORD;
    assert.throws(() => createApp(dir), /ADMIN_PASSWORD/);
    process.env.ADMIN_PASSWORD = 'short';
    assert.throws(() => createApp(dir), /8–128/);
    process.env.ADMIN_PASSWORD = 'bootstrap-test-password';
    let service = createApp(dir);
    const stored = service.db.prepare("SELECT value FROM settings WHERE key = 'password'").get()!.value;
    assert.notEqual(stored, process.env.ADMIN_PASSWORD);
    service.db.close();
    process.env.ADMIN_PASSWORD = 'different-bootstrap-password';
    service = createApp(dir);
    const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const status = await fetch(base + '/api/auth/status').then(res => res.json());
      assert.equal(status.setupRequired, false);
      const login = (password: string) => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      assert.equal((await login('bootstrap-test-password')).status, 200);
      assert.equal((await login('different-bootstrap-password')).status, 401);
      assert.equal(service.db.prepare("SELECT value FROM settings WHERE key = 'password'").get()!.value, stored);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); service.db.close(); }
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('End-to-end: auth → file preview → commit → public ticket → private lookup → idempotent checkin → persistence', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meet-in-test-')); let service = createApp(dir); let server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  let base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; let cookie = '';
  async function request(url: string, method = 'GET', body?: unknown, authenticated = true) {
    const res = await fetch(base + '/api' + url, { method, headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(authenticated && cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    return { res, data: await res.json() };
  }
  async function preview(buffer: Buffer, name: string) { const form = new FormData(); form.append('file', new Blob([new Uint8Array(buffer)]), name); return request('/admin/import/preview', 'POST', form); }
  try {
    assert.equal((await request('/admin/people', 'GET', undefined, false)).res.status, 401);
    assert.equal((await request('/auth/setup', 'POST', { password: 'short' })).res.status, 400);
    const setup = await request('/auth/setup', 'POST', { password: 'test-password-2026' }); assert.equal(setup.res.status, 200); cookie = setup.res.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/auth/setup', 'POST', { password: 'another-password' })).res.status, 409);
    const initial = await preview(await xlsxFixture(), '名单.xlsx'); assert.equal(initial.data.added, 1); assert.equal((await request('/admin/people')).data.total, 0);
    assert.equal((await request('/admin/import/confirm', 'POST', { id: initial.data.id })).data.added, 1);
    assert.equal((await request('/admin/import/confirm', 'POST', { id: initial.data.id })).res.status, 400);
    const ticket = await request('/public/ticket', 'POST', { phone: values[0] }, false); assert.equal(ticket.res.status, 200); assert.match(ticket.data.code, /^checkin:v1:[a-f0-9]{48}$/); assert.equal(ticket.data.fields, undefined); assert.ok(!JSON.stringify(ticket.data).includes(values[1])); assert.ok(!JSON.stringify(ticket.data).includes(values[0]));
    assert.equal((await request('/admin/lookup', 'POST', { code: ticket.data.code }, false)).res.status, 401);
    assert.equal((await request('/admin/lookup', 'POST', { code: 'checkin:v1:fake' })).res.status, 400);
    const lookup = await request('/admin/lookup', 'POST', { code: ticket.data.code }); assert.equal(lookup.data.fields.姓名, values[1]); assert.equal(lookup.data.token, undefined);
    const checked = await request('/admin/checkin', 'POST', { id: lookup.data.id }); assert.equal(checked.data.alreadyChecked, false); assert.ok(checked.data.person.checked_at);
    const again = await request('/admin/checkin', 'POST', { id: lookup.data.id }); assert.equal(again.data.alreadyChecked, true); assert.equal(again.data.person.checked_at, checked.data.person.checked_at);
    const update = await preview(Buffer.from('手机号,姓名,公司\n13800138000,更新姓名,新公司'), 'update.csv'); assert.equal(update.data.updated, 1); await request('/admin/import/confirm', 'POST', { id: update.data.id });
    const stable = await request('/admin/lookup', 'POST', { code: ticket.data.code }); assert.equal(stable.data.fields.姓名, '更新姓名'); assert.equal(stable.data.checked_at, checked.data.person.checked_at);
    const word = await preview(await docxFixture(), 'word.docx'); assert.equal(word.res.status, 200);
    const pdf = await preview(await pdfFixture(), 'pdf.pdf'); assert.equal(pdf.data.added, 1); await request('/admin/import/confirm', 'POST', { id: pdf.data.id });
    assert.equal((await request('/admin/people?status=checked')).data.total, 1); assert.equal((await request('/admin/people?status=pending')).data.total, 1); assert.equal((await request('/admin/people?q=13900139000')).data.total, 1); assert.equal((await request('/admin/dashboard')).data.stats.total, 2);
    assert.equal((await request('/public/ticket', 'POST', { phone: '18800009999' })).res.status, 404);
    const hostile = await fetch(base + '/api/admin/checkin', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://hostile.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: lookup.data.id }) }); assert.equal(hostile.status, 403);
    const csv = await fetch(base + '/api/admin/people/export', { headers: { Cookie: cookie } }); assert.equal(csv.status, 200); assert.match(await csv.text(), /更新姓名/);
    const event = { title: '测试活动', date: '2026-10-01', time: '14:00', location: '测试会场', description: '欢迎' }; assert.equal((await request('/admin/event', 'PUT', event)).res.status, 200);
    await new Promise<void>(resolve => server.close(() => resolve())); service.db.close();
    service = createApp(dir); server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await request('/admin/dashboard')).data.stats.checked, 1); assert.equal((await request('/public/event')).data.title, '测试活动'); assert.equal((await request('/public/ticket', 'POST', { phone: values[0] })).data.code, ticket.data.code);
    await request('/auth/logout', 'POST', {}); assert.equal((await request('/admin/people')).res.status, 401); assert.equal((await request('/auth/login', 'POST', { password: 'wrong' })).res.status, 401); assert.equal((await request('/auth/login', 'POST', { password: 'test-password-2026' })).res.status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); service.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
