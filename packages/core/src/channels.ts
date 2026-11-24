// The one-call setup: a Chat SDK bot with the named channels, answered by a
// Voiceflow agent. Every adapter comes from Chat SDK's catalog; a channel's
// package (`slack()` from @voiceflow/channelkit-slack) adds its extension.
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Adapter, Chat, type ChatConfig, type StateAdapter, type WebhookOptions } from 'chat';
import { createVoiceflowAgent, type VoiceflowAgent, type VoiceflowAgentOptions } from './agent.js';
import { ChannelsError } from './errors.js';
import type { ChannelExtension } from './extension.js';
import { type Importer, loadAdapter } from './loader.js';
import { adapterLogger } from './log.js';
import { isToolCall } from './tool-server.js';

export type ChannelSpec =
  | string
  | {
      slug: string;
      /** The adapter's own config. Omit it to let the adapter read its env vars. */
      options?: Record<string, unknown>;
      /** An adapter you built yourself; used as-is instead of loading from the catalog. */
      adapter?: Adapter;
      /**
       * The adapter's package, already imported (`await import('@chat-adapter/slack')`).
       * A bundled server (Next.js, say) needs it, since a bundler can't load a
       * package by a name it only learns at run time. Channel packages pass it for you.
       */
      module?: Record<string, unknown>;
      /** What only this platform has, from its channel package. */
      extension?: ChannelExtension;
    };

export interface ChannelsOptions extends Omit<VoiceflowAgentOptions, 'extensions' | 'defer'> {
  channels: readonly ChannelSpec[];
  /** Where thread subscriptions, locks and Voiceflow session keys live. Use Redis or Postgres in production. */
  state: StateAdapter;
  /** The bot's display name on its channels. Set it to the name people @-mention. Default: `voiceflow`. */
  userName?: string;
  /** Any other Chat SDK settings. */
  chat?: Omit<Partial<ChatConfig>, 'adapters' | 'state' | 'userName'>;
  importer?: Importer;
}

export interface Channels {
  bot: Chat<any, any>;
  agent: VoiceflowAgent;
  /** The channel slugs this bot answers on. */
  slugs: string[];
  /**
   * Handles a request to a channel's URL: the platform's webhook, or a call
   * from one of the agent's server tools, which arrives at the same address.
   */
  webhook(slug: string, request: Request, options?: WebhookOptions): Promise<Response>;
  /** Handles a server tool's call alone, for a route of its own. */
  tools(request: Request): Promise<Response>;
}

export async function createChannels(options: ChannelsOptions): Promise<Channels> {
  const adapters: Record<string, Adapter> = {};
  const extensions: ChannelExtension[] = [];
  for (const spec of options.channels) {
    const { slug, options: adapterOptions, adapter, module, extension } = typeof spec === 'string' ? { slug: spec } : (spec as Extract<ChannelSpec, object>);
    // The channel's defaults sit under the caller's own options; with neither, the adapter reads its env vars.
    // An option the caller left undefined is one they didn't set: it takes no default away.
    const set = Object.fromEntries(Object.entries(adapterOptions ?? {}).filter(([, value]) => value !== undefined));
    const merged = extension?.adapterDefaults ? { ...extension.adapterDefaults, ...set } : adapterOptions;
    // Whatever the adapter logs goes through a logger that keeps the channel's secrets, and any access token, out
    // of it: its own where it was given one, the console otherwise. An adapter passed whole logs as it was made.
    adapters[slug] = adapter ?? (await loadAdapter(slug, { options: { ...merged, logger: adapterLogger(slug, merged) }, module, importer: options.importer }));
    if (extension) extensions.push(extension);
  }

  const bot = new Chat({
    // One turn at a time per thread, in order: a second message waits for the first reply.
    concurrency: 'queue',
    logger: 'error',
    ...options.chat,
    userName: options.userName ?? 'voiceflow',
    adapters,
    state: options.state,
  } as ChatConfig);

  // Work an extension starts after the webhook answers (a submitted form, say) runs under that request's waitUntil.
  const requests = new AsyncLocalStorage<WebhookOptions | undefined>();
  const agent = createVoiceflowAgent({
    ...options,
    userName: options.userName ?? 'voiceflow',
    extensions,
    defer: (task) => requests.getStore()?.waitUntil?.(task),
  });
  agent.attach(bot);

  const webhooks = bot.webhooks as Record<string, (request: Request, options?: WebhookOptions) => Promise<Response>>;
  return {
    bot,
    agent,
    slugs: Object.keys(adapters),
    webhook(slug, request, webhookOptions) {
      const handler = webhooks[slug];
      if (!handler) throw new ChannelsError('unknown_channel', `This bot has no "${slug}" channel.`);
      // A tool's call is checked by its pass; everything else is the platform's, checked by the adapter.
      if (isToolCall(request)) return agent.tools(request);
      return requests.run(webhookOptions, () => handler(request, webhookOptions));
    },
    tools: (request) => agent.tools(request),
  };
}
