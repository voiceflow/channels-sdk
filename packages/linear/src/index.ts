// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Linear. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's Linear adapter.
import * as adapter from '@chat-adapter/linear';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as LinearOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect linear` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('linear');

/**
 * Linear as a channel for `createChannels`. It carries the Linear adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads LINEAR_WEBHOOK_SECRET, LINEAR_BOT_USERNAME and LINEAR_API_KEY unless you pass `adapter`.
 */
export function linear(options: ChannelOptions = {}): ChannelSpec {
  return channel('linear', adapter, options);
}
