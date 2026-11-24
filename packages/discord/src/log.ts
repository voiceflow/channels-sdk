// What the Discord adapter says on your server's console, kept to what's worth
// reading. Three things are done to it:
//
// - Only warnings and errors are printed: Discord's connection passes on a
//   great many events that aren't for the bot, and the adapter logs each.
// - A request with a bad signature is one line, not twelve. Discord sends such
//   requests itself, on purpose, each time it's given an address and now and
//   then after: your server refusing one is the check passing.
// - An interaction's token is taken out of anything printed. The adapter logs
//   the address it answered an interaction at when that fails, and the token
//   is in the address: it would let whoever read the log answer in the bot's
//   place for a quarter of an hour.
//
// A logger you give the adapter yourself is used as it is.
import { ConsoleLogger, type Logger } from 'chat';

const BAD_SIGNATURE = /^Discord signature verification failed: (invalid signature|missing headers)/;
const REFUSED = /^Discord signature verification failed, returning 401/;
/** An interaction's webhook or callback address: the part after the ID is its token. */
const INTERACTION_TOKEN = /(\/(?:webhooks|interactions)\/\d+\/)[A-Za-z0-9_-]{20,}/g;

const EXPLAINED =
  "Discord sends requests like this itself, to test an address: refusing them is right, and nothing is wrong unless Discord's real requests are refused too.";

/** Takes an interaction's token out of a string, or out of the strings an object or an error holds. */
export function withoutInteractionTokens<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return value.replace(INTERACTION_TOKEN, '$1[interaction token]') as T;
  if (value instanceof Error) {
    const cleaned = withoutInteractionTokens(value.message);
    if (cleaned !== value.message) value.message = cleaned;
    return value;
  }
  if (!value || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.map((item) => withoutInteractionTokens(item, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutInteractionTokens(item, depth + 1)])) as T;
}

/** The adapter's logger as this package sets it up. `base` is where its lines go: by default the console, warnings and up. */
export function discordLogger(base: Logger = new ConsoleLogger('warn').child('discord')): Logger {
  // Said once, on the first refusal: after that the one line is enough.
  let explained = false;
  const clean = (args: unknown[]) => args.map((arg) => withoutInteractionTokens(arg));
  const logger: Logger = {
    child: (prefix) => discordLogger(base.child(prefix)),
    debug: (message, ...args) => base.debug(withoutInteractionTokens(message), ...clean(args)),
    info: (message, ...args) => base.info(withoutInteractionTokens(message), ...clean(args)),
    warn(message, ...args) {
      // The adapter says this twice for one request: once with its details, once to say it answered 401.
      if (REFUSED.test(message)) return;
      const bad = BAD_SIGNATURE.exec(message);
      if (bad) {
        const what = bad[1] === 'missing headers' ? 'with no signature' : 'with a bad signature';
        base.warn(`Refused a request ${what} (401).${explained ? '' : ` ${EXPLAINED}`}`);
        explained = true;
        return;
      }
      base.warn(withoutInteractionTokens(message), ...clean(args));
    },
    error: (message, ...args) => base.error(withoutInteractionTokens(message), ...clean(args)),
  };
  return logger;
}
