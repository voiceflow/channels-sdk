// Slack at full fidelity: everything Slack has that the channel-neutral agent
// doesn't, on by default. Each part can be turned off in `slack()`'s options;
// what the agent does with it stays in Voiceflow.
import type { Chat, ReactionEvent, Thread } from 'chat';
import type { ChannelExtension, ExtensionHost, PinPrompts, TurnContext } from '@voiceflow/channels-sdk';
import { SLUG, slackAdapter, where, type SlackAdapterLike } from './adapter.js';
import { createContext } from './context.js';
import { attachFormEvents, presentation } from './presentation.js';

type AnyThread = Thread<any, any>;

export interface SlackOptions {
  /**
   * The Slack adapter's own config (`botToken`, `signingSecret`, …). Omit it to
   * let the adapter read SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.
   */
  adapter?: Record<string, unknown>;
  /**
   * When someone opens the assistant panel, run the agent's launch turn: its
   * messages are posted and up to four of its buttons become suggested prompts.
   * Default: `true`.
   */
  launchOnOpen?: boolean;
  /** Name the assistant panel's thread after the person's first message, as Slack's history lists it. Default: `true`. */
  titles?: boolean;
  /**
   * The reaction on a person's message while the agent works on it, taken off
   * when the reply is done. Not in the assistant panel, which shows its own
   * status. `null` for none. Default: `eyes` (👀).
   */
  workingReaction?: string | null;
  /** A reaction left on the person's message once the reply is done. Default: none. */
  doneReaction?: string | null;
  /**
   * When the agent is first mentioned partway through a thread, it reads up to
   * this many earlier messages there, so it joins the conversation knowing it.
   * `false` for none. Default: 20.
   */
  catchUp?: number | false;
  /**
   * Set who and where as `slack_*` variables on every turn. Default: `true`.
   * The Slack tools read them; the agent sees one only where its instructions
   * or global prompt reference it (`{slack_user_name}`).
   */
  context?: boolean;
  /**
   * Slack's 👍 / 👎 feedback buttons under each streamed answer. A click
   * reaches `onFeedback` and is not a turn. `true` for Slack's labels ("Good
   * response", "Bad response"), or your own. Default: off.
   */
  feedbackButtons?: boolean | { positiveLabel?: string; negativeLabel?: string };
  /** A 👍 or 👎 reaction someone adds to one of the agent's messages reaches `onFeedback`. Nothing shows in Slack. Default: `true`. */
  feedbackReactions?: boolean;
  /** Called for every reaction someone adds or removes, after any feedback is recorded. */
  onReaction?: (event: ReactionEvent) => void | Promise<void>;
  /**
   * Answer the app's slash commands: `/ask what's our refund policy?` posts the
   * question in the channel and answers in its thread. Default: `true`.
   */
  slashCommands?: boolean;
  /** The App Home tab's text (Slack mrkdwn), or `false` to leave the tab alone. */
  home?: { text?: string } | false;
}

interface SlackThreadState {
  /** The thread is the assistant panel's. */
  assistant?: boolean;
  /** The channel the person has open beside the assistant panel. */
  viewing?: string;
  /** The assistant thread has been named. */
  titled?: boolean;
}

/** Slack shows at most four suggested prompts. */
const MAX_PROMPTS = 4;
const MAX_TITLE = 60;
const MAX_LINE = 500;
const MAX_CATCH_UP = 4000;
const POSITIVE = new Set(['+1', 'thumbsup']);
const NEGATIVE = new Set(['-1', 'thumbsdown']);
/** The action the feedback buttons send, which `onFeedback` listens for. */
const FEEDBACK_ACTION = 'message_feedback';
export const DEFAULT_HOME_TEXT = "Message me here in the *Messages* tab, or mention me in a channel I'm in.";

export function createSlackExtension(options: SlackOptions = {}): ChannelExtension {
  let host: ExtensionHost | undefined;
  const context = createContext();
  const reacted = new WeakMap<TurnContext, string>();
  /** Reactions the agent added with slack_react (`<message>:<emoji>`), which the working reaction must not take off. */
  const kept = new Set<string>();
  const catchUp = options.catchUp === undefined ? 20 : options.catchUp;
  const working = options.workingReaction === undefined ? 'eyes' : options.workingReaction;

  const stateOf = async (thread: AnyThread) => (await host?.getState<SlackThreadState>(thread)) ?? {};
  const update = async (thread: AnyThread, change: SlackThreadState) => host?.setState(thread, { ...(await stateOf(thread)), ...change });

  const extension: ChannelExtension = {
    slug: SLUG,
    // Slack's own thumbs up / down under each streamed answer, when asked for.
    adapterDefaults: { feedbackButtons: feedbackButtons(options.feedbackButtons) },
    feedbackActionId: FEEDBACK_ACTION,

    variables: options.context === false ? undefined : async (ctx) => context(ctx, (await stateOf(ctx.thread)).viewing),

    async input(text, ctx) {
      if (!ctx.isNew || !ctx.message || catchUp === false || catchUp <= 0) return text;
      const adapter = slackAdapter(ctx.thread);
      const { threadTs } = where(ctx.thread);
      // A message that starts its own thread has nothing before it.
      if (!threadTs || ctx.message.id === threadTs) return text;
      const { messages } = await adapter.fetchMessages(ctx.thread.id, { limit: catchUp + 1, direction: 'backward' });
      const earlier = messages
        .filter((m) => m.id !== ctx.message!.id && (m.text ?? '').trim())
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(-catchUp);
      if (!earlier.length) return text;
      const lines: string[] = [];
      let size = 0;
      // The newest messages matter most, so the budget is spent from the end.
      for (const m of [...earlier].reverse()) {
        const who = m.author.isMe ? 'Assistant' : m.author.fullName || m.author.userName || m.author.userId;
        const line = `${who}: ${oneLine(m.text ?? '').slice(0, MAX_LINE)}`;
        if (size + line.length > MAX_CATCH_UP) break;
        lines.unshift(line);
        size += line.length;
      }
      return `Earlier in this Slack thread:\n${lines.join('\n')}\n\nThe message to answer:\n${text}`;
    },

    async turnStarted(ctx) {
      const state = await stateOf(ctx.thread);
      const adapter = slackAdapter(ctx.thread);
      if (state.assistant) {
        if (options.titles !== false && !state.titled && ctx.message?.text?.trim()) {
          const { channel, threadTs } = where(ctx.thread);
          await update(ctx.thread, { titled: true });
          await adapter.setAssistantTitle(channel, threadTs, titleOf(ctx.message.text));
        }
        return;
      }
      if (working && ctx.message) {
        await adapter.addReaction(ctx.thread.id, ctx.message.id, working);
        reacted.set(ctx, ctx.message.id);
      }
    },

    async turnEnded(ctx) {
      const adapter = slackAdapter(ctx.thread);
      const messageId = reacted.get(ctx);
      const mine = messageId && working ? kept.delete(`${messageId}:${working}`) : false;
      if (messageId && working && !mine) await adapter.removeReaction(ctx.thread.id, messageId, working);
      if (messageId && options.doneReaction) await adapter.addReaction(ctx.thread.id, messageId, options.doneReaction);
    },

    traces: presentation(() => host, {
      keep: (messageId, emoji) => {
        kept.add(`${messageId}:${emoji}`);
        // The set only outlives a turn when the turn fails before ending; keep it small.
        if (kept.size > 1000) kept.delete(kept.values().next().value!);
      },
    }),

    attach(bot, lent) {
      host = lent;
      attachAssistant(bot, lent);
      attachReactions(bot, lent);
      if (options.slashCommands !== false) attachSlashCommands(bot, lent);
      if (options.home !== false) attachHome(bot, lent);
      attachFormEvents(bot, lent);
    },
  };

  function attachAssistant(bot: Chat<any, any>, lent: ExtensionHost) {
    bot.onAssistantThreadStarted(async (event) => {
      if (event.adapter.name !== SLUG) return;
      const thread = bot.thread(event.threadId) as AnyThread;
      await thread.subscribe();
      await update(thread, { assistant: true, viewing: event.context.channelId });
      if (options.launchOnOpen === false) return;
      const pin = promptPinner(event.adapter as unknown as SlackAdapterLike, event.channelId, event.threadTs);
      await lent.run(thread, { type: 'launch' }, { pin, userId: event.userId });
    });
    bot.onAssistantContextChanged(async (event) => {
      if (event.adapter.name !== SLUG) return;
      await update(bot.thread(event.threadId) as AnyThread, { viewing: event.context.channelId });
    });
  }

  function attachReactions(bot: Chat<any, any>, lent: ExtensionHost) {
    bot.onReaction(async (event) => {
      if (event.adapter.name !== SLUG || event.user.isMe) return;
      const raw = event.raw as { item_user?: string } | undefined;
      const adapter = event.adapter as unknown as SlackAdapterLike;
      const name = event.rawEmoji.replace(/::skin-tone-\d$/, '');
      const onAgent = Boolean(raw?.item_user) && raw?.item_user === adapter.botUserId;
      if (options.feedbackReactions !== false && event.added && onAgent && (POSITIVE.has(name) || NEGATIVE.has(name))) {
        await lent.feedback({ positive: POSITIVE.has(name), value: name, via: 'reaction', thread: event.thread, user: event.user, messageId: event.messageId });
      }
      await options.onReaction?.(event);
    });
  }

  function attachSlashCommands(bot: Chat<any, any>, lent: ExtensionHost) {
    bot.onSlashCommand(async (event) => {
      if (event.adapter.name !== SLUG) return;
      const adapter = event.adapter as unknown as SlackAdapterLike;
      const raw = (event.raw ?? {}) as Record<string, string>;
      const text = event.text.trim();
      if (!text) {
        await respond(raw.response_url, `Ask a question after the command: \`${event.command} what's our refund policy?\``);
        return;
      }
      // The question goes in the channel, so the answer has a thread to live in and others can follow it.
      let rootId: string;
      try {
        rootId = (await event.channel.post(`<@${event.user.userId}> asked: ${text}`)).id;
      } catch (error) {
        lent.report(error);
        await respond(raw.response_url, "I can't post in this conversation. Add me to it, or message me directly.");
        return;
      }
      const channel = raw.channel_id ?? event.channel.id.split(':')[1] ?? '';
      const thread = bot.thread(adapter.encodeThreadId({ channel, threadTs: rootId })) as AnyThread;
      await thread.subscribe();
      await lent.run(thread, { type: 'text', payload: text }, { userId: event.user.userId });
    });
  }

  function attachHome(bot: Chat<any, any>, lent: ExtensionHost) {
    const text = (options.home && options.home.text) || DEFAULT_HOME_TEXT;
    bot.onAppHomeOpened(async (event) => {
      if (event.adapter.name !== SLUG || (event.tab && event.tab !== 'home')) return;
      const adapter = event.adapter as unknown as SlackAdapterLike;
      try {
        await adapter.publishHomeView(event.userId, { type: 'home', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
      } catch (error) {
        lent.report(error);
      }
    });
  }

  return extension;
}

/**
 * Suggested prompts (`setSuggestedPrompts`). A prompt sends its label, and a
 * typed label picks the choice, so a prompt click sends the button's own request.
 */
function promptPinner(adapter: SlackAdapterLike, channelId: string, threadTs: string): PinPrompts | undefined {
  if (typeof adapter.setSuggestedPrompts !== 'function') return undefined;
  return async (choices) => {
    // A link can't ride on a prompt, and more than Slack shows would hide some.
    if (!choices.length || choices.length > MAX_PROMPTS || choices.some((c) => c.url)) return false;
    try {
      await adapter.setSuggestedPrompts(channelId, threadTs, choices.map((c) => ({ title: c.label, message: c.label })));
      return true;
    } catch {
      return false;
    }
  };
}

/** Answers a slash command only its sender sees, through the command's own response URL. */
async function respond(responseUrl: string | undefined, text: string): Promise<void> {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  }).catch(() => {});
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The person's first line, cut at a word to fit Slack's thread list. */
function titleOf(text: string): string {
  const line = oneLine(text);
  if (line.length <= MAX_TITLE) return line;
  const cut = line.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The adapter's `feedbackButtons` for this package's option: off unless asked for, and always on the action `onFeedback` listens for. */
function feedbackButtons(option: SlackOptions['feedbackButtons']) {
  if (!option) return false;
  const labels = option === true ? {} : option;
  return {
    actionId: FEEDBACK_ACTION,
    ...(labels.positiveLabel ? { positiveLabel: labels.positiveLabel } : {}),
    ...(labels.negativeLabel ? { negativeLabel: labels.negativeLabel } : {}),
  };
}
