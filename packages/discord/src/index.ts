// A Voiceflow agent in Discord. Everything channel-neutral comes from
// @voiceflow/channels-sdk; this package adds what only Discord has.
import * as discordAdapter from '@chat-adapter/discord';
import type { ChannelSpec } from '@voiceflow/channels-sdk';
import { createDiscordExtension, type DiscordOptions } from './extension.js';

export type { DiscordAdapterLike, DiscordThreadId } from './adapter.js';
export { CONTEXT_VARIABLES, type ContextVariable } from './context.js';
export { createDiscordExtension, type DiscordOptions, titleOf } from './extension.js';
export { type ForwardGatewayOptions, forwardGateway } from './gateway.js';

/**
 * Discord as a channel for `createChannels`, with everything only Discord has.
 * It carries the Discord adapter's module, imported here, so a bundled server
 * (Next.js, say) needs no adapter loaded by name.
 */
export function discord(options: DiscordOptions = {}): ChannelSpec {
  return { slug: 'discord', options: options.adapter, module: discordAdapter, extension: createDiscordExtension(options) };
}
