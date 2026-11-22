// Slack's default tool install: what `connect slack` (or installTools) puts on
// the agent. After that the tools are the agent's: edit, detach or delete them
// in Voiceflow, and later installs leave your changes alone.
import {
  requirementsOf,
  SERVER_TOOL_SECRETS,
  SERVER_TOOL_VARIABLES,
  serverToolDefinition,
  type ToolDefinition,
  type ToolSet,
} from '@voiceflow/channels-sdk';
import { CONTEXT_VARIABLES } from '../context.js';
import { createWorkspaceTools } from '../workspace.js';
import { presentationTools } from './presentation.js';

export { PRESENTATION_TRACES, type PresentationTrace, presentationTools } from './presentation.js';

/**
 * The workspace tools as the agent holds them: one small function each, which
 * passes the call to your server. The tools themselves run there (`createWorkspaceTools`).
 */
export const workspaceTools: ToolDefinition[] = createWorkspaceTools().map(serverToolDefinition);

/** The secret Slack's tools called Slack with before they ran on your server. An install says so when it is still on the project. */
export const RETIRED_SECRETS = {
  slack_bot_token: "Slack's tools ran in Voiceflow with it before; they run on your server now, with the server's own token, and nothing here reads it.",
} as const;

export interface SlackToolsOptions {
  /** Include the workspace tools, which act in Slack from your server. Default: `true`. */
  workspace?: boolean;
  /** Include the presentation tools. Default: `true`. */
  presentation?: boolean;
}

/**
 * Slack's default install: the presentation tools (shown by this package) and
 * the workspace tools (run by your server), with the variables they read. No
 * Slack credential goes to Voiceflow.
 */
export function slackTools(options: SlackToolsOptions = {}): ToolSet {
  const workspace = options.workspace !== false;
  const tools = [...(options.presentation === false ? [] : presentationTools), ...(workspace ? workspaceTools : [])];
  return {
    channel: 'slack',
    variables: { ...CONTEXT_VARIABLES, ...(workspace ? SERVER_TOOL_VARIABLES : {}) },
    ...(workspace ? { secrets: { ...SERVER_TOOL_SECRETS } } : {}),
    retiredSecrets: { ...RETIRED_SECRETS },
    tools,
  };
}

/** The OAuth scopes Slack's tools need, beyond what the bot itself needs. */
export function slackToolScopes(set: ToolSet = slackTools()): string[] {
  return requirementsOf(set.tools);
}
