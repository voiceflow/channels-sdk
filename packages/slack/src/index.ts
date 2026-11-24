// Voiceflow agents in Slack. Everything channel-neutral
// comes from @voiceflow/channels-sdk; this package adds what only Slack has.
import * as slackAdapter from '@chat-adapter/slack';
import type { ChannelSpec } from '@voiceflow/channels-sdk';
import { createSlackExtension, type SlackOptions } from './extension.js';

export type { SlackAdapterLike } from './adapter.js';
export { CONTEXT_VARIABLES, type ContextVariable } from './context.js';
export { createSlackExtension, DEFAULT_HOME_TEXT, type SlackOptions } from './extension.js';
export { answersText, FORM_ACTION_ID, type FormField } from './presentation.js';
export {
  PRESENTATION_TRACES,
  type PresentationTrace,
  presentationTools,
  RETIRED_SECRETS,
  type SlackToolsOptions,
  slackToolScopes,
  slackTools,
  workspaceTools,
} from './tools/index.js';
export { createWorkspaceTools, type WorkspaceToolsOptions } from './workspace.js';

/**
 * Slack as a channel for `createChannels`, with everything only Slack has. It
 * carries the Slack adapter's module, imported here, so a bundled server
 * (Next.js, say) needs no adapter loaded by name.
 */
export function slack(options: SlackOptions = {}): ChannelSpec {
  return { slug: 'slack', options: options.adapter, module: slackAdapter, extension: createSlackExtension(options) };
}
