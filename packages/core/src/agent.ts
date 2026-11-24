// A Voiceflow agent inside any Chat SDK bot: one Chat SDK thread is one
// Voiceflow conversation. The session key, the choices offered last turn and
// the messages that show them live in the thread's own state, so they persist
// wherever the bot's state adapter keeps it (memory in development, Redis in
// production). Only the latest turn's buttons are live: when the next turn
// starts, the last turn's come off their messages, as in Voiceflow's web chat.
// Whatever only one platform has comes from that channel's extension
// (`ChannelExtension`), matched to a thread by its adapter's name.
import { createHash } from 'node:crypto';
import { type ActionEvent, type AdapterPostableMessage, type Author, type Chat, type Message, parseMarkdown, type Thread } from 'chat';
import { type ChannelCapabilities, capabilities } from './catalog.js';
import { type CustomTrace, type DeliveryOptions, deliverStream, deliverWhole, type ShownMessage } from './deliver.js';
import { ChannelsError } from './errors.js';
import type { ChannelExtension, ExtensionHost, PinPrompts, RunOptions, TurnContext } from './extension.js';
import { createRenderer, matchTypedChoice, parseActionId, type RenderOptions, retired } from './render.js';
import { PASS_VARIABLE, type ServerTool } from './server-tools.js';
import type { Measure } from './split.js';
import { type ApprovalPolicy, createToolServer } from './tool-server.js';
import { type Choice, type Translation, translate } from './translate.js';
import { createVoiceflowClient, DEFAULT_TIMEOUT_MS, type SessionStore, type VoiceflowAction, type VoiceflowConfig } from './voiceflow.js';

export type { PinPrompts, TurnContext } from './extension.js';

export const STATE_KEY = 'voiceflow';

interface ConversationState {
  sessionKey?: string;
  nonce?: string;
  choices?: Choice[];
  /** The last turn's messages with buttons, taken off when the next turn starts. */
  shown?: ShownMessage[];
}

type AnyThread = Thread<any, any>;

export interface VoiceflowAgentOptions extends RenderOptions {
  voiceflow: VoiceflowConfig;
  /**
   * The bot's display name on the channel (its Slack name, say). Its @-mention
   * is removed from what the person wrote before it reaches the agent.
   */
  userName?: string;
  /** Variables set on the Voiceflow session before each turn, over the channel extension's own. */
  variables?: (ctx: TurnContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** What only some platforms have, one extension per channel (`slack()` from @voiceflow/channels-slack). */
  extensions?: readonly ChannelExtension[];
  /**
   * Your own server tools: tools the agent calls whose code runs here, with
   * the conversation and the person it is acting for. Install them on the agent
   * with `installTools(serverToolSet('my-app', tools), …)`.
   */
  tools?: readonly ServerTool[];
  /**
   * Signs each turn's pass, which a server tool's call sends back so the
   * server knows which conversation it is for. Default: a key derived from the
   * Voiceflow API key. Give your own (32 or more random characters, the same
   * on every instance) to keep the two apart.
   */
  toolSecret?: string | (() => string | Promise<string>);
  /**
   * Which server tools ask the person before they act. By default each tool
   * decides: Slack's ask before anything that leaves the conversation. `false`
   * never asks; `true` asks before every call; or say per tool, by name
   * (`{ slack_post_to_channel: false }`).
   */
  requireApproval?: ApprovalPolicy;
  /** How long a request for approval waits for its answer, in milliseconds. After that it has expired. Default: 10 minutes. */
  approvalTimeoutMs?: number;
  /**
   * Keeps work running after a webhook has answered. `createChannels` passes
   * the platform's `waitUntil`; without one, the work runs unawaited.
   */
  defer?: (task: Promise<unknown>) => void;
  /** Posted when a turn fails. `null` posts nothing. */
  errorMessage?: string | null;
  /** Posted when someone clicks a button from an earlier turn. `null` posts nothing. */
  staleChoiceMessage?: string | null;
  /**
   * Called when a turn fails (and `errorMessage` is posted), or when part of
   * one does and the turn carries on: a post the channel refused and that went
   * as text instead (`post_refused`), buttons that couldn't be taken off an
   * earlier message (`edit_failed`), or a channel extension's own step.
   */
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
   * Called when someone rates a reply: with the channel's native feedback
   * buttons, or (where the channel's extension counts them) a reaction.
   */
  onFeedback?: (feedback: Feedback) => void | Promise<void>;
  /** The action ID the feedback buttons send. Default: the channel extension's. */
  feedbackActionId?: string;
}

export interface Feedback {
  /** `true` for the positive button. */
  positive: boolean;
  /** The button's value as the channel sent it (`positive` / `negative`), or the reaction's emoji name. */
  value: string;
  /** How it was given. */
  via: 'button' | 'reaction';
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
  open(thread: AnyThread, pin?: PinPrompts, userId?: string): Promise<void>;
  /** Runs one turn: any Voiceflow request, for a channel's own entry points. */
  run(thread: AnyThread, action: VoiceflowAction, options?: RunOptions): Promise<void>;
  /** Registers the mention, subscribed-message and button handlers on a bot, and each extension's own. */
  attach(bot: Chat<any, any>): void;
  /** Answers a server tool's call: the request the agent's tool makes from Voiceflow. Needs `attach` first. */
  tools(request: Request): Promise<Response>;
}

const DEFAULT_ERROR = 'Sorry, something went wrong. Please try again.';
const DEFAULT_STALE = 'That option is no longer available.';
const NO_CAPABILITIES: ChannelCapabilities = {
  buttons: false,
  linkButtons: false,
  cards: false,
  imagesInCards: false,
  typingIndicator: false,
  streaming: false,
  editMessages: false,
  selectMenus: false,
};

export function createVoiceflowAgent(options: VoiceflowAgentOptions): VoiceflowAgent {
  const client = createVoiceflowClient(options.voiceflow);
  const extensions = new Map((options.extensions ?? []).map((e) => [e.slug, e]));
  const extensionOf = (thread: AnyThread) => extensions.get(thread.adapter.name);
  /** What the thread's platform can show: the catalog's word, and the channel's own where it knows better. */
  const capsOf = (thread: AnyThread): ChannelCapabilities => ({ ...capabilitiesOf(thread), ...extensionOf(thread)?.capabilities });
  let attached: Chat<any, any> | undefined;
  if (typeof options.toolSecret === 'string' && options.toolSecret.length < 32) throw new TypeError('`toolSecret` must be 32 or more random characters.');
  if (options.approvalTimeoutMs !== undefined && !(options.approvalTimeoutMs > 0)) throw new TypeError('`approvalTimeoutMs` must be more than 0.');

  const report = (error: unknown, ctx: Partial<TurnContext> = {}) => {
    try {
      options.onError?.(error, ctx as TurnContext);
    } catch {
      // A failing error handler must not take the turn down with it.
    }
  };
  /** An extension's step never fails a turn: what it throws is reported. */
  const quietly = async <T>(ctx: TurnContext, step: () => T | Promise<T>, fallback: T): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      report(error, ctx);
      return fallback;
    }
  };

  const toolServer = createToolServer({
    tools: options.tools ?? [],
    extensions,
    secret: async () => {
      const own = typeof options.toolSecret === 'function' ? await options.toolSecret() : options.toolSecret;
      if (own) return own;
      const { apiKey } = options.voiceflow;
      return typeof apiKey === 'function' ? apiKey() : apiKey;
    },
    // A pass lasts as long as a turn can, and a little longer for the last call's trip.
    passTtlMs: (options.voiceflow.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 30_000,
    requireApproval: options.requireApproval,
    approvalTtlMs: options.approvalTimeoutMs,
    bot: () => attached,
    capabilities: capsOf,
    report,
  });

  async function readState(thread: AnyThread): Promise<ConversationState> {
    const state = (await thread.state) as Record<string, unknown> | null;
    return (state?.[STATE_KEY] as ConversationState | undefined) ?? {};
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

  /** Shows a turn's messages again without their buttons. Never throws: a failed edit is reported. */
  async function retire(ctx: TurnContext, messages: readonly ShownMessage[], picked: number | null): Promise<void> {
    const { thread } = ctx;
    const caps = capsOf(thread);
    for (const message of messages) {
      try {
        await thread.adapter.editMessage(thread.id, message.messageId, retired(message, picked, caps) as AdapterPostableMessage);
      } catch (error) {
        report(new ChannelsError('edit_failed', `Couldn't take the buttons off message ${message.messageId}.`, { cause: error }), ctx);
      }
    }
  }

  /**
   * One turn. `picked` is the index of the choice that started it (a click, or
   * a typed number or label), shown as picked on the message it came from.
   */
  async function runTurn(ctx: TurnContext, action: VoiceflowAction, { pin, picked }: { pin?: PinPrompts; picked?: number } = {}): Promise<void> {
    const { thread } = ctx;
    const caps = capsOf(thread);
    const extension = extensionOf(thread);
    let retiring: Promise<void> = Promise.resolve();
    let turnId: string | undefined;
    if (extension?.turnStarted) await quietly(ctx, () => extension.turnStarted!(ctx), undefined);
    try {
      // The last turn's buttons come off while this turn runs.
      const before = await readState(thread);
      if (before.shown?.length) {
        await writeState(thread, { ...before, shown: [] });
        retiring = retire(ctx, before.shown, picked ?? null);
      }

      if (caps.typingIndicator) await thread.startTyping().catch(() => {});
      if (extension?.input && action.type === 'text' && typeof action.payload === 'string') {
        const said = action.payload;
        const shaped = await quietly(ctx, () => extension.input!(said, { ...ctx, isNew: !before.sessionKey }), said);
        action = { ...action, payload: shaped };
      }
      const variables: Record<string, unknown> = {
        ...(extension?.variables ? await quietly(ctx, () => extension.variables!(ctx), {}) : {}),
        ...((await options.variables?.(ctx)) ?? {}),
      };
      if (toolServer.offers(thread)) {
        // Set last, and on every turn: nothing else can stand in for it, and an earlier turn's pass never stays on the session.
        const minted = await toolServer.mint(ctx);
        variables[PASS_VARIABLE] = minted.pass;
        turnId = minted.turn;
      }
      const input = { userID: voiceflowUserID(thread.id), action, variables, sessions: sessionStore(thread) };
      const renderer = createRenderer(caps, options);
      const shown: ShownMessage[] = [];
      // The extension's custom traces, each run in its place in the turn. A failed one is reported, not fatal.
      const traces: Record<string, CustomTrace> = {};
      for (const [type, handler] of Object.entries(extension?.traces ?? {})) {
        traces[type] = (trace, io) => quietly(ctx, () => handler(trace, { ...ctx, ...io, report: (error) => report(error, ctx) }), undefined);
      }
      const delivery: DeliveryOptions = {
        sources: options.sources,
        progressTitle: options.progressTitle,
        offerChoices: pin,
        traces,
        // Where messages can't be edited (WhatsApp), old buttons stay, and a click on one is refused as stale.
        onButtons: caps.editMessages ? (message) => shown.push(message) : undefined,
        onRefused: (error) => report(new ChannelsError('post_refused', 'The channel refused a post; its text form was sent instead.', { cause: error }), ctx),
        ...(extension?.maxTextLength ? { maxText: extension.maxTextLength, measureText: measureOf(thread) } : {}),
        ...(extension?.text ? { shapeText: (markdown: string) => extension.text!(markdown) } : {}),
        ...(extension?.plainText ? { plain: true } : {}),
      };
      const custom = (type: string) => type in traces;

      let translation: Translation;
      if (caps.streaming && options.streaming !== false) {
        const { traces: stream } = await client.stream(input);
        translation = translate(await deliverStream(thread, stream, renderer, delivery), { custom });
      } else {
        const { traces: whole } = await client.turn(input);
        translation = translate(whole, { custom });
        await deliverWhole(thread, translation.replies, renderer, delivery);
      }

      await retiring;
      if (translation.ended) {
        // The agent ended the conversation: the next message starts a new one, so no button stays live.
        await retire(ctx, shown, null);
        await writeState(thread, {});
      } else {
        await writeState(thread, { ...(await readState(thread)), nonce: renderer.nonce, choices: renderer.choices, shown });
      }
      options.onTurn?.(translation, ctx);
    } catch (error) {
      await retiring;
      report(error, ctx);
      const text = options.errorMessage === undefined ? DEFAULT_ERROR : options.errorMessage;
      if (text !== null) await thread.post(text).catch(() => {});
    } finally {
      // The turn is over: its pass stops working.
      if (turnId) await quietly(ctx, () => toolServer.end(turnId!), undefined);
      if (extension?.turnEnded) await quietly(ctx, () => extension.turnEnded!(ctx), undefined);
    }
  }

  const agent: VoiceflowAgent = {
    async reply(thread, message) {
      const text = withoutBotMention(message.text ?? '', thread.adapter, options.userName);
      // Where a channel has no buttons, a request for approval is answered in words.
      if (!capsOf(thread).buttons && (await toolServer.typed(thread, message.author?.userId, text))) return;
      const state = await readState(thread);
      const picked = state.choices?.length ? matchTypedChoice(text, state.choices) : null;
      await runTurn(
        { thread, message, userId: message.author?.userId },
        picked ? picked.action : { type: 'text', payload: text },
        picked ? { picked: state.choices!.indexOf(picked) } : {},
      );
    },

    async choose(event) {
      if (await toolServer.choose(event)) return;
      if (!event.thread) return;
      const thread = event.thread as AnyThread;
      const feedbackActionId = options.feedbackActionId ?? extensionOf(thread)?.feedbackActionId;
      if (feedbackActionId && event.actionId === feedbackActionId) {
        const value = event.value ?? '';
        await options.onFeedback?.({ positive: value === 'positive', value, via: 'button', thread, user: event.user, messageId: event.messageId });
        return;
      }
      const parsed = parseActionId(event.actionId, event.value);
      if (!parsed) return;
      const state = await readState(thread);
      const choice = state.nonce === parsed.nonce ? state.choices?.[parsed.index] : undefined;
      if (!choice) {
        const text = options.staleChoiceMessage === undefined ? DEFAULT_STALE : options.staleChoiceMessage;
        if (text !== null) await thread.post(text).catch(() => {});
        return;
      }
      await runTurn({ thread, userId: event.user?.userId }, choice.action, { picked: parsed.index });
    },

    async open(thread, pin, userId) {
      await runTurn({ thread, userId }, { type: 'launch' }, { pin });
    },

    async run(thread, action, { message, userId, pin } = {}) {
      await runTurn({ thread, message, userId: userId ?? message?.author?.userId }, action, { pin });
    },

    tools: (request) => toolServer.handle(request),

    attach(bot) {
      attached = bot;
      // A direct message with no DM handler counts as a mention, so this covers DMs too.
      bot.onNewMention(async (thread, message) => {
        // Where a conversation is a whole room, the bot answers a mention and doesn't go on to answer everyone in it.
        if (extensionOf(thread)?.follow !== false) await thread.subscribe();
        await agent.reply(thread, message);
      });
      bot.onSubscribedMessage(async (thread, message) => {
        // A conversation followed before the channel was told not to follow: it is let go, and from then on only
        // what is said to the bot is answered there, as in one it never followed.
        if (extensionOf(thread)?.follow === false) {
          await thread.unsubscribe().catch(() => {});
          if (!message.isMention && !thread.isDM) return;
        }
        await agent.reply(thread, message);
      });
      bot.onAction((event) => agent.choose(event));
      for (const extension of extensions.values()) extension.attach?.(bot, host(extension));
    },
  };

  function host(extension: ChannelExtension): ExtensionHost {
    const key = `${STATE_KEY}:${extension.slug}`;
    return {
      run: (thread, action, runOptions) => agent.run(thread, action, runOptions),
      async getState<T>(thread: AnyThread) {
        const state = (await thread.state) as Record<string, unknown> | null;
        return state?.[key] as T | undefined;
      },
      async setState<T>(thread: AnyThread, value: T) {
        await thread.setState({ [key]: value });
      },
      defer(task) {
        const quiet = task.catch((error: unknown) => report(error));
        options.defer?.(quiet);
      },
      report,
      feedback: async (feedback) => {
        await options.onFeedback?.(feedback);
      },
    };
  }

  return agent;
}

/**
 * How long a text is once the channel's adapter has put it in the platform's own format: that, not what was
 * written, is what the platform counts. Where the adapter can't say, it is the text's own length.
 */
function measureOf(thread: AnyThread): Measure {
  return (markdown) => {
    try {
      return thread.adapter.renderFormatted(parseMarkdown(markdown)).length;
    } catch {
      return markdown.length;
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
  const stripped = text
    .replace(new RegExp(forms.join('|'), 'gi'), ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return stripped || text.trim();
}

/** A Chat SDK thread ID is the Voiceflow user ID; one longer than the runtime's 256 characters is hashed. */
export function voiceflowUserID(threadId: string): string {
  return threadId.length <= 256 ? threadId : `thread:${createHash('sha256').update(threadId).digest('hex')}`;
}
