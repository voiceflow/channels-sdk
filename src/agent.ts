// A Voiceflow agent inside any Chat SDK bot: one Chat SDK thread is one
// Voiceflow conversation. The session key and the choices offered last turn
// live in the thread's own state, so they persist wherever the bot's state
// adapter keeps it (memory in development, Redis in production).
import { createHash } from 'node:crypto';
import type { ActionEvent, Adapter, Author, Chat, Message, Thread } from 'chat';
import { capabilities, type ChannelCapabilities } from './catalog.js';
import { deliverStream, deliverWhole, type DeliveryOptions } from './deliver.js';
import { createRenderer, matchTypedChoice, parseActionId, type RenderOptions } from './render.js';
import { translate, type Choice, type Translation } from './translate.js';
import { createVoiceflowClient, type SessionStore, type VoiceflowAction, type VoiceflowConfig } from './voiceflow.js';

export const STATE_KEY = 'voiceflow';

interface ConversationState {
  sessionKey?: string;
  nonce?: string;
  choices?: Choice[];
}

type AnyThread = Thread<any, any>;

export interface TurnContext {
  thread: AnyThread;
  /** The incoming message; absent when the turn came from a button. */
  message?: Message<any>;
}

export interface VoiceflowAgentOptions extends RenderOptions {
  voiceflow: VoiceflowConfig;
  /**
   * The bot's display name on the channel (its Slack name, say). Its @-mention
   * is removed from what the person wrote before it reaches the agent.
   */
  userName?: string;
  /** Variables set on the Voiceflow session before each turn. */
  variables?: (ctx: TurnContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Posted when a turn fails. `null` posts nothing. */
  errorMessage?: string | null;
  /** Posted when someone clicks a button from an earlier turn. `null` posts nothing. */
  staleChoiceMessage?: string | null;
  onError?: (error: unknown, ctx: TurnContext) => void;
  /** Called after every turn: what was translated, for logging or metrics. */
  onTurn?: (translation: Translation, ctx: TurnContext) => void;
  /**
   * Stream replies as the agent writes them, on channels whose catalog entry
   * says streaming is fully supported. Elsewhere replies are posted whole.
   * Default: `true`.
   */
  streaming?: boolean;
  /** The title on a tool call's progress card while streaming. `null` shows none. Default: `Working on it`. */
  progressTitle?: string | null;
  /**
   * When someone opens the bot's assistant thread (Slack's AI app panel), run
   * the agent's launch turn: its messages are posted, and its buttons become
   * the thread's suggested prompts where the channel has them. Default: `true`.
   */
  launchOnOpen?: boolean;
  /**
   * Called when someone rates a reply with the channel's native feedback
   * buttons (Slack: the adapter's `feedbackButtons` option).
   */
  onFeedback?: (feedback: Feedback) => void | Promise<void>;
  /** The action ID the feedback buttons send. Default: `message_feedback`, the Slack adapter's. */
  feedbackActionId?: string;
}

export interface Feedback {
  /** `true` for the positive button. */
  positive: boolean;
  /** The button's value as the channel sent it (`positive` / `negative` by default). */
  value: string;
  thread: AnyThread;
  user: Author;
  /** The rated message. */
  messageId: string;
}

export interface VoiceflowAgent {
  /** Answers a message in a thread. */
  reply(thread: AnyThread, message: Message<any>): Promise<void>;
  /** Answers a click on one of the agent's buttons, or records feedback. Ignores other actions. */
  choose(event: ActionEvent<any>): Promise<void>;
  /** Runs the launch turn in a thread that just opened. `pin` offers its buttons as suggested prompts. */
  open(thread: AnyThread, pin?: PinPrompts): Promise<void>;
  /** Registers the mention, subscribed-message, button and thread-opened handlers on a bot. */
  attach(bot: Chat<any, any>): void;
}

/** Pins a turn's choices as the thread's suggested prompts. Returns `false` when they can't be. */
export type PinPrompts = (choices: readonly Choice[]) => Promise<boolean>;

const DEFAULT_ERROR = 'Sorry, something went wrong. Please try again.';
const DEFAULT_STALE = 'That option is no longer available.';
const DEFAULT_FEEDBACK_ACTION = 'message_feedback';
const NO_CAPABILITIES: ChannelCapabilities = {
  buttons: false,
  linkButtons: false,
  cards: false,
  imagesInCards: false,
  typingIndicator: false,
  streaming: false,
};
/** Slack shows at most four suggested prompts. */
const MAX_PROMPTS = 4;

export function createVoiceflowAgent(options: VoiceflowAgentOptions): VoiceflowAgent {
  const client = createVoiceflowClient(options.voiceflow);

  async function readState(thread: AnyThread): Promise<ConversationState> {
    const state = (await thread.state) as Record<string, unknown> | null;
    return ((state?.[STATE_KEY] as ConversationState | undefined) ?? {});
  }

  async function writeState(thread: AnyThread, next: ConversationState): Promise<void> {
    await thread.setState({ [STATE_KEY]: next });
  }

  function sessionStore(thread: AnyThread): SessionStore {
    return {
      get: async () => (await readState(thread)).sessionKey ?? null,
      set: async (sessionKey) => writeState(thread, { ...(await readState(thread)), sessionKey }),
      delete: async () => {
        const { sessionKey: _, ...rest } = await readState(thread);
        await writeState(thread, rest);
      },
    };
  }

  async function runTurn(ctx: TurnContext, action: VoiceflowAction, pin?: PinPrompts): Promise<void> {
    const { thread } = ctx;
    const caps = capabilitiesOf(thread);
    try {
      if (caps.typingIndicator) await thread.startTyping().catch(() => {});
      const variables = (await options.variables?.(ctx)) ?? {};
      const input = { userID: voiceflowUserID(thread.id), action, variables, sessions: sessionStore(thread) };
      const renderer = createRenderer(caps, options);
      const delivery: DeliveryOptions = { sources: options.sources, progressTitle: options.progressTitle, offerChoices: pin };

      let translation: Translation;
      if (caps.streaming && options.streaming !== false) {
        const { traces } = await client.stream(input);
        translation = translate(await deliverStream(thread, traces, renderer, delivery));
      } else {
        const { traces } = await client.turn(input);
        translation = translate(traces);
        await deliverWhole(thread, translation.replies, renderer, delivery);
      }

      const state = await readState(thread);
      await writeState(
        thread,
        translation.ended
          ? {} // The agent ended the conversation: the next message starts a new one.
          : { ...state, nonce: renderer.nonce, choices: renderer.choices },
      );
      options.onTurn?.(translation, ctx);
    } catch (error) {
      options.onError?.(error, ctx);
      const text = options.errorMessage === undefined ? DEFAULT_ERROR : options.errorMessage;
      if (text !== null) await thread.post(text).catch(() => {});
    }
  }

  const agent: VoiceflowAgent = {
    async reply(thread, message) {
      const text = withoutBotMention(message.text ?? '', thread.adapter, options.userName);
      const state = await readState(thread);
      const picked = state.choices?.length ? matchTypedChoice(text, state.choices) : null;
      await runTurn({ thread, message }, picked ? picked.action : { type: 'text', payload: text });
    },

    async choose(event) {
      if (!event.thread) return;
      const thread = event.thread as AnyThread;
      if (event.actionId === (options.feedbackActionId ?? DEFAULT_FEEDBACK_ACTION)) {
        const value = event.value ?? '';
        await options.onFeedback?.({ positive: value === 'positive', value, thread, user: event.user, messageId: event.messageId });
        return;
      }
      const parsed = parseActionId(event.actionId);
      if (!parsed) return;
      const state = await readState(thread);
      const choice = state.nonce === parsed.nonce ? state.choices?.[parsed.index] : undefined;
      if (!choice) {
        const text = options.staleChoiceMessage === undefined ? DEFAULT_STALE : options.staleChoiceMessage;
        if (text !== null) await thread.post(text).catch(() => {});
        return;
      }
      await runTurn({ thread }, choice.action);
    },

    async open(thread, pin) {
      await runTurn({ thread }, { type: 'launch' }, pin);
    },

    attach(bot) {
      // A direct message with no DM handler counts as a mention, so this covers DMs too.
      bot.onNewMention(async (thread, message) => {
        await thread.subscribe();
        await agent.reply(thread, message);
      });
      bot.onSubscribedMessage((thread, message) => agent.reply(thread, message));
      bot.onAction((event) => agent.choose(event));
      if (options.launchOnOpen !== false) {
        bot.onAssistantThreadStarted(async (event) => {
          const thread = bot.thread(event.threadId) as AnyThread;
          await thread.subscribe();
          await agent.open(thread, promptPinner(event.adapter, event.channelId, event.threadTs));
        });
      }
    },
  };
  return agent;
}

/**
 * Suggested prompts, where the adapter can pin them (`setSuggestedPrompts`,
 * the Slack adapter's public method). A prompt sends its label, and a typed
 * label picks the choice, so a prompt click sends the button's own request.
 */
function promptPinner(adapter: Adapter, channelId: string, threadTs: string): PinPrompts | undefined {
  const pin = (adapter as { setSuggestedPrompts?: unknown }).setSuggestedPrompts;
  if (typeof pin !== 'function') return undefined;
  return async (choices) => {
    // A link can't ride on a prompt, and more than the channel shows would hide some.
    if (!choices.length || choices.length > MAX_PROMPTS || choices.some((c) => c.url)) return false;
    try {
      await pin.call(adapter, channelId, threadTs, choices.map((c) => ({ title: c.label, message: c.label })));
      return true;
    } catch {
      return false;
    }
  };
}

function capabilitiesOf(thread: AnyThread): ChannelCapabilities {
  try {
    return capabilities(thread.adapter.name);
  } catch {
    // An adapter the catalog doesn't list (a community adapter, say) gets the text fallbacks.
    return NO_CAPABILITIES;
  }
}

/**
 * The person's words without the bot's own @-mention: the forms the Chat SDK
 * counts as a mention (`@userName`, `@botUserId`, `<@botUserId>`) plus the
 * bot's display name, so "@voiceflow where's my order?" reaches the agent as
 * "where's my order?".
 */
export function withoutBotMention(text: string, adapter: { userName?: string; botUserId?: string }, botName?: string): string {
  const forms: string[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of new Set([adapter.userName, botName].filter(Boolean) as string[])) {
    forms.push(`(?<!\\w)@${esc(name)}(?![\\w-])`);
  }
  if (adapter.botUserId) forms.push(`(?<!\\w)@${esc(adapter.botUserId)}(?![\\w-])`, `<@!?${esc(adapter.botUserId)}>`);
  if (!forms.length) return text.trim();
  const stripped = text.replace(new RegExp(forms.join('|'), 'gi'), ' ').replace(/[ \t]+/g, ' ').trim();
  return stripped || text.trim();
}

/** A Chat SDK thread ID is the Voiceflow user ID; one longer than the runtime's 256 characters is hashed. */
export function voiceflowUserID(threadId: string): string {
  return threadId.length <= 256 ? threadId : `thread:${createHash('sha256').update(threadId).digest('hex')}`;
}
