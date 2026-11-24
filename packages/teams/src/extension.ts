// Teams, with what only Teams has: who and where as variables, the bot's own
// mention taken out of what people write, headings Teams can show, and long
// answers in more than one message. Each part can be turned off in `teams()`'s
// options; what the agent does with it stays in Voiceflow.
//
// Chats, channel threads, buttons, cards and carousels need nothing here: the
// channel-neutral agent and the Teams adapter do them.
import type { ChannelExtension } from '@voiceflow/channels-sdk';
import { SLUG, type TeamsActivity } from './adapter.js';
import { createContext } from './context.js';
import { teamsLogger } from './log.js';
import { forTeams, withoutOwnMention } from './text.js';

export interface TeamsOptions {
  /**
   * The Teams adapter's own config (`appId`, `appPassword`, `appTenantId`,
   * `logger`, …). Omit it to let the adapter read TEAMS_APP_ID,
   * TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID.
   */
  adapter?: Record<string, unknown>;
  /**
   * Set who and where as `teams_*` variables on every turn, for the agent's
   * prompts. Default: `true`. The agent sees one only where its instructions
   * or global prompt reference it (`{teams_user_name}`).
   */
  context?: boolean;
  /**
   * Send a heading as a bold line: Teams shows no headings, and the adapter
   * would send one as plain words. Default: `true`.
   */
  headings?: boolean;
}

/**
 * The longest text sent as one message. Teams refuses a message that is too large whole (HTTP 413), and the
 * person gets an apology in place of the answer: seen at 110,000 characters, with 60,000 let through. Microsoft
 * puts the limit near 28 KB, counted in bytes with everything else the message carries. This keeps a message of
 * plain text under it, and one in a script of three bytes a character well under what Teams was seen to take.
 */
export const MAX_TEXT = 20_000;

export function createTeamsExtension(options: TeamsOptions = {}): ChannelExtension {
  const context = createContext();
  return {
    slug: SLUG,
    // The adapter logs each request and each call, and logs a failed call with the request that made it, the bot's
    // access token included. So only its warnings and errors are printed, each a line, with no token in it:
    // unless you give it a logger of your own.
    adapterDefaults: { logger: teamsLogger() },
    maxTextLength: MAX_TEXT,

    // Never throws: a failed hook would send no variables, and the session would keep the last turn's.
    ...(options.context === false ? {} : { variables: (ctx) => context(ctx) }),

    // In a channel a person reaches the bot by its mention, which is no part of what they're asking.
    input: (text, ctx) => withoutOwnMention(text, (ctx.message?.raw ?? undefined) as TeamsActivity | undefined),

    ...(options.headings === false ? {} : { text: forTeams }),
  };
}
