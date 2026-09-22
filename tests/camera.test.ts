import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startCamera } from '../src/camera.ts';

test('Camera: a browser that never answers cannot leave startup pending forever', async () => {
  let destroyed = 0;
  const scanner = { start: () => new Promise<void>(() => {}), destroy: () => { destroyed++; } };
  const result = startCamera(scanner, new AbortController().signal, 10);
  await assert.rejects(Promise.race([result, delay(150).then(() => { throw new Error('Startup still pending'); })]), /相机开启超时/);
  assert.equal(destroyed, 1);
});

test('Camera: cancellation settles immediately and a late startup cannot reactivate it', async () => {
  let resolveStart!: () => void;
  let destroyed = 0;
  const scanner = { start: () => new Promise<void>(resolve => { resolveStart = resolve; }), destroy: () => { destroyed++; } };
  const controller = new AbortController();
  const result = startCamera(scanner, controller.signal, 1000);
  controller.abort();
  await assert.rejects(Promise.race([result, delay(150).then(() => { throw new Error('Cancellation still pending'); })]), { name: 'AbortError' });
  resolveStart();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(destroyed, 1);
});

test('Camera: success clears the deadline and leaves the active scanner usable', async () => {
  let destroyed = 0;
  const scanner = { start: async () => {}, destroy: () => { destroyed++; } };
  const controller = new AbortController();
  await startCamera(scanner, controller.signal, 10);
  controller.abort();
  await delay(20);
  assert.equal(destroyed, 0);
});

test('Camera: original failures are preserved and failed instances are disposed', async () => {
  const failure = new DOMException('Permission denied', 'NotAllowedError');
  let destroyed = 0;
  const scanner = { start: async () => { throw failure; }, destroy: () => { destroyed++; } };
  await assert.rejects(startCamera(scanner, new AbortController().signal, 100), error => error === failure);
  assert.equal(destroyed, 1);
});

test('Camera: a cancelled request must not open the device', async () => {
  let started = 0;
  let destroyed = 0;
  const controller = new AbortController(); controller.abort();
  const scanner = { start: async () => { started++; }, destroy: () => { destroyed++; } };
  await assert.rejects(startCamera(scanner, controller.signal), { name: 'AbortError' });
  assert.equal(started, 0); assert.equal(destroyed, 1);
});
