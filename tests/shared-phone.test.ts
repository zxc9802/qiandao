import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { parseImport, normalizePhone, validPhone } from '../server/importer.ts';
import { openDatabase, schema } from '../server/db.ts';
import { createTestApp } from './database-helper.ts';

const phone = '01088886666';
const names = Array.from({ length: 10 }, (_, i) => `来宾${i + 1}`);
const csv = (people = names, number = phone) => Buffer.from('联系电话,姓名,公司\n' + people.map(name => `${number},${name},测试公司`).join('\n'));

test('Shared phone imports keep each named attendee and only deduplicate the same person', async () => {
  const result = await parseImport(csv([...names, names[0]]), '公司名单.csv');
  assert.equal(result.records.length, 10);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /来宾1/);
  assert.equal(normalizePhone('+86 (010) 8888-6666'), phone);
  for (const number of ['13800138000', phone, '075588886666', '0218888666']) assert.ok(validPhone(number), number);
  for (const number of ['invalid', '12345', '10000000000', '010123']) assert.equal(validPhone(number), false, number);
  await assert.rejects(parseImport(Buffer.from(`电话,姓名\n${phone},甲\n${phone},`), 'missing-name.csv'), /姓名/);
  await assert.rejects(parseImport(Buffer.from(`电话,公司\n${phone},甲公司\n${phone},乙公司`), 'no-names.csv'), /姓名/);
  await assert.rejects(parseImport(csv(['张'.repeat(101)]), 'long-name.csv'), /100/);
});

for (const phone of ['13800138000', '01088886666']) test(`Ten people share ${phone}: select, claim individual codes, check in independently and reimport`, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meetin-shared-'));
  let service = await createTestApp(dir);
  let server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  let base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '';
  async function request(url: string, body?: unknown, authenticated = true) {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(authenticated ? { cookie } : {}) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function preview(buffer: Buffer) { const form = new FormData(); form.append('file', new Blob([new Uint8Array(buffer)]), 'company.csv'); return request('/admin/import/preview', form); }
  try {
    const setup = await request('/auth/setup', { password: 'shared-phone-test' }); cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const draft = await preview(csv(names, phone)); assert.equal(draft.data.added, 10);
    assert.equal((await request('/admin/import/confirm', { id: draft.data.id })).data.added, 10);
    assert.equal((await request('/admin/lookup', { phone }, false)).status, 401);
    const people = (await request('/admin/lookup', { phone: '+86 ' + phone })).data.people;
    assert.equal(people.length, 10); assert.ok(people.every((p: any) => p.token === undefined && p.checked_at === null));
    assert.equal((await request('/admin/people?q=' + phone)).data.total, 10);
    // Every attendee may first submit the shared phone without a name.
    const choices = await Promise.all(names.map(() => request('/public/ticket', { phone }, false)));
    assert.ok(choices.every(result => result.status === 200 && result.data.needsName === true));
    assert.ok(choices.every(result => result.data.code === undefined && !JSON.stringify(result.data).includes(names[0])));
    const wrong = await request('/public/ticket', { phone, name: '未报名的人' }, false); assert.equal(wrong.status, 404); assert.equal(wrong.data.code, undefined);
    const tickets = await Promise.all(names.map(name => request('/public/ticket', { phone, name }, false)));
    assert.ok(tickets.every(result => result.status === 200), JSON.stringify(tickets));
    assert.equal(new Set(tickets.map(result => result.data.code)).size, 10);
    const repeated = await Promise.all(Array.from({ length: 5 }, () => request('/public/ticket', { phone, name: names[1] }, false)));
    assert.equal(repeated.filter(result => result.status === 200).length, 4);
    assert.equal(repeated.filter(result => result.status === 429).length, 1);
    assert.equal((await request('/public/ticket', { phone, name: names[2] }, false)).status, 200);
    assert.equal((await preview(Buffer.from(`电话,公司\n${phone},测试公司`))).status, 400);
    const person = (await request('/admin/lookup', { code: tickets[0].data.code })).data;
    assert.equal(person.fields.姓名, names[0]);
    const checked = await request('/admin/checkin', { id: person.id }); assert.equal(checked.data.alreadyChecked, false);
    const again = await request('/admin/checkin', { id: person.id }); assert.equal(again.data.alreadyChecked, true); assert.equal(again.data.person.checked_at, checked.data.person.checked_at);
    const after = (await request('/admin/lookup', { phone })).data.people;
    assert.equal(after.filter((p: any) => p.checked_at).length, 1);
    assert.deepEqual((await request('/admin/dashboard')).data.stats, { total: 10, checked: 1 });
    const update = await preview(Buffer.from(`电话,姓名,公司\n${phone},${names[0]},新公司\n${phone},新来宾,测试公司`));
    assert.equal(update.data.added, 1); assert.equal(update.data.updated, 1);
    assert.deepEqual((await request('/admin/import/confirm', { id: update.data.id })).data, { added: 1, updated: 1 });
    const stable = (await request('/admin/lookup', { code: tickets[0].data.code })).data;
    assert.equal(stable.id, person.id); assert.equal(stable.fields.公司, '新公司'); assert.equal(stable.checked_at, checked.data.person.checked_at);
    const exportResponse = await fetch(base + '/admin/people/export', { headers: { cookie } });
    assert.equal((await exportResponse.text()).trim().split('\r\n').length, 12);
    await new Promise<void>(resolve => server.close(() => resolve())); await service.db.close();
    service = await createTestApp(dir); server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    assert.equal((await request('/public/ticket', { phone, name: names[0] }, false)).data.code, tickets[0].data.code);
    assert.deepEqual((await request('/admin/dashboard')).data.stats, { total: 11, checked: 1 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await service.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Legacy SQLite and PostgreSQL migrate without changing IDs, tickets or check-in timestamps', async () => {
  const legacy = 'CREATE TABLE people (id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, fields TEXT NOT NULL, token TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, checked_at TEXT)';
  const fields = JSON.stringify({ Name: ' 张晓 ', 公司: '老公司' });
  const token = 'a'.repeat(48); const timestamp = '2026-10-01T01:00:00.000Z';
  const dir = mkdtempSync(path.join(tmpdir(), 'meetin-migration-'));
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'checkin.sqlite'));
  old.exec(legacy); old.prepare('INSERT INTO people VALUES (?, ?, ?, ?, ?, ?)').run(42, phone, fields, token, timestamp, timestamp); old.close();
  let sqlite = await openDatabase(dir, '');
  const pg = new PGlite();
  try {
    const row = (await sqlite.query('SELECT * FROM people')).rows[0];
    assert.equal(row.id, 42); assert.equal(row.name, '张晓'); assert.equal(row.token, token); assert.equal(row.checked_at, timestamp);
    await sqlite.query('INSERT INTO people (phone, name, fields, token, created_at) VALUES (?, ?, ?, ?, ?)', phone, '李然', '{}', 'b'.repeat(48), timestamp);
    await sqlite.close(); sqlite = await openDatabase(dir, '');
    assert.equal((await sqlite.query('SELECT * FROM people')).rows.length, 2);
    await pg.exec(legacy);
    await pg.query('INSERT INTO people VALUES ($1, $2, $3, $4, $5, $6)', [42, phone, fields, token, timestamp, timestamp]);
    await pg.exec(schema(true)); await pg.exec(schema(true));
    const migrated = (await pg.query('SELECT * FROM people')).rows[0] as any;
    assert.equal(migrated.id, 42); assert.equal(migrated.name, '张晓'); assert.equal(migrated.token, token); assert.equal(migrated.checked_at, timestamp);
    await pg.query('INSERT INTO people (id, phone, name, fields, token, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [43, phone, '李然', '{}', 'b'.repeat(48), timestamp]);
    assert.equal((await pg.query('SELECT * FROM people')).rows.length, 2);
  } finally { await sqlite.close(); await pg.close(); rmSync(dir, { recursive: true, force: true }); }
});
