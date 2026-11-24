// The Discord adapter's surface this package uses, typed structurally so it
// holds across adapter versions. Every call to Discord from your server goes
// through the adapter: this package never handles the bot's token there.
import type { Thread } from 'chat';

/** Where a conversation is: a server's channel, a thread in one, or a direct message (`guildId` is `@me`). */
export interface DiscordThreadId {
  guildId: string;
  channelId: string;
  threadId?: string;
}

export interface DiscordAdapterLike {
  readonly name: string;
  decodeThreadId(threadId: string): DiscordThreadId;
  encodeThreadId(data: DiscordThreadId): string;
  getUser(userId: string): Promise<{ fullName?: string; userName?: string } | null>;
  setThreadTitle(threadId: string, title: string): Promise<void>;
  /**
   * How the adapter opens a thread on a message, as it does for a mention. It
   * isn't in the adapter's public types, so it's used only where it's there:
   * without it a slash command is answered in the channel.
   */
  createDiscordThread?(channelId: string, messageId: string): Promise<{ id: string }>;
}

/** What the adapter builds for a message, before it is sent: the part of it this package reads. */
interface BuiltMessage {
  embedCount?: number;
  payload?: { embeds?: Record<string, unknown>[]; components?: unknown[] };
}

/** An embed with nothing to show: the adapter's colour and no more. */
const bare = (embed: Record<string, unknown>) => Object.keys(embed).every((key) => key === 'color' || key === 'type');

/**
 * Makes two of the adapter's messages ones Discord takes as they're meant.
 *
 * The adapter sends every card as an embed beside its buttons. A turn's choices are a card of buttons alone, so
 * the embed is empty, and Discord refuses the whole message (400, "embeds.0.description: This field is
 * required"): the empty embed is left out, and the buttons go as they are.
 *
 * And a card with no buttons, sent over one that had them, says nothing of buttons at all, so Discord keeps the
 * old ones: once a choice is made they'd stay there to be clicked. It is sent with none, which takes them off.
 *
 * Both are the adapter's to fix (docs/upstream.md). This reads how the adapter builds a message, which isn't in
 * its public types: where that has changed, nothing is patched, and a refused message still goes as text.
 */
export function fitMessages(adapter: unknown): void {
  const target = adapter as { buildMessagePayload?: (...args: unknown[]) => BuiltMessage | undefined };
  const build = target.buildMessagePayload;
  if (typeof build !== 'function') return;
  target.buildMessagePayload = function (this: unknown, ...args: unknown[]) {
    const built = build.apply(this, args);
    const payload = built?.payload;
    // Only a card has embeds: a message of text is left as it is.
    if (!built || !payload || !Array.isArray(payload.embeds)) return built;
    const buttons = payload.components ?? [];
    payload.components = buttons;
    if (buttons.length && payload.embeds.every(bare)) {
      payload.embeds = [];
      built.embedCount = 0;
    }
    return built;
  };
}

/** How the adapter asks Discord for something. Not in its public types. */
type AskDiscord = (path: string, method: string, body?: unknown) => Promise<Response>;

const STARTS_THREAD = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/;
/** How many threads named here are remembered: enough for the turns that follow at once. */
const NAMED_KEPT = 200;

export interface ThreadNames {
  /** The name for the thread about to be started on a message. */
  want(messageId: string, name: string): void;
  /** Whether a thread was given its name as it was made, so it needs no renaming. */
  made(threadId: string): boolean;
}

/**
 * Names a conversation's thread as it's made. The adapter makes every thread as "Thread" and the date, and a
 * rename afterwards leaves "changed the channel name" in the thread as its first line. So the name is put in as
 * the adapter asks Discord for the thread: the one asked for with `want`, or else what the message it starts
 * from says, read back from Discord.
 *
 * This goes through how the adapter calls Discord, which isn't in its public types (docs/upstream.md). Where
 * that has changed, or the message can't be read, the thread is made as the adapter names it, `made` says so,
 * and it is renamed afterwards.
 */
export function nameThreads(adapter: unknown, titleOf: (text: string) => string): ThreadNames {
  const wanted = new Map<string, string>();
  const named = new Set<string>();
  const names: ThreadNames = {
    want(messageId, name) {
      if (name) wanted.set(messageId, name);
    },
    made: (threadId) => named.has(threadId),
  };
  const target = adapter as { discordFetch?: AskDiscord };
  const ask = target.discordFetch;
  if (typeof ask !== 'function') return names;
  target.discordFetch = async function (this: unknown, path: string, method: string, body?: unknown) {
    const starts = method === 'POST' ? STARTS_THREAD.exec(path) : null;
    if (!starts) return ask.call(this, path, method, body);
    const [, channelId, messageId] = starts as unknown as [string, string, string];
    let name = wanted.get(messageId);
    wanted.delete(messageId);
    if (!name) {
      try {
        const message = (await (await ask.call(this, `/channels/${channelId}/messages/${messageId}`, 'GET')).json()) as { content?: string };
        name = titleOf(message.content ?? '');
      } catch {
        // The message can't be read (the bot may not see the channel's history): the adapter's name stands for now.
      }
    }
    if (!name) return ask.call(this, path, method, body);
    const response = await ask.call(this, path, method, { ...(body as Record<string, unknown>), name });
    // A thread started from a message has that message's ID.
    named.add(messageId);
    if (named.size > NAMED_KEPT) named.delete(named.values().next().value as string);
    return response;
  };
  return names;
}

export const SLUG = 'discord';
/** The guild part of a direct message's thread ID. */
export const DM_GUILD = '@me';

export function discordAdapter(thread: Thread<any, any>): DiscordAdapterLike {
  return thread.adapter as unknown as DiscordAdapterLike;
}

/** The Discord server, channel and thread a Chat SDK thread ID names. */
export function where(thread: Thread<any, any>): DiscordThreadId {
  return discordAdapter(thread).decodeThreadId(thread.id);
}
