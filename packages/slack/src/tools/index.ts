// Slack's default tool install: what `connect slack` (or installTools) puts on
// the agent. After that the tools are the agent's: edit, detach or delete them
// in Voiceflow, and later installs leave your changes alone.
import { requirementsOf, type ToolSet } from '@voiceflow/channels-sdk';
import { CONTEXT_VARIABLES } from '../context.js';
import { presentationTools } from './presentation.js';
import { workspaceTools } from './workspace.js';

export { presentationTools, PRESENTATION_TRACES, type PresentationTrace } from './presentation.js';
export { workspaceTools } from './workspace.js';

/** The secret the workspace tools call Slack with. */
export const SLACK_SECRETS = {
  slack_bot_token: "The Slack app's bot token (xoxb-…). The workspace tools call Slack with it.",
} as const;

export interface SlackToolsOptions {
  /** Include the workspace tools, which call Slack from Voiceflow with the bot token. Default: `true`. */
  workspace?: boolean;
  /** Include the presentation tools. Default: `true`. */
  presentation?: boolean;
}

/**
 * Slack's default install: the presentation tools (shown by this package) and
 * the workspace tools (which call Slack with the slack_bot_token secret), with
 * the slack_* variables they read.
 */
export function slackTools(options: SlackToolsOptions = {}): ToolSet {
  const workspace = options.workspace !== false;
  const tools = [...(options.presentation === false ? [] : presentationTools), ...(workspace ? workspaceTools : [])];
  return {
    channel: 'slack',
    variables: { ...CONTEXT_VARIABLES },
    ...(workspace ? { secrets: { ...SLACK_SECRETS } } : {}),
    tools,
  };
}

/** The OAuth scopes Slack's tools need, beyond what the bot itself needs. */
export function slackToolScopes(set: ToolSet = slackTools()): string[] {
  return requirementsOf(set.tools);
}
