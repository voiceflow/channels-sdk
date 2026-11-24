// The Teams adapter's surface this package uses, typed structurally so it
// holds across adapter versions. Every call to Teams from your server goes
// through the adapter: this package never handles the bot's secret there.
import type { Thread } from 'chat';

export const SLUG = 'teams';

/** Where a conversation is, as the adapter names it. */
export interface TeamsThreadId {
  /** Teams' conversation ID. In a team's channel it ends `;messageid=<the post the thread hangs from>`. */
  conversationId: string;
  conversationType?: ConversationType;
  serviceUrl: string;
}

/** The three places a Teams bot talks: a chat with one person, a team's channel, a chat with several. */
export type ConversationType = 'personal' | 'channel' | 'groupChat';

export interface TeamsAdapterLike {
  readonly name: string;
  decodeThreadId(threadId: string): TeamsThreadId;
  isDM(threadId: string): boolean;
  getUser(userId: string): Promise<{ fullName?: string; userName?: string; email?: string } | null>;
}

/** What Teams sends for a message: the parts of it this package reads. The adapter keeps it as the message's `raw`. */
export interface TeamsActivity {
  from?: { id?: string; name?: string; aadObjectId?: string };
  /** The bot, as this conversation knows it. */
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string }; team?: { id?: string }; channel?: { id?: string }; teamsTeamId?: string; teamsChannelId?: string };
  entities?: { type?: string; text?: string; mentioned?: { id?: string; name?: string } }[];
}

export function teamsAdapter(thread: Thread<any, any>): TeamsAdapterLike {
  return thread.adapter as unknown as TeamsAdapterLike;
}

/** What a channel's conversation ID ends with: the post its thread hangs from. */
const ROOT = /;messageid=(\d+)$/;

export interface Place {
  /** Teams' conversation ID, without a channel thread's `;messageid=`. */
  conversationId: string;
  type: ConversationType;
  /** In a channel: the post the thread hangs from. */
  rootId: string;
}

/** The Teams conversation a Chat SDK thread ID names, and which of the three kinds it is. */
export function where(thread: Thread<any, any>): Place {
  const adapter = teamsAdapter(thread);
  const at = adapter.decodeThreadId(thread.id);
  const rootId = ROOT.exec(at.conversationId)?.[1] ?? '';
  const conversationId = at.conversationId.replace(ROOT, '');
  // A thread ID doesn't say which kind it is. A chat with one person is the adapter's to know; a team's channel
  // is the kind whose conversations are threads on a post, or carry a channel's ID (`…@thread.tacv2`, or the older `…@thread.skype`).
  const type: ConversationType =
    at.conversationType ?? (adapter.isDM(thread.id) ? 'personal' : rootId || /@thread\.(tacv2|skype)$/.test(conversationId) ? 'channel' : 'groupChat');
  return { conversationId, type, rootId };
}
