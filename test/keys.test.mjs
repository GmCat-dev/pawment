import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blake2b } from '../core/blake2b.mjs';
import { baseAddress, parseAccountKey, checkAddress } from '../chains/cardano-keys.mjs';
const ref = JSON.parse(readFileSync(new URL('./fixtures/keys.json', import.meta.url)));
test('blake2b matches hashlib', () => {
  [[0, 28], [3, 32], [128, 28], [129, 64], [300, 28]].forEach(([n, d], i) => {
    const input = Buffer.concat(Array(Math.floor(n / 256) + 1).fill(Buffer.from([...Array(n % 256).keys()])));
    assert.equal(blake2b(input, d).toString('hex'), ref.b[i]);
  });
});
test('addresses match Drop (Python)', () => {
  const xp = parseAccountKey(ref.xpub);
  assert.equal(baseAddress(xp, 0), ref.a0);
  assert.equal(baseAddress(xp, 5), ref.a5);
  assert.equal(baseAddress(xp, 3, { network: 0 }), ref.t3);
  assert.equal(checkAddress(ref.a5), ref.a5);
  assert.throws(() => checkAddress(ref.a5.slice(0, -1) + (ref.a5.endsWith('q') ? 'p' : 'q')));
  assert.throws(() => checkAddress(ref.t3));
  assert.throws(() => parseAccountKey('xprv1abc'), /PRIVATE/);
});
