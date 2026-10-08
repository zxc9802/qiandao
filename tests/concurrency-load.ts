import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { concurrencyFixture } from './concurrency-helper.ts';

// Always creates isolated data and local API servers; never sends traffic to production.
const attendees = 500;
const concurrency = Number(process.env.LOAD_CONCURRENCY || 50);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new Error('LOAD_CONCURRENCY 必须为 1–100。');
const f = await concurrencyFixture();
const latencies: Record<string, number[]> = {};
try {
  const people = await f.seed(attendees);
  let next = 0;
  async function request(instance: number, route: string, body?: unknown, authenticated = false) {
    const start = performance.now();
    const result = await f.request(instance, route, body, authenticated);
    (latencies[route] ||= []).push(performance.now() - start);
    assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  f.queryCounts.fill(0);
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    const instance = worker % 2;
    while (next < people.length) {
      const person = people[next++];
      await request(instance, '/public/event');
      const ticket = await request(instance, '/public/ticket', { phone: person.phone });
      const found = await request(instance, '/admin/lookup', { code: ticket.code }, true);
      const checked = await request(instance, '/admin/checkin', { id: found.id }, true);
      assert.equal(checked.alreadyChecked, false);
      if (Number(person.id) % 20 === 0) await request(instance, '/admin/dashboard', undefined, true);
    }
  }));
  const elapsedMs = performance.now() - start;
  const stored = (await f.dbs[0].query('SELECT COUNT(*) AS checked FROM people WHERE checked_at IS NOT NULL')).rows[0];
  assert.equal(Number(stored.checked), attendees);
  const endpoints = Object.fromEntries(Object.entries(latencies).map(([route, values]) => {
    values.sort((a, b) => a - b);
    return [route, { requests: values.length, p95Ms: Math.round(values[Math.ceil(values.length * .95) - 1]), maxMs: Math.round(values.at(-1)!) }];
  }));
  console.log(JSON.stringify({ environment: process.env.TEST_DATABASE_URL ? 'isolated PostgreSQL schema + two local app instances' : 'temporary SQLite + two local app instances', attendees, concurrency, checked: Number(stored.checked), errors: 0, elapsedMs: Math.round(elapsedMs), databaseQueries: f.queryCounts.reduce((a, b) => a + b), endpoints }, null, 2));
} finally { await f.close(); }
