// The one-call setup: a Chat SDK bot with the named channels, answered by a
// Voiceflow agent. Every adapter comes from the catalog (tier 1).
import { Chat, type Adapter, type ChatConfig, type StateAdapter, type WebhookOptions } from 'chat';
import { createVoiceflowAgent, type VoiceflowAgent, type VoiceflowAgentOptions } from './agent.js';
import { ChannelsError } from './errors.js';
import { loadAdapter, type Importer } from './loader.js';

export type ChannelSpec =
  | string
  | {
      slug: string;
      /** The adapter's own config. Omit it to let the adapter read its env vars. */
      options?: Record<string, unknown>;
      /** An adapter you built yourself; used as-is instead of loading from the catalog. */
      adapter?: Adapter;
    };

export interface ChannelsOptions extends VoiceflowAgentOptions {
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
  /** Handles a platform's webhook request. */
  webhook(slug: string, request: Request, options?: WebhookOptions): Promise<Response>;
}

export async function createChannels(options: ChannelsOptions): Promise<Channels> {
  const adapters: Record<string, Adapter> = {};
  for (const spec of options.channels) {
    const { slug, options: adapterOptions, adapter } = typeof spec === 'string' ? { slug: spec } : spec as Extract<ChannelSpec, object>;
    adapters[slug] = adapter ?? (await loadAdapter(slug, { options: adapterOptions, importer: options.importer }));
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

  const agent = createVoiceflowAgent({ ...options, userName: options.userName ?? 'voiceflow' });
  agent.attach(bot);

  const webhooks = bot.webhooks as Record<string, (request: Request, options?: WebhookOptions) => Promise<Response>>;
  return {
    bot,
    agent,
    slugs: Object.keys(adapters),
    webhook(slug, request, webhookOptions) {
      const handler = webhooks[slug];
      if (!handler) throw new ChannelsError('unknown_channel', `This bot has no "${slug}" channel.`);
      return handler(request, webhookOptions);
    },
  };
}
