// A turn's pass: what lets a tool call from Voiceflow act for the conversation
// it came from. The server mints one for each turn and sets it as a variable
// on the Voiceflow session; the agent's server tools send it back with every
// call. It names the thread and the person, and it is signed with a key only
// the server holds, so a call can't choose who it acts for: a pass can't be
// made or changed anywhere else, and one from another conversation still names
// that conversation.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PassClaims {
  /** The Chat SDK thread the turn is in. */
  thread: string;
  /** The person the turn is for, as the channel identifies them. Empty when the channel didn't say. */
  user: string;
  /** This turn's own ID: a pass stops working when its turn ends. */
  turn: string;
  /** When it stops working regardless, in Unix milliseconds. */
  expires: number;
}

const VERSION = 'v1';
const LABEL = 'voiceflow-channels/turn-pass/v1';

/** The signing key for a secret. Derived, so the secret itself (an API key, say) never signs anything directly. */
export function passKey(secret: string): Buffer {
  if (!secret) throw new TypeError('passKey: the secret is empty');
  return createHmac('sha256', secret).update(LABEL).digest();
}

export function newTurnId(): string {
  return randomBytes(12).toString('base64url');
}

function sign(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(`${VERSION}.${body}`).digest();
}

export function mintPass(key: Buffer, claims: PassClaims): string {
  const body = Buffer.from(JSON.stringify({ t: claims.thread, u: claims.user, n: claims.turn, e: claims.expires })).toString('base64url');
  return `${VERSION}.${body}.${sign(key, body).toString('base64url')}`;
}

/** What a pass says, or `null` when it wasn't signed with this key, has expired, or isn't a pass at all. */
export function readPass(key: Buffer, pass: string, now: number = Date.now()): PassClaims | null {
  const parts = pass.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, body, signature] = parts as [string, string, string];
  const given = Buffer.from(signature, 'base64url');
  const expected = sign(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { t, u, n, e } = (claims ?? {}) as Record<string, unknown>;
  if (typeof t !== 'string' || !t || typeof u !== 'string' || typeof n !== 'string' || !n || typeof e !== 'number') return null;
  if (!(e > now)) return null;
  return { thread: t, user: u, turn: n, expires: e };
}
