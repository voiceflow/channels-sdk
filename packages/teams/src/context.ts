// Who the agent is talking to, and where: Teams context set as Voiceflow
// variables on every turn, for the agent's prompts. The model sees one only
// where the agent's instructions or global prompt reference it: a variable is
// stored data, not the model's context. Nothing trusts them.
import type { TurnContext } from '@voiceflow/channelkit';
import { type TeamsActivity, teamsAdapter, where } from './adapter.js';

/** Every variable this package sets, with what it holds. `connect teams` creates them on the agent. */
export const CONTEXT_VARIABLES = {
  teams_user_id: "The person's ID in Teams, as this bot knows them (29:…).",
  teams_user_aad_id: "The person's Microsoft Entra object ID: the same in every app of their organization.",
  teams_user_name: "The person's name in Teams.",
  teams_user_email: "The person's email address in Teams. Empty when Teams doesn't say.",
  teams_tenant_id: "The ID of the person's Microsoft 365 organization (tenant).",
  teams_team_id: "The team's ID. Empty outside a team's channel.",
  teams_channel_id: "The channel's ID. Empty outside a team's channel.",
  teams_conversation_type: 'personal (a chat with the bot), channel or groupChat.',
  teams_message_id: "The ID of the person's latest message. Empty when the turn came from a button.",
} as const;

export type ContextVariable = keyof typeof CONTEXT_VARIABLES;

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

interface Person {
  name: string;
  email: string;
  aadId: string;
}

interface Team {
  tenantId: string;
  teamId: string;
  channelId: string;
}

/** A small store of what a message said, kept a while: a button's click says less. */
function kept<T>() {
  const entries = new Map<string, { value: T; at: number }>();
  return {
    get(key: string): T | undefined {
      const hit = entries.get(key);
      return hit && Date.now() - hit.at < TTL_MS ? hit.value : undefined;
    },
    set(key: string, value: T): T {
      if (entries.size >= MAX_ENTRIES && !entries.has(key)) entries.delete(entries.keys().next().value!);
      entries.set(key, { value, at: Date.now() });
      return value;
    },
  };
}

export function createContext() {
  const people = kept<Person>();
  const teams = kept<Team>();

  /**
   * The turn's context variables: every one, every turn, empty when unknown. A
   * variable left out would keep its value from an earlier turn on the
   * session, perhaps someone else's. Never throws.
   */
  return async function variables(ctx: TurnContext): Promise<Record<ContextVariable, string>> {
    const out = Object.fromEntries(Object.keys(CONTEXT_VARIABLES).map((k) => [k, ''])) as Record<ContextVariable, string>;
    const author = ctx.message?.author;
    const activity = (ctx.message?.raw ?? undefined) as TeamsActivity | undefined;
    const userId = ctx.userId ?? author?.userId ?? '';
    out.teams_user_id = userId;
    out.teams_message_id = ctx.message?.id ?? '';
    let conversationId = '';
    try {
      const at = where(ctx.thread);
      conversationId = at.conversationId;
      out.teams_conversation_type = at.type;
    } catch {
      // Where the turn is couldn't be read: those stay empty.
    }
    // A message says its organization, team and channel; a button's click is read from the last message there.
    const said = activity?.channelData;
    const team =
      said || activity?.conversation
        ? teams.set(conversationId, {
            tenantId: said?.tenant?.id ?? activity?.conversation?.tenantId ?? '',
            teamId: said?.team?.id ?? said?.teamsTeamId ?? '',
            channelId: said?.channel?.id ?? said?.teamsChannelId ?? '',
          })
        : teams.get(conversationId);
    out.teams_tenant_id = team?.tenantId ?? '';
    // Only a team's channel has a team: a chat's own ID is no channel's.
    if (out.teams_conversation_type === 'channel' || (!out.teams_conversation_type && team?.teamId)) {
      out.teams_team_id = team?.teamId ?? '';
      out.teams_channel_id = team?.channelId || conversationId;
    }
    if (!userId) return out;
    let person: Person | undefined;
    if (author && author.userId === userId) {
      // The message says who wrote it: nothing to look up. The adapter has put their email on it, where Teams gave one.
      person = people.set(userId, {
        name: author.fullName || activity?.from?.name || '',
        email: (author as { email?: string }).email ?? '',
        aadId: activity?.from?.aadObjectId ?? '',
      });
    } else {
      person = people.get(userId);
      if (!person) {
        const found = await teamsAdapter(ctx.thread)
          .getUser(userId)
          .catch(() => null);
        if (found) person = people.set(userId, { name: found.fullName || '', email: found.email ?? '', aadId: '' });
      }
    }
    out.teams_user_name = person?.name ?? '';
    out.teams_user_email = person?.email ?? '';
    out.teams_user_aad_id = person?.aadId ?? '';
    return out;
  };
}
