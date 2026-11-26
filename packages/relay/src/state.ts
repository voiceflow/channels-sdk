// One state store, kept apart per connection. A thread's ID names the
// platform and the conversation, not the bot: two Telegram bots talking to the
// same person both see `telegram:<their chat ID>`. On one shared store, two
// connections would share that thread's state, and with it the Voiceflow
// session. So every key, thread, lock and queue a connection's bot touches is
// put under its connection's prefix here, whatever the store underneath does.
//
// Built on Chat SDK's public `StateAdapter` only: a method Chat SDK adds is a
// type error here, not a key that slips past the prefix.
import type { Lock, QueueEntry, StateAdapter } from 'chat';

/** The store, seen from one connection: everything under `prefix`. Connecting is shared; disconnecting is left to the store's owner. */
export function namespacedState(state: StateAdapter, prefix: string): StateAdapter {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(prefix)) throw new TypeError('A state prefix is 1 to 128 letters, digits, "_", "-" or ":".');
  const at = (key: string) => `${prefix}:${key}`;
  // A lock is handed back as Chat SDK asked for it, and turned back into the store's own to release or extend.
  const inner = (lock: Lock): Lock => ({ ...lock, threadId: at(lock.threadId) });
  const outer = (lock: Lock | null, threadId: string): Lock | null => (lock ? { ...lock, threadId } : null);
  return {
    connect: () => state.connect(),
    disconnect: async () => {},
    get: <T>(key: string) => state.get<T>(at(key)),
    set: <T>(key: string, value: T, ttlMs?: number) => state.set(at(key), value, ttlMs),
    setIfNotExists: (key: string, value: unknown, ttlMs?: number) => state.setIfNotExists(at(key), value, ttlMs),
    delete: (key: string) => state.delete(at(key)),
    appendToList: (key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }) => state.appendToList(at(key), value, options),
    getList: <T>(key: string) => state.getList<T>(at(key)),
    subscribe: (threadId: string) => state.subscribe(at(threadId)),
    unsubscribe: (threadId: string) => state.unsubscribe(at(threadId)),
    isSubscribed: (threadId: string) => state.isSubscribed(at(threadId)),
    acquireLock: async (threadId: string, ttlMs: number) => outer(await state.acquireLock(at(threadId), ttlMs), threadId),
    releaseLock: (lock: Lock) => state.releaseLock(inner(lock)),
    extendLock: (lock: Lock, ttlMs: number) => state.extendLock(inner(lock), ttlMs),
    forceReleaseLock: (threadId: string) => state.forceReleaseLock(at(threadId)),
    enqueue: (threadId: string, entry: QueueEntry, maxSize: number) => state.enqueue(at(threadId), entry, maxSize),
    dequeue: (threadId: string) => state.dequeue(at(threadId)),
    queueDepth: (threadId: string) => state.queueDepth(at(threadId)),
  };
}
