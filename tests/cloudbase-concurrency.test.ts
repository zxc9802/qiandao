import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { DatabaseUnavailableError, openCloudBaseDatabase } from '../server/db.ts';

test('CloudBase caps active requests and queued work, then recovers after overload', async t => {
  let active = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    peak = Math.max(peak, ++active);
    await setImmediate();
    active--;
    return Response.json([{ ok: 1 }]);
  });
  const db = openCloudBaseDatabase('test', 'test');
  const results = await Promise.allSettled(Array.from({ length: 160 }, () => db.query('SELECT 1')));
  assert.equal(peak, 8);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 108);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 52);
  assert.ok(rejected.every(result => result.reason instanceof DatabaseUnavailableError));
  assert.deepEqual((await db.query('SELECT 1')).rows, [{ ok: 1 }]);
});

test('CloudBase queued queries expire without being sent later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finish: (() => void)[] = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => {
    finish.push(() => resolve(Response.json([])));
  }));
  const db = openCloudBaseDatabase('test', 'test');
  const running = Array.from({ length: 8 }, () => db.query('SELECT 1'));
  const expired = assert.rejects(db.query('SELECT 2'), DatabaseUnavailableError);
  await Promise.resolve();
  t.mock.timers.tick(5000);
  await expired;
  assert.equal(finish.length, 8);
  finish.forEach(resolve => resolve());
  await Promise.all(running);
  assert.equal(finish.length, 8, 'expired query must never reach the gateway');
});

test('CloudBase transient failures release capacity and never replay writes', async t => {
  let calls = 0;
  let fail: () => Promise<Response>;
  t.mock.method(globalThis, 'fetch', () => { calls++; return fail(); });
  const db = openCloudBaseDatabase('test', 'test');
  const failures = [
    async () => { throw new TypeError('fetch failed'); },
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => new Response('gateway unavailable', { status: 503 }),
    async () => new Response('rate limited', { status: 429 }),
    async () => Response.json({ code: 'DATABASE_53300' }, { status: 400 }),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('body disconnected')); } })),
  ];
  for (const failure of failures) {
    fail = failure;
    const before = calls;
    await assert.rejects(db.query('UPDATE people SET checked_at = ? RETURNING id', 'now'), DatabaseUnavailableError);
    assert.equal(calls, before + 1, 'writes must not be retried automatically');
  }
  fail = async () => Response.json([{ id: 1 }]);
  assert.equal((await db.query('SELECT 1')).changes, 1);
  fail = async () => Response.json({ code: 'DATABASE_42601', message: 'syntax error' }, { status: 400 });
  await assert.rejects(db.query('invalid SQL'), error => error instanceof Error && !(error instanceof DatabaseUnavailableError));
});
