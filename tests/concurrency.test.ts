import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseRateLimit } from '../server/rate-limit-store.ts';
import { DatabaseUnavailableError } from '../server/db.ts';
import { concurrencyFixture } from './concurrency-helper.ts';

test('Concurrent check-in across two instances preserves one first check-in and one timestamp', async () => {
  const f = await concurrencyFixture();
  try {
    const [person] = await f.seed(1);
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => f.request(i % 2, '/admin/checkin', { id: person.id }, true)));
    assert.ok(results.every(result => result.status === 200));
    assert.equal(results.filter(result => !result.data.alreadyChecked).length, 1);
    assert.equal(new Set(results.map(result => result.data.person.checked_at)).size, 1);
    assert.equal((await f.request(0, '/admin/dashboard', undefined, true)).data.stats.checked, 1);
  } finally { await f.close(); }
});

test('Shared Wi-Fi: 100 different attendees can claim tickets; repeated phone is limited across instances', async () => {
  const f = await concurrencyFixture();
  try {
    const people = await f.seed(100);
    const results = await Promise.all(people.map((person, i) => f.request(i % 2, '/public/ticket', { phone: person.phone })));
    assert.ok(results.every(result => result.status === 200), JSON.stringify(results.map(result => result.status)));
    const repeated = await Promise.all(Array.from({ length: 10 }, (_, i) => f.request(i % 2, '/public/ticket', { phone: '+86 ' + people[0].phone })));
    assert.equal(repeated.filter(result => result.status === 200).length, 4);
    assert.equal(repeated.filter(result => result.status === 429).length, 6);
    assert.ok(repeated.filter(result => result.status === 429).every(result => Number(result.headers.get('retry-after')) > 0));
  } finally { await f.close(); }
});

test('Expired rate-limit windows reset atomically without deleting rows on each request', async () => {
  const f = await concurrencyFixture();
  try {
    await f.dbs[0].query('INSERT INTO rate_limits VALUES (?, ?, ?)', 'test:client', 99, Date.now() - 1);
    let deletes = 0;
    const stores = f.dbs.map(db => databaseRateLimit({ ...db, query: (sql, ...values) => { if (/DELETE/i.test(sql)) deletes++; return db.query(sql, ...values); } }, 'test:'));
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => stores[i % 2].increment('client')));
    assert.deepEqual(results.map(result => result.totalHits).sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.equal(deletes, 0);
    assert.equal(new Set(results.map(result => result.resetTime?.getTime())).size, 1);
  } finally { await f.close(); }
});

test('Cold reads are coalesced; successful check-in avoids a read-back and invalidates statistics', async () => {
  const f = await concurrencyFixture();
  try {
    const [person] = await f.seed(1);
    f.queryCounts[0] = 0;
    await Promise.all(Array.from({ length: 30 }, () => f.request(0, '/public/event')));
    assert.equal(f.queryCounts[0], 1);
    const before = await f.request(0, '/admin/dashboard', undefined, true);
    assert.equal(before.data.stats.checked, 0);
    f.queryCounts[0] = 0;
    await f.request(0, '/admin/checkin', { id: person.id }, true);
    assert.equal(f.queryCounts[0], 2, 'one authentication query and one atomic update');
    assert.equal((await f.request(0, '/admin/dashboard', undefined, true)).data.stats.checked, 1);
    const event = { title: 'Updated', date: '', time: '', location: '', description: '' };
    await f.request(0, '/admin/event', event, true, 'PUT');
    assert.equal((await f.request(0, '/public/event')).data.title, 'Updated');
    await f.request(0, '/auth/logout', {}, true);
    assert.equal((await f.request(1, '/admin/dashboard', undefined, true)).status, 401);
  } finally { await f.close(); }
});

test('Database overload rejects excess queued queries and recovers', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const f = await concurrencyFixture();
  try {
    const results = await Promise.allSettled(Array.from({ length: 150 }, () => f.dbs[0].query('SELECT pg_sleep(0.01)')));
    const rejected = results.filter(result => result.status === 'rejected');
    assert.ok(rejected.length > 0);
    assert.ok(rejected.every(result => result.reason instanceof DatabaseUnavailableError));
    assert.equal((await f.request(0, '/health')).status, 200);
  } finally { await f.close(); }
});

test('IP limit still bounds invalid attempts across instances', async () => {
  const previous = process.env.TICKET_IP_LIMIT;
  process.env.TICKET_IP_LIMIT = '3';
  let f;
  try { f = await concurrencyFixture(); }
  finally { if (previous === undefined) delete process.env.TICKET_IP_LIMIT; else process.env.TICKET_IP_LIMIT = previous; }
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => f.request(i % 2, '/public/ticket', { phone: 'invalid' })));
    assert.equal(responses.filter(response => response.status === 400).length, 3);
    assert.equal(responses.filter(response => response.status === 429).length, 2);
  } finally { await f.close(); }
});

test('Other instances refresh cached event and statistics within their TTL', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await concurrencyFixture();
  try {
    const [person] = await f.seed(1);
    await f.request(1, '/public/event');
    await f.request(1, '/admin/dashboard', undefined, true);
    await f.request(0, '/admin/checkin', { id: person.id }, true);
    await f.request(0, '/admin/event', { title: 'Cross-instance update', date: '', time: '', location: '', description: '' }, true, 'PUT');
    t.mock.timers.tick(2001);
    assert.equal((await f.request(1, '/admin/dashboard', undefined, true)).data.stats.checked, 1);
    t.mock.timers.tick(3000);
    assert.equal((await f.request(1, '/public/event')).data.title, 'Cross-instance update');
  } finally { await f.close(); }
});

test('Temporary database overload returns retryable 503 instead of a validation error', async () => {
  const f = await concurrencyFixture();
  const query = f.dbs[0].query;
  try {
    f.dbs[0].query = async () => { throw new DatabaseUnavailableError(); };
    const result = await f.request(0, '/health');
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('retry-after'), '2');
  } finally { f.dbs[0].query = query; await f.close(); }
});
