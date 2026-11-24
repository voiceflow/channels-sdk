// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Google Chat. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's Google Chat adapter.
import * as adapter from '@chat-adapter/gchat';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as GchatOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect gchat` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('gchat');

/**
 * Google Chat as a channel for `createChannels`. It carries the Google Chat adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads GOOGLE_CHAT_PROJECT_NUMBER and GOOGLE_CHAT_CREDENTIALS unless you pass `adapter`.
 */
export function gchat(options: ChannelOptions = {}): ChannelSpec {
  return channel('gchat', adapter, options, { maxTextLength: 4000, capabilities: { buttons: false } });
}
