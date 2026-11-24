// What the Teams adapter says on your server's console, kept to what's worth
// reading and safe to keep. Two things are done to it:
//
// - Only warnings and errors are printed: the adapter logs each request it's
//   sent and each call it makes.
// - A failed call to Teams is a line, not a page, and never holds the bot's
//   access token. The adapter logs the error as it caught it, and that error
//   carries the whole request: its headers, with `Authorization: Bearer …`,
//   beside a stack of some sixty lines. Whoever read the log could act as the
//   bot until the token ran out. What's printed is the error's name, what it
//   said, and what Teams answered.
//
// A logger you give the adapter yourself is used as it is.
import { ConsoleLogger, type Logger } from 'chat';

/** A signed token (three base64url parts), as Microsoft's access tokens are. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
/** The keys of a request, or of what was sent with one: nothing under them is printed. */
const REQUEST_KEYS = new Set(['config', 'request', 'headers', 'stack', 'authorization', 'Authorization']);
const MAX_DEPTH = 4;
const MAX_TEXT = 600;

/** Takes any access token out of a string. */
export function withoutTokens(text: string): string {
  return text.replace(JWT, '[token]').replace(BEARER, '$1 [token]');
}

const short = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (${text.length} characters)` : text);

/** What a failed call's answer said, in a few words: Teams' own code and message, where it gave them. */
function answered(data: unknown): string | undefined {
  if (data === undefined || data === null || data === '') return undefined;
  if (typeof data === 'string') return short(withoutTokens(data));
  const error = (data as { error?: { code?: unknown; message?: unknown }; message?: unknown }).error;
  const parts = [error?.code, error?.message ?? (data as { message?: unknown }).message].filter((part) => typeof part === 'string' && part);
  if (parts.length) return short(withoutTokens(parts.join(': ')));
  try {
    return short(withoutTokens(JSON.stringify(data)));
  } catch {
    return undefined;
  }
}

/** An error as it's worth printing: its name and message, the HTTP status, and what the answer said. */
function errorLine(error: Record<string, any>): Record<string, unknown> {
  const response = error.response as { status?: unknown; data?: unknown } | undefined;
  const status = response?.status ?? error.status ?? error.statusCode;
  const said = answered(response?.data ?? error.body);
  return {
    ...(typeof error.name === 'string' ? { name: error.name } : {}),
    message: withoutTokens(String(error.message ?? '')),
    ...(typeof error.code === 'string' || typeof error.code === 'number' ? { code: error.code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(said ? { answered: said } : {}),
  };
}

const isError = (value: object) => value instanceof Error || 'stack' in value || 'isAxiosError' in value || ('config' in value && 'message' in value);

/** A logged value, with errors cut to a line and every token and request taken out. */
export function loggable(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return withoutTokens(value);
  if (!value || typeof value !== 'object') return value;
  if (isError(value)) return errorLine(value as Record<string, any>);
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((item) => loggable(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !REQUEST_KEYS.has(key))
      .map(([key, item]) => [key, loggable(item, depth + 1)]),
  );
}

/** The adapter's logger as this package sets it up. `base` is where its lines go: by default the console, warnings and up. */
export function teamsLogger(base: Logger = new ConsoleLogger('warn').child('teams')): Logger {
  const clean = (args: unknown[]) => args.map((arg) => loggable(arg));
  return {
    child: (prefix) => teamsLogger(base.child(prefix)),
    debug: (message, ...args) => base.debug(withoutTokens(message), ...clean(args)),
    info: (message, ...args) => base.info(withoutTokens(message), ...clean(args)),
    warn: (message, ...args) => base.warn(withoutTokens(message), ...clean(args)),
    error: (message, ...args) => base.error(withoutTokens(message), ...clean(args)),
  };
}
