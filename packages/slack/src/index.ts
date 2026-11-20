// Voiceflow agents in Slack at full fidelity. Everything channel-neutral
// comes from @voiceflow/channels-sdk; this package adds what only Slack has.
import type { ChannelSpec } from '@voiceflow/channels-sdk';
import { createSlackExtension, type SlackOptions } from './extension.js';

export { createSlackExtension, DEFAULT_HOME_TEXT, type SlackOptions } from './extension.js';
export { CONTEXT_VARIABLES, type ContextVariable } from './context.js';
export type { SlackAdapterLike } from './adapter.js';

/** Slack as a channel for `createChannels`, with everything only Slack has. */
export function slack(options: SlackOptions = {}): ChannelSpec {
  return { slug: 'slack', options: options.adapter, extension: createSlackExtension(options) };
}
