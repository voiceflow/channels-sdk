// What an adapter says on your server's console, with nothing in it that lets
// whoever reads the log act as the bot. Every adapter `createChannels` makes
// logs through this, whatever the platform and whether or not its channel has
// a package here, so none of it rests on how careful an adapter is.
//
// An adapter logs an error as it caught it, and an HTTP client's error carries
// the whole request: its headers, with `Authorization: Bearer …`, and often
// the address it was sent to, with a bot's token in it. So three things are
// taken out of every line before it reaches the logger:
//
// - the request an error carries (`config`, `request`, `headers`): what is
//   kept is the error's name, message and stack, its code and status, and what
//   the platform answered;
// - anything shaped like an access token (a signed token, or what follows
//   `Bearer`);
// - every secret the channel was given: the values of the settings Chat SDK's
//   catalog marks as secret, and of the adapter options named like one.
//
// A logger of your own (`adapter: { logger }`) gets the same lines, cleaned
// the same way. Only an adapter you built yourself and passed whole
// (`adapter: …` in `channels`) logs as you made it.
import { ConsoleLogger, type Logger } from 'chat';
import { secretVars } from './catalog.js';
import { createRedactor } from './redact.js';

/** A signed token (three base64url parts), as most platforms' access tokens are. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Bot|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
/** The keys of a request, or of what was sent with one: nothing under them is passed on. */
const REQUEST_KEYS = new Set(['config', 'request', 'headers', 'authorization', 'Authorization']);
/** An adapter option whose value is a secret, by its name. */
const SECRET_OPTION = /token|secret|password|passphrase|credential|private|apikey|api_key|\bkey$|Key$|\bpin$|Pin$/i;
const MAX_DEPTH = 5;

/** Takes anything shaped like an access token out of a string. */
export function withoutTokens(text: string): string {
  return text.replace(JWT, '[token]').replace(BEARER, '$1 [token]');
}

const isError = (value: object) =>
  value instanceof Error || 'isAxiosError' in value || ('stack' in value && 'message' in value) || ('config' in value && 'message' in value);

/** What cleans one logged value: strings of secrets and tokens, objects of their requests, errors down to what is safe to keep. */
function cleaner(text: (value: string) => string) {
  const clean = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return text(value);
    if (!value || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[…]';
    if (isError(value)) {
      const from = value as Record<string, any>;
      // An error still, so a logger prints it as one: with its stack, and without the request it was thrown for.
      const error = new Error(text(String(from.message ?? '')));
      if (typeof from.name === 'string') error.name = from.name;
      if (typeof from.stack === 'string') error.stack = text(from.stack);
      else delete error.stack;
      const kept = error as Error & Record<string, unknown>;
      for (const key of ['code', 'status', 'statusCode'] as const) {
        if (typeof from[key] === 'string' || typeof from[key] === 'number') kept[key] = typeof from[key] === 'string' ? text(from[key]) : from[key];
      }
      const response = from.response as { status?: unknown; statusText?: unknown; data?: unknown } | undefined;
      if (response && typeof response === 'object') {
        // What the platform answered: its status and its words, never what was sent to it.
        kept.response = {
          ...(response.status !== undefined ? { status: response.status } : {}),
          ...(typeof response.statusText === 'string' ? { statusText: text(response.statusText) } : {}),
          ...(response.data !== undefined ? { data: clean(response.data, depth + 1) } : {}),
        };
      }
      if (from.body !== undefined) kept.body = clean(from.body, depth + 1);
      if (from.cause !== undefined) kept.cause = clean(from.cause, depth + 1);
      return kept;
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
    if (value instanceof Date || value instanceof RegExp) return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${(value as ArrayBufferView).byteLength} bytes]`;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !REQUEST_KEYS.has(key))
        .map(([key, item]) => [key, clean(item, depth + 1)]),
    );
  };
  return (value: unknown) => {
    try {
      return clean(value, 0);
    } catch {
      // A value that can't be read (a getter that throws, say) is not passed on as it is: it may be what holds the secret.
      return '[not logged]';
    }
  };
}

/**
 * A logger that passes every line on to `base` with its secrets taken out:
 * each of `secrets` wherever it is written, anything shaped like an access
 * token, and the request an error carries.
 */
export function cleanLogger(base: Logger, secrets: readonly (string | null | undefined)[] = []): Logger {
  const known = createRedactor(...secrets);
  const text = (value: string) => withoutTokens(known.redact(value));
  const clean = cleaner(text);
  const wrap = (to: Logger): Logger => ({
    child: (prefix) => wrap(to.child(prefix)),
    debug: (message, ...args) => to.debug(text(String(message)), ...args.map(clean)),
    info: (message, ...args) => to.info(text(String(message)), ...args.map(clean)),
    warn: (message, ...args) => to.warn(text(String(message)), ...args.map(clean)),
    error: (message, ...args) => to.error(text(String(message)), ...args.map(clean)),
  });
  return wrap(base);
}

/** The secrets among an adapter's options, by their names: every string under a key named like one, at any depth. */
function secretOptions(options: unknown, depth = 0, found: string[] = [], named = false): string[] {
  if (typeof options === 'string') {
    if (named) found.push(options);
  } else if (options && typeof options === 'object' && depth < MAX_DEPTH) {
    for (const [key, value] of Object.entries(options)) {
      if (key !== 'logger') secretOptions(value, depth + 1, found, named || SECRET_OPTION.test(key));
    }
  }
  return found;
}

/**
 * The logger `createChannels` gives a platform's adapter: the one in its
 * options, or else the console as the adapter would set it up itself (its
 * name, from `info` up), with the channel's secrets taken out of every line.
 */
export function adapterLogger(slug: string, options: Record<string, unknown> | undefined, env: Record<string, string | undefined> = process.env): Logger {
  let fromEnv: string[] = [];
  try {
    fromEnv = secretVars(slug)
      .map((key) => env[key])
      .filter((value): value is string => typeof value === 'string');
  } catch {
    // An adapter the catalog doesn't list has no settings it can name: its options still say which are secret.
  }
  const given = options?.logger as Logger | undefined;
  const base = given && typeof given === 'object' && typeof given.error === 'function' ? given : new ConsoleLogger('info').child(slug);
  return cleanLogger(base, [...fromEnv, ...secretOptions(options)]);
}
