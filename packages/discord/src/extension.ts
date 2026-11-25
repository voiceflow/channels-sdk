// Discord, with what only Discord has: who and where as variables, threads
// named after what was asked, and a slash command. Each part can be turned
// off in `discord()`'s options; what the agent does with it stays in Voiceflow.
//
// Mentions, threads, direct messages, buttons, cards and carousels need
// nothing here: the channel-neutral agent and the Discord adapter do them.
import type { ChannelExtension, ExtensionHost } from '@voiceflow/channels-sdk';
import type { Chat, Thread } from 'chat';
import { type DiscordAdapterLike, DM_GUILD, discordAdapter, fitMessages, nameThreads, SLUG, type ThreadNames, where } from './adapter.js';
import { createContext } from './context.js';
import { discordLogger } from './log.js';

type AnyThread = Thread<any, any>;

export interface DiscordOptions {
  /**
   * The Discord adapter's own config (`botToken`, `publicKey`, `applicationId`,
   * `respondToChannelIds`, `logger`, …). Omit it to let the adapter read
   * DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY and DISCORD_APPLICATION_ID.
   */
  adapter?: Record<string, unknown>;
  /**
   * Set who and where as `discord_*` variables on every turn, for the agent's
   * prompts. Default: `true`. The agent sees one only where its instructions
   * or global prompt reference it (`{discord_user_name}`).
   */
  context?: boolean;
  /**
   * Name the thread opened for a conversation after the person's first
   * message, in place of the adapter's "Thread" and the date. Only a thread
   * opened for the conversation is named, never one people made. Default: `true`.
   */
  titles?: boolean;
  /**
   * Answer the app's slash command: `/ask question: what's our refund policy?`
   * posts the question and answers in a thread on it. Default: `true`.
   */
  slashCommands?: boolean;
}

/** Discord's limit on a thread's name. */
const MAX_TITLE = 100;
/** The longest text sent as one message: under Discord's 2,000 characters. */
const MAX_TEXT = 1900;

export function createDiscordExtension(options: DiscordOptions = {}): ChannelExtension {
  let host: ExtensionHost | undefined;
  let threads: ThreadNames | undefined;
  const context = createContext();

  const extension: ChannelExtension = {
    slug: SLUG,
    // The adapter logs every event it's passed, and Discord's connection passes on a great many that aren't for the
    // bot (a server's every message, each person typing). So only its warnings and errors are printed, a request
    // with a bad signature is one line, and no interaction's token is printed: unless you give it a logger of your own.
    adapterDefaults: { logger: discordLogger() },
    // Discord takes 2,000 characters in a message, and the adapter cuts a longer one short without a word. A long
    // answer goes as several messages instead, with room left for what the adapter's formatting can add.
    maxTextLength: MAX_TEXT,

    // Never throws: a failed hook would send no variables, and the session would keep the last turn's.
    ...(options.context === false ? {} : { variables: (ctx) => context(ctx) }),

    async turnStarted(ctx) {
      if (options.titles === false || !ctx.message) return;
      // A thread started from a message has that message's ID. So this is the conversation's first message,
      // and the thread is the one opened for it: the only one this renames.
      if (where(ctx.thread).threadId !== ctx.message.id) return;
      // Named as it was made, which is the usual way: a rename would only add "changed the channel name" to it.
      if (threads?.made(ctx.message.id)) return;
      const title = titleOf(ctx.message.text ?? '');
      if (title) await discordAdapter(ctx.thread).setThreadTitle(ctx.thread.id, title);
    },

    attach(bot, lent) {
      host = lent;
      fitMessages(bot.getAdapter(SLUG));
      if (options.titles !== false) threads = nameThreads(bot.getAdapter(SLUG), titleOf);
      if (options.slashCommands !== false) attachSlashCommands(bot, lent);
    },
  };

  function attachSlashCommands(bot: Chat<any, any>, lent: ExtensionHost) {
    bot.onSlashCommand(async (event) => {
      if (event.adapter.name !== SLUG) return;
      const adapter = event.adapter as unknown as DiscordAdapterLike;
      const text = event.text.trim();
      try {
        // Discord shows "thinking…" until the command is answered: the first post in its channel is that answer.
        if (!text) {
          await firstAnswer(() => event.channel.post(`Ask a question with the command: \`${event.command} question: what's our refund policy?\``));
          return;
        }
        // The question is posted where everyone can see it, so the answer has a thread to live in.
        const asked = await firstAnswer(() => event.channel.post(`<@${event.user.userId}> asked: ${text}`));
        const at = adapter.decodeThreadId(event.channel.id);
        let thread = bot.thread(event.channel.id) as AnyThread;
        let own = at.guildId === DM_GUILD || Boolean(at.threadId);
        // In a server's channel the answer gets a thread of its own, as a mention's does. A direct message, and a
        // thread, are a conversation's own place already.
        if (!own && typeof adapter.createDiscordThread === 'function') {
          try {
            // The thread is on the bot's own message, which says who asked: its name is the question alone.
            threads?.want(asked.id, titleOf(text));
            const made = await adapter.createDiscordThread(at.channelId, asked.id);
            thread = bot.thread(adapter.encodeThreadId({ ...at, threadId: made.id })) as AnyThread;
            own = true;
            if (options.titles !== false && !threads?.made(made.id)) {
              await adapter.setThreadTitle(thread.id, titleOf(text)).catch((error) => lent.report(error, { thread }));
            }
          } catch (error) {
            // No thread could be opened (the bot may lack the permission): the answer goes in the channel.
            lent.report(error, { thread });
          }
        }
        // Only a conversation's own place is followed: in an open channel, every message would otherwise be one for the agent.
        if (own) await thread.subscribe();
        await lent.run(thread, { type: 'text', payload: text }, { userId: event.user.userId });
      } catch (error) {
        (host ?? lent).report(error);
      }
    });
  }

  return extension;
}

/** How Discord refuses an answer to an interaction it doesn't know: its code, and its words. */
const UNKNOWN_WEBHOOK = /\b10015\b|Unknown Webhook/;
/** How long to wait before each further try, in milliseconds: three seconds in all. */
const FIRST_ANSWER_WAITS = [200, 400, 800, 1600];

/**
 * A slash command's first answer. Discord is told "thinking…" in the reply to its own request, and takes an
 * answer only once it has that reply. An answer sent at once can get there first, most of all when the request
 * came the long way round (a tunnel, a proxy): Discord refuses it as an unknown webhook, and the person is left
 * looking at "thinking…". So that one refusal is tried again, for a few seconds.
 */
async function firstAnswer<T>(post: () => Promise<T>): Promise<T> {
  for (const wait of FIRST_ANSWER_WAITS) {
    try {
      return await post();
    } catch (error) {
      if (!UNKNOWN_WEBHOOK.test(error instanceof Error ? error.message : String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return post();
}

/** What someone asked, as a thread's name: without the mention it began with, on one line, cut at a word. */
export function titleOf(text: string): string {
  const line = text
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(@\S+\s+)+/, '');
  if (line.length <= MAX_TITLE) return line;
  const cut = line.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
