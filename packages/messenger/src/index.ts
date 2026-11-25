// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Messenger. Everything channel-neutral comes from
// @voiceflow/channels-sdk; this package brings Chat SDK's Messenger adapter.
import * as adapter from '@chat-adapter/messenger';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channels-sdk';

export type { ChannelOptions as MessengerOptions } from '@voiceflow/channels-sdk';

/** Every variable this channel sets, with what it holds. `connect messenger` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('messenger');

/**
 * Messenger as a channel for `createChannels`. It carries the Messenger adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads FACEBOOK_APP_SECRET, FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_VERIFY_TOKEN unless you pass `adapter`.
 */
export function messenger(options: ChannelOptions = {}): ChannelSpec {
  return channel('messenger', adapter, options, { maxTextLength: 2000, plainText: true });
}
