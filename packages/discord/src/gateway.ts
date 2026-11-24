// Discord sends what people write over a standing connection (its Gateway),
// never to an address. This holds that connection open and passes each event
// on to your server's Discord route, where the adapter takes it as it takes
// any request. `voiceflow-channelkit dev` runs it beside your server; a server
// that stays up can run it too. Slash commands and button clicks don't come
// this way once Discord has your server's address: it sends those there.
//
// Each event is passed on with the bot's token, which is how the adapter on
// your server knows who sent it. So `webhookUrl` is only ever your own server.
// Node only.

/** The part of the Discord adapter this uses. */
interface GatewayAdapter {
  startGatewayListener(
    options: { waitUntil: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

interface GatewayLogger {
  child(prefix: string): GatewayLogger;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ForwardGatewayOptions {
  /** Your server's Discord route, where each event is passed on (`http://127.0.0.1:3000/api/discord`). */
  webhookUrl: string;
  /** Ends it: the connection is closed, and the promise resolves. */
  signal: AbortSignal;
  /**
   * The Discord adapter's config (`botToken`, `publicKey`, `applicationId`, …).
   * Default: DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY and DISCORD_APPLICATION_ID in
   * the environment.
   */
  adapter?: Record<string, unknown>;
  /** Called when the connection is up, with the bot's name. */
  onConnected?: (bot: string) => void;
  /** Called with each problem the connection reports, cleaned of the bot's token. */
  onProblem?: (problem: string) => void;
  /** Called each time an event from Discord was passed on and your server took it, with its kind (`GATEWAY_MESSAGE_CREATE`). */
  onForwarded?: (type: string) => void;
  /** Makes the adapter, in place of `@chat-adapter/discord`'s: for a test. */
  create?: (config: Record<string, unknown>) => GatewayAdapter | Promise<GatewayAdapter>;
  /** How long one connection is held before it's renewed. Default: about three weeks. */
  holdMs?: number;
}

/** As long as a timer can be set for. */
const HOLD_MS = 2_000_000_000;

/**
 * Holds Discord's Gateway connection open, passing what arrives to
 * `webhookUrl`, until `signal` aborts. Rejects when the connection can't be
 * made, or ends by itself: nothing would arrive, and nothing else would say so.
 */
export async function forwardGateway(options: ForwardGatewayOptions): Promise<void> {
  const { signal } = options;
  const holdMs = options.holdMs ?? HOLD_MS;
  const token = typeof options.adapter?.botToken === 'string' ? options.adapter.botToken : process.env.DISCORD_BOT_TOKEN;
  const clean = (text: string) => (token ? text.split(token).join('[bot token]') : text);
  let lastProblem = '';
  const problem = (message: string, args: unknown[]) => {
    lastProblem = clean([message, ...args.map(detail)].filter(Boolean).join(': ')).slice(0, 500);
    options.onProblem?.(lastProblem);
  };
  // The adapter reports through its logger and throws nothing: a login Discord refuses is only a line there.
  const logger: GatewayLogger = {
    child: () => logger,
    debug: (message, ...args) => {
      if (/forwarded successfully/i.test(message)) options.onForwarded?.(String((args[0] as { type?: unknown } | undefined)?.type ?? ''));
    },
    info: (message, ...args) => {
      if (/gateway connected/i.test(message)) options.onConnected?.(String((args[0] as { username?: unknown } | undefined)?.username ?? ''));
    },
    warn: (message, ...args) => problem(message, args),
    error: (message, ...args) => problem(message, args),
  };
  const adapter = await (options.create ?? standalone)({ ...options.adapter, logger });

  while (!signal.aborted) {
    let running: Promise<unknown> | undefined;
    const started = Date.now();
    lastProblem = '';
    const response = await adapter.startGatewayListener(
      {
        waitUntil: (task) => {
          running = task;
        },
      },
      holdMs,
      signal,
      options.webhookUrl,
    );
    if (!response.ok || !running)
      throw new Error(`Discord's Gateway listener didn't start: ${clean(await response.text().catch(() => String(response.status)))}`);
    await running;
    if (signal.aborted) return;
    // It held for as long as it was asked to: renew it. Sooner than that, it ended by itself.
    if (Date.now() - started < holdMs - 1000) throw new Error(`The connection to Discord's Gateway ended${lastProblem ? `: ${lastProblem}` : '.'}`);
  }
}

/** A Discord adapter of its own, with a bot around it that does nothing: the listener only passes events on. */
async function standalone(config: Record<string, unknown>): Promise<GatewayAdapter> {
  const [{ createDiscordAdapter }, { Chat }, { createMemoryState }] = await Promise.all([
    import('@chat-adapter/discord'),
    import('chat'),
    import('@chat-adapter/state-memory').catch(() => {
      throw new Error("Holding Discord's Gateway connection needs @chat-adapter/state-memory: install it.");
    }),
  ]);
  const adapter = createDiscordAdapter(config as Parameters<typeof createDiscordAdapter>[0]);
  const bot = new Chat({ userName: 'gateway', adapters: { discord: adapter }, state: createMemoryState(), logger: 'silent' });
  await bot.initialize();
  return adapter as unknown as GatewayAdapter;
}

function detail(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  const said = (value as { error?: unknown }).error;
  if (typeof said === 'string') return said;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
