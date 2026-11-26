// One state store, seen from two connections: each sees only what it wrote,
// whether keys, lists, subscriptions, locks or queues, though both use the
// same names, as two bots talking to one person do.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { namespacedState } from '../dist/index.js';

async function pair() {
  const shared = createMemoryState();
  const a = namespacedState(shared, 'relay:c_a');
  const b = namespacedState(shared, 'relay:c_b');
  await a.connect();
  await b.connect();
  return { shared, a, b };
}

test('keys, lists and subscriptions of one connection are not the other’s', async () => {
  const { shared, a, b } = await pair();
  await a.set('thread-state:telegram:1001', { voiceflow: { sessionKey: 'sk-a' } });
  assert.equal(await b.get('thread-state:telegram:1001'), null);
  assert.equal(await shared.get('thread-state:telegram:1001'), null);
  assert.deepEqual(await shared.get('relay:c_a:thread-state:telegram:1001'), { voiceflow: { sessionKey: 'sk-a' } });

  assert.equal(await a.setIfNotExists('dedupe:telegram:501', 1), true);
  assert.equal(await b.setIfNotExists('dedupe:telegram:501', 1), true);
  assert.equal(await a.setIfNotExists('dedupe:telegram:501', 1), false);

  await a.appendToList('history', 'one');
  assert.deepEqual(await b.getList('history'), []);
  assert.deepEqual(await a.getList('history'), ['one']);

  await a.subscribe('telegram:1001');
  assert.equal(await a.isSubscribed('telegram:1001'), true);
  assert.equal(await b.isSubscribed('telegram:1001'), false);
  await a.delete('thread-state:telegram:1001');
  assert.equal(await a.get('thread-state:telegram:1001'), null);

  // Disconnecting one connection's view leaves the store up for the rest.
  await a.disconnect();
  assert.equal(await b.isSubscribed('telegram:1001'), false);
});

test('a lock or a queue of one connection holds nothing up in the other', async () => {
  const { a, b } = await pair();
  const lock = await a.acquireLock('telegram:1001', 30_000);
  assert.equal(lock.threadId, 'telegram:1001');
  assert.equal(await a.acquireLock('telegram:1001', 30_000), null);
  const other = await b.acquireLock('telegram:1001', 30_000);
  assert.ok(other);

  assert.equal(await a.extendLock(lock, 30_000), true);
  await a.releaseLock(lock);
  assert.ok(await a.acquireLock('telegram:1001', 30_000));
  await b.forceReleaseLock('telegram:1001');
  assert.ok(await b.acquireLock('telegram:1001', 30_000));

  assert.equal(await a.enqueue('telegram:1001', { message: 'one' }, 10), 1);
  assert.equal(await b.queueDepth('telegram:1001'), 0);
  assert.equal(await b.dequeue('telegram:1001'), null);
  assert.deepEqual(await a.dequeue('telegram:1001'), { message: 'one' });
});

test('a prefix is a plain name', () => {
  for (const prefix of ['', 'has space', 'x'.repeat(129)]) assert.throws(() => namespacedState(createMemoryState(), prefix), /prefix/);
});
