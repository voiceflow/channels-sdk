// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Twilio. Everything channel-neutral comes from
// @voiceflow/channels-sdk; this package brings Chat SDK's Twilio adapter.
import * as adapter from '@chat-adapter/twilio';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channels-sdk';
import { adapterDefaults } from './platform.js';

export type { ChannelOptions as TwilioOptions } from '@voiceflow/channels-sdk';

/** Every variable this channel sets, with what it holds. `connect twilio` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('twilio');

/**
 * Twilio as a channel for `createChannels`. It carries the Twilio adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN unless you pass `adapter`.
 */
export function twilio(options: ChannelOptions = {}): ChannelSpec {
  return channel('twilio', adapter, options, { maxTextLength: 1500, plainText: true, adapterDefaults });
}
