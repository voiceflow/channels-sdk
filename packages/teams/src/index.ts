// A Voiceflow agent in Microsoft Teams. Everything channel-neutral comes from
// @voiceflow/channelkit; this package adds what only Teams has.
import * as teamsAdapter from '@chat-adapter/teams';
import type { ChannelSpec } from '@voiceflow/channelkit';
import { createTeamsExtension, type TeamsOptions } from './extension.js';

export type { ConversationType, Place, TeamsActivity, TeamsAdapterLike, TeamsThreadId } from './adapter.js';
export { CONTEXT_VARIABLES, type ContextVariable } from './context.js';
export { createTeamsExtension, MAX_TEXT, type TeamsOptions } from './extension.js';
export { loggable, teamsLogger, withoutTokens } from './log.js';
export { forTeams, withoutOwnMention } from './text.js';

/**
 * Teams as a channel for `createChannels`, with everything only Teams has.
 * It carries the Teams adapter's module, imported here, so a bundled server
 * (Next.js, say) needs no adapter loaded by name.
 */
export function teams(options: TeamsOptions = {}): ChannelSpec {
  return { slug: 'teams', options: options.adapter, module: teamsAdapter, extension: createTeamsExtension(options) };
}
