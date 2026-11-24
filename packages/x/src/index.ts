// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in X. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's X adapter.
import * as adapter from '@chat-adapter/x';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as XOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect x` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('x');

/**
 * X as a channel for `createChannels`. It carries the X adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads X_CONSUMER_SECRET and X_USER_ACCESS_TOKEN unless you pass `adapter`.
 */
export function x(options: ChannelOptions = {}): ChannelSpec {
  return channel('x', adapter, options, { maxTextLength: 10000 });
}
