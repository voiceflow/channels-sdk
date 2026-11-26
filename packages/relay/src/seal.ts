// What keeps a connection's credentials unreadable at rest: AES-256-GCM,
// under a key the store never holds. Each sealed value names the key it was
// sealed with, so a new key can come in while the old one still opens what
// it sealed (`resealConnections` moves everything to the new one), and it is
// bound to its connection's ID, so a sealed value copied onto another row
// doesn't open there.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** A connection's credentials as stored: never readable without the key named. */
export interface Sealed {
  /** The format. */
  v: 1;
  /** The ID of the key it was sealed with. */
  key: string;
  iv: string;
  tag: string;
  data: string;
}

/** The keys a relay seals with: `current` seals, and every one listed opens. */
export interface RelayKeys {
  current: string;
  keys: Readonly<Record<string, Buffer>>;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const label = (connection: string) => Buffer.from(`voiceflow-channels-relay/connection/v1:${connection}`);

/**
 * Reads keys from one setting: `id:base64,id:base64`, the first sealing and
 * every one opening. Each key is 32 random bytes. An error names the key, and
 * never shows any of its value.
 */
export function parseKeys(setting: string | undefined): RelayKeys {
  const entries = String(setting ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!entries.length) throw new TypeError('No relay keys were given. Set them as `id:base64`, the key that seals first.');
  const keys: Record<string, Buffer> = {};
  for (const entry of entries) {
    const at = entry.indexOf(':');
    const id = at > 0 ? entry.slice(0, at) : '';
    if (!KEY_ID.test(id)) throw new TypeError('A relay key needs an ID of letters, digits, "_" or "-" before its value: `id:base64`.');
    const key = Buffer.from(entry.slice(at + 1), 'base64');
    if (key.length !== 32) throw new TypeError(`Relay key "${id}" isn't 32 bytes of base64.`);
    if (keys[id]) throw new TypeError(`Relay key "${id}" is given twice.`);
    keys[id] = key;
  }
  return { current: entries[0]!.slice(0, entries[0]!.indexOf(':')), keys };
}

/** Seals a connection's credentials with the current key. */
export function seal(keys: RelayKeys, connection: string, value: unknown): Sealed {
  const key = keys.keys[keys.current];
  if (!key) throw new TypeError(`The relay's current key "${keys.current}" isn't among its keys.`);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(label(connection));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, key: keys.current, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Opens what `seal` sealed for this connection. Throws when the key is missing, or the value was changed or sealed for another. */
export function open<T = unknown>(keys: RelayKeys, connection: string, sealed: Sealed): T {
  if (sealed?.v !== 1) throw new TypeError(`Connection ${connection}'s credentials are in a format this relay doesn't read.`);
  const key = keys.keys[sealed.key];
  if (!key) throw new TypeError(`Connection ${connection} was sealed with key "${sealed.key}", which this relay doesn't have.`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(label(connection));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const text = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    throw new TypeError(`Connection ${connection}'s credentials don't open: they were changed, or sealed for another connection.`);
  }
}
