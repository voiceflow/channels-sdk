// Discord's HTTP API, for connect: the calls a bot token can make about its
// own application. Discord has no way to make an application from outside its
// Developer Portal, so everything here starts from a token a person copied.
// The token is sent to Discord and nowhere else, and never comes back in an error.

export const DISCORD_API = 'https://discord.com/api/v10';
export const DEVELOPER_PORTAL = 'https://discord.com/developers/applications';
/** The Developer Portal with its "new application" dialog open: the one place an application can be made. */
export const NEW_APPLICATION = `${DEVELOPER_PORTAL}?new_application=true`;

/** Application flags a bot token can turn on for itself, and the one only Discord grants. */
export const APP_FLAGS = {
  /** The Message Content intent, granted by Discord to a verified app. */
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  /** The Message Content intent, for an app in fewer than 100 servers: the switch in the portal's Bot page. */
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
} as const;

/** The permissions the bot asks a server for when it's added. */
export const PERMISSIONS = {
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

export const BOT_PERMISSIONS = Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0n);

/** A Discord ID, as a server's or an application's is written. */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

/**
 * The link that adds the bot to a server, with its slash command and the permissions it uses: whoever opens it
 * picks the server and authorizes. With `server` (a server's ID) the page opens with that server chosen.
 */
export function installLink(applicationId: string, options: { server?: string } = {}): string {
  const link = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
  return options.server ? `${link}&guild_id=${encodeURIComponent(options.server)}` : link;
}

export interface DiscordApiOptions {
  /** The bot's token. Never printed. */
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Discord's own error code, where it gave one. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

export type DiscordApi = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;

export function createDiscordApi(options: DiscordApiOptions): DiscordApi {
  const base = (options.apiUrl ?? DISCORD_API).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bot ${options.token}`,
          // Discord refuses a request that doesn't say what sent it.
          'user-agent': 'DiscordBot (https://github.com/voiceflow/channels-sdk, 0)',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed: any;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = undefined;
      }
      // Asked to slow down: wait as long as Discord says, a couple of times.
      if (res.status === 429 && attempt < 2) {
        await wait(Math.min(Math.max(Number(parsed?.retry_after) || 1, 0.1), 5) * 1000);
        continue;
      }
      if (res.ok) return (parsed ?? {}) as T;
      const said = parsed?.message ? `${parsed.message}${fieldErrors(parsed.errors)}` : text.slice(0, 300);
      throw new DiscordApiError(
        `Discord ${method} ${path} answered ${res.status}: ${said.split(options.token).join('[bot token]')}`,
        res.status,
        typeof parsed?.code === 'number' ? parsed.code : undefined,
      );
    }
  };
}

/** Discord's per-field errors (`{ field: { _errors: [{ message }] } }`), as "(field: message; …)". */
function fieldErrors(errors: unknown): string {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '_errors' && Array.isArray(value)) {
        for (const e of value) found.push(`${path || 'request'}: ${String((e as { message?: unknown })?.message ?? '')}`);
      } else walk(value, path ? `${path}.${key}` : key);
    }
  };
  walk(errors, '');
  return found.length ? ` (${found.join('; ').slice(0, 400)})` : '';
}
