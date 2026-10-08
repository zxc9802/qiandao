import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../server/app.ts';
import { openDatabase } from '../server/db.ts';

export async function concurrencyFixture() {
  if (process.env.CLOUDBASE_ENV_ID || process.env.CLOUDBASE_API_KEY || process.env.DB_MIGRATE_ON_START === '0') throw new Error('请清除 CloudBase 配置并启用测试库建表后再运行隔离测试。');
  const dir = mkdtempSync(path.join(tmpdir(), 'meetin-concurrency-'));
  const schema = 'test_' + randomBytes(8).toString('hex');
  const source = process.env.TEST_DATABASE_URL;
  const admin = source ? new Pool({ connectionString: source, max: 1 }) : undefined;
  let connection = '';
  if (admin) {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(source!); url.searchParams.set('options', `-c search_path=${schema}`); connection = url.toString();
  }
  const dbs = await Promise.all([openDatabase(dir, connection), openDatabase(dir, connection)]);
  const queryCounts = [0, 0];
  const services = await Promise.all(dbs.map((db, i) => createApp(dir, { ...db, query: (sql, ...values) => { queryCounts[i]++; return db.query(sql, ...values); } })));
  const servers = services.map(service => service.app.listen(0, '127.0.0.1'));
  await Promise.all(servers.map(server => once(server, 'listening')));
  const bases = servers.map(server => `http://127.0.0.1:${(server.address() as { port: number }).port}/api`);
  const token = randomBytes(24).toString('hex');
  await dbs[0].query('INSERT INTO sessions VALUES (?, ?)', createHash('sha256').update(token).digest('hex'), Date.now() + 60000);
  async function request(instance: number, url: string, body?: unknown, authenticated = false, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(bases[instance] + url, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { cookie: `meet_session=${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function seed(count: number) {
    const people = [];
    for (let i = 0; i < count; i++) {
      const phone = '1390000' + String(i).padStart(4, '0');
      const row = (await dbs[0].query('INSERT INTO people (phone, fields, token, created_at) VALUES (?, ?, ?, ?) RETURNING id', phone, '{}', randomBytes(24).toString('hex'), new Date().toISOString())).rows[0];
      people.push({ id: row.id, phone });
    }
    return people;
  }
  return { dbs, queryCounts, request, seed, async close() {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await Promise.all(dbs.map(db => db.close()));
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
    rmSync(dir, { recursive: true, force: true });
  } };
}
