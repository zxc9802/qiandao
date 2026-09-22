import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

test('QR: decoding must not require a second network request after the page loads', async () => {
  const result = await build({ logLevel: 'silent', build: { write: false } });
  assert.ok('output' in result);
  const entry = result.output.find(chunk => chunk.type === 'chunk' && chunk.isEntry);
  assert.ok(entry && entry.type === 'chunk');
  assert.ok(Object.keys(entry.modules).some(id => id.endsWith('/qr-scanner-worker.min.js')),
    'The decoder must be included in the page bundle so a failed lazy request cannot break camera and album scanning');
  assert.equal(entry.dynamicImports.length, 0);
});
