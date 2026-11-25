// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in Notion. Everything channel-neutral comes from
// @voiceflow/channels-sdk; this package brings Chat SDK's Notion adapter.
import * as adapter from '@chat-adapter/notion';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channels-sdk';
import { text } from './platform.js';

export type { ChannelOptions as NotionOptions } from '@voiceflow/channels-sdk';

/** Every variable this channel sets, with what it holds. `connect notion` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('notion');

/**
 * Notion as a channel for `createChannels`. It carries the Notion adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads NOTION_TOKEN and NOTION_BOT_USERNAME unless you pass `adapter`.
 */
export function notion(options: ChannelOptions = {}): ChannelSpec {
  return channel('notion', adapter, options, { maxTextLength: 1900, text });
}
