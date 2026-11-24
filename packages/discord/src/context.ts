// Who the agent is talking to, and where: Discord context set as Voiceflow
// variables on every turn, for the agent's prompts. The model sees one only
// where the agent's instructions or global prompt reference it: a variable is
// stored data, not the model's context. Nothing trusts them.
import type { TurnContext } from '@voiceflow/channelkit';
import { DM_GUILD, discordAdapter, where } from './adapter.js';

/** Every variable this package sets, with what it holds. `connect discord` creates them on the agent. */
export const CONTEXT_VARIABLES = {
  discord_user_id: 'The Discord user ID of the person in this conversation.',
  discord_user_name: "The person's display name in Discord.",
  discord_user_handle: "The person's Discord username (their unique handle).",
  discord_guild_id: 'The Discord server (guild) ID. Empty in a direct message.',
  discord_channel_id: 'The Discord channel this conversation is in: for a thread, the channel it was started in.',
  discord_thread_id: "The Discord thread this conversation is in. Empty when it isn't in one.",
  discord_channel_type: 'channel, thread or dm.',
  discord_message_id: "The ID of the person's latest message. Empty when the turn came from a button or a slash command.",
} as const;

export type ContextVariable = keyof typeof CONTEXT_VARIABLES;

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

interface Person {
  name: string;
  handle: string;
}

export function createContext() {
  // Who someone is, kept a while: a button or a command says only their ID.
  const people = new Map<string, { value: Person; at: number }>();
  const remember = (id: string, value: Person) => {
    if (people.size >= MAX_ENTRIES && !people.has(id)) people.delete(people.keys().next().value!);
    people.set(id, { value, at: Date.now() });
    return value;
  };

  /**
   * The turn's context variables: every one, every turn, empty when unknown. A
   * variable left out would keep its value from an earlier turn on the
   * session, perhaps someone else's. Never throws.
   */
  return async function variables(ctx: TurnContext): Promise<Record<ContextVariable, string>> {
    const out = Object.fromEntries(Object.keys(CONTEXT_VARIABLES).map((k) => [k, ''])) as Record<ContextVariable, string>;
    const author = ctx.message?.author;
    const userId = ctx.userId ?? author?.userId ?? '';
    out.discord_user_id = userId;
    out.discord_message_id = ctx.message?.id ?? '';
    try {
      const at = where(ctx.thread);
      const dm = at.guildId === DM_GUILD;
      out.discord_guild_id = dm ? '' : at.guildId;
      out.discord_channel_id = at.channelId;
      out.discord_thread_id = at.threadId ?? '';
      out.discord_channel_type = dm ? 'dm' : at.threadId ? 'thread' : 'channel';
    } catch {
      // Where the turn is couldn't be read: those stay empty.
    }
    if (!userId) return out;
    let person: Person | undefined;
    if (author && author.userId === userId) {
      // The message says who wrote it: nothing to look up.
      person = remember(userId, { name: author.fullName || author.userName || '', handle: author.userName || '' });
    } else {
      const hit = people.get(userId);
      if (hit && Date.now() - hit.at < TTL_MS) person = hit.value;
      else {
        const found = await discordAdapter(ctx.thread)
          .getUser(userId)
          .catch(() => null);
        if (found) person = remember(userId, { name: found.fullName || found.userName || '', handle: found.userName || '' });
      }
    }
    out.discord_user_name = person?.name ?? '';
    out.discord_user_handle = person?.handle ?? '';
    return out;
  };
}
