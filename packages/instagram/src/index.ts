// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Instagram. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's Instagram adapter.
import * as adapter from '@chat-adapter/instagram';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as InstagramOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect instagram` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('instagram');

/**
 * Instagram as a channel for `createChannels`. It carries the Instagram adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_APP_SECRET, INSTAGRAM_VERIFY_TOKEN and INSTAGRAM_ACCOUNT_ID unless you pass `adapter`.
 */
export function instagram(options: ChannelOptions = {}): ChannelSpec {
  return channel('instagram', adapter, options, { maxTextLength: 333, plainText: true });
}
