// Written by scripts/channels.mjs: change the template there, not this file.
// A Voiceflow agent in GitLab. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's GitLab adapter.
import * as adapter from '@chat-adapter/gitlab';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';

export type { ChannelOptions as GitlabOptions } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. `connect gitlab` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('gitlab');

/**
 * GitLab as a channel for `createChannels`. It carries the GitLab adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads GITLAB_TOKEN and GITLAB_WEBHOOK_SIGNING_TOKEN unless you pass `adapter`.
 */
export function gitlab(options: ChannelOptions = {}): ChannelSpec {
  return channel('gitlab', adapter, options, { maxTextLength: 950000 });
}
