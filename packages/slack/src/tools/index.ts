// Slack's default tool install: what `connect slack` (or installTools) puts on
// the agent. After that the tools are the agent's: edit, detach or delete them
// in Voiceflow, and later installs leave your changes alone.
import { requirementsOf, type ToolSet } from '@voiceflow/channels-sdk';
import { CONTEXT_VARIABLES } from '../context.js';
import { presentationTools } from './presentation.js';

export { presentationTools, PRESENTATION_TRACES, type PresentationTrace } from './presentation.js';

/** Slack's tools: the presentation tools, which need nothing but this package, and the variables they read. */
export function slackTools(): ToolSet {
  const tools = [...presentationTools];
  return {
    channel: 'slack',
    variables: { ...CONTEXT_VARIABLES },
    tools,
  };
}

/** The OAuth scopes Slack's tools need, beyond what the bot itself needs. */
export function slackToolScopes(set: ToolSet = slackTools()): string[] {
  return requirementsOf(set.tools);
}
