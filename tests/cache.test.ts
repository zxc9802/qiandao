import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortCache } from '../server/cache.ts';

test('Short cache expires and retries failed reads', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let reads = 0;
  const cache = shortCache(2000, async () => { if (++reads === 2) throw new Error('offline'); return reads; });
  assert.equal(await cache.get(), 1);
  t.mock.timers.tick(1999);
  assert.equal(await cache.get(), 1);
  t.mock.timers.tick(1);
  await assert.rejects(cache.get(), /offline/);
  assert.equal(await cache.get(), 3);
});

test('A read started before a write cannot repopulate the cleared cache', async () => {
  let resolveOld!: (value: string) => void;
  let reads = 0;
  const cache = shortCache(2000, () => ++reads === 1 ? new Promise<string>(resolve => { resolveOld = resolve; }) : Promise.resolve('new'));
  const old = cache.get();
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.get(), 'new');
  resolveOld('old');
  assert.equal(await old, 'old');
  assert.equal(await cache.get(), 'new');
});
