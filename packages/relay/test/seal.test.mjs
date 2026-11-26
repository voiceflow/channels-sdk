// Sealing a connection's credentials: they open only with a key the relay
// holds, only for the connection they were sealed for, and only unchanged.
// A new key seals from then on while the old one still opens, until
// `resealConnections` has moved everything over.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { memoryConnectionStore, open, parseKeys, resealConnections, seal } from '../dist/index.js';

const key = () => randomBytes(32).toString('base64');

test('keys come from one setting, the first sealing, and a bad one is named without its value', () => {
  const one = key();
  const two = key();
  const keys = parseKeys(`k2:${two}, k1:${one}`);
  assert.equal(keys.current, 'k2');
  assert.deepEqual(Object.keys(keys.keys).sort(), ['k1', 'k2']);

  const short = randomBytes(16).toString('base64');
  for (const [setting, said] of [
    ['', /No relay keys/],
    [`k1:${short}`, /"k1" isn't 32 bytes/],
    [one, /needs an ID/],
    [`k 1:${one}`, /needs an ID/],
    [`k1:${one},k1:${two}`, /given twice/],
  ]) {
    assert.throws(
      () => parseKeys(setting),
      (error) => said.test(error.message) && !error.message.includes(one) && !error.message.includes(short),
    );
  }
});

test('sealed credentials open only for their own connection, and only unchanged', () => {
  const keys = parseKeys(`k1:${key()}`);
  const secrets = { apiKey: 'VF.DM.made-up', channels: { slack: { botToken: 'xoxb-made-up' } } };
  const sealed = seal(keys, 'c_one', secrets);
  assert.equal(sealed.key, 'k1');
  assert.ok(!JSON.stringify(sealed).includes('made-up'));
  assert.deepEqual(open(keys, 'c_one', sealed), secrets);
  // Sealed again, it differs: a fresh IV each time.
  assert.notEqual(seal(keys, 'c_one', secrets).data, sealed.data);

  assert.throws(() => open(keys, 'c_two', sealed), /sealed for another connection/);
  const data = Buffer.from(sealed.data, 'base64');
  data[0] ^= 1;
  assert.throws(() => open(keys, 'c_one', { ...sealed, data: data.toString('base64') }), /were changed/);
  assert.throws(() => open(parseKeys(`k1:${key()}`), 'c_one', sealed), /don't open/);
  assert.throws(() => open(parseKeys(`k9:${key()}`), 'c_one', sealed), /key "k1", which this relay doesn't have/);
});

test('a new key seals from then on, the old one still opens, and resealing moves every connection to the new one', async () => {
  const old = `k1:${key()}`;
  const before = parseKeys(old);
  const store = memoryConnectionStore();
  for (const id of ['c_a', 'c_b']) {
    const at = new Date().toISOString();
    await store.create({
      id,
      projectID: 'p',
      workspaceID: 'w',
      environment: 'production',
      channels: [],
      disabled: false,
      tokenHash: '00',
      sealed: seal(before, id, { apiKey: `key-of-${id}` }),
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
  }
  const after = parseKeys(`k2:${key()},${old}`);
  assert.deepEqual(open(after, 'c_a', (await store.get('c_a')).sealed), { apiKey: 'key-of-c_a' });

  assert.deepEqual(await resealConnections({ store, keys: after }), { resealed: 2, failed: [] });
  for (const id of ['c_a', 'c_b']) {
    const record = await store.get(id);
    assert.equal(record.sealed.key, 'k2');
    assert.equal(record.revision, 2);
    // The old key can go now.
    assert.deepEqual(open(parseKeys(`k2:${Buffer.from(after.keys.k2).toString('base64')}`), id, record.sealed), { apiKey: `key-of-${id}` });
  }
  assert.deepEqual(await resealConnections({ store, keys: after }), { resealed: 0, failed: [] });
});
