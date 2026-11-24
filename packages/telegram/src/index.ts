// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Telegram. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's Telegram adapter.
import * as adapter from '@chat-adapter/telegram';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as TelegramOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect telegram` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('telegram');

/**
 * Telegram as a channel for `createChannels`. It carries the Telegram adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads TELEGRAM_BOT_TOKEN unless you pass `adapter`.
 */
export function telegram(options: ChannelOptions = {}): ChannelSpec {
  return channel('telegram', adapter, options, { maxTextLength: 4000, adapterDefaults: { mode: 'webhook' } });
}
