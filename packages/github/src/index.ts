// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in GitHub. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's GitHub adapter.
import * as adapter from '@chat-adapter/github';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as GithubOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect github` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('github');

/**
 * GitHub as a channel for `createChannels`. It carries the GitHub adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads GITHUB_WEBHOOK_SECRET, GITHUB_BOT_USERNAME and GITHUB_TOKEN unless you pass `adapter`.
 */
export function github(options: ChannelOptions = {}): ChannelSpec {
  return channel('github', adapter, options, { maxTextLength: 65000 });
}
