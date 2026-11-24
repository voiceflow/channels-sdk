// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in WhatsApp Business Cloud. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's WhatsApp Business Cloud adapter.
import * as adapter from '@chat-adapter/whatsapp';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as WhatsappOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect whatsapp` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('whatsapp');

/**
 * WhatsApp Business Cloud as a channel for `createChannels`. It carries the WhatsApp Business Cloud adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_VERIFY_TOKEN unless you pass `adapter`.
 */
export function whatsapp(options: ChannelOptions = {}): ChannelSpec {
  return channel('whatsapp', adapter, options, { maxTextLength: 4000, capabilities: { maxButtons: 3 } });
}
