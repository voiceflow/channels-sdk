// A channel extension adds what only one platform has, on top of the
// channel-neutral agent: context the agent can read, native touches around a
// turn, custom traces shown natively (the channel's presentation tools), and
// the platform's own events (reactions, slash commands, forms). Each channel
// package (@voiceflow/channels-slack, …) ships one; the core knows none.
import type { Chat, Message, SentMessage, Thread } from 'chat';
import type { Feedback } from './agent.js';
import type { Post } from './render.js';
import type { ServerTool } from './server-tools.js';
import type { Choice } from './translate.js';
import type { Trace, VoiceflowAction } from './voiceflow.js';

type AnyThread = Thread<any, any>;

export interface TurnContext {
  thread: AnyThread;
  /** The incoming message; absent when the turn came from a button or a platform event. */
  message?: Message<any>;
  /** The person the turn is for, as the channel identifies them, where it says. */
  userId?: string;
}

/** Pins a turn's choices as the thread's suggested prompts. Returns `false` when they can't be. */
export type PinPrompts = (choices: readonly Choice[]) => Promise<boolean>;

/** What a custom trace's handler can do within the turn that produced it. */
export interface TraceTurn extends TurnContext {
  /**
   * Posts below everything shown so far this turn, closing a streamed message
   * first. A rich post the channel refuses goes as `text`, when given.
   */
  post(post: Post, text?: Post): Promise<SentMessage | null>;
  /** Closes the message being streamed, so what comes next starts below it. */
  flush(): Promise<void>;
  /** Reports a part of the turn that failed (to `onError`) without failing the turn. */
  report(error: unknown): void;
}

export type TraceHandler = (trace: Trace, turn: TraceTurn) => void | Promise<void>;

export interface RunOptions {
  message?: Message<any>;
  userId?: string;
  pin?: PinPrompts;
}

/** What the agent lends an extension when it attaches. */
export interface ExtensionHost {
  /** Runs one turn in a thread: a person's words (`{ type: 'text' }`), a launch, any Voiceflow request. */
  run(thread: AnyThread, action: VoiceflowAction, options?: RunOptions): Promise<void>;
  /** The extension's own part of a thread's state, kept beside the conversation's. */
  getState<T>(thread: AnyThread): Promise<T | undefined>;
  setState<T>(thread: AnyThread, value: T): Promise<void>;
  /**
   * Keeps work running after the webhook has answered (a form submitted, a
   * slash command): the platform's `waitUntil` where there is one.
   */
  defer(task: Promise<unknown>): void;
  /** Reports an error to the agent's `onError`. */
  report(error: unknown, ctx?: Partial<TurnContext>): void;
  /** Passes a rating the channel received its own way (a reaction, say) to the agent's `onFeedback`. */
  feedback(feedback: Feedback): Promise<void>;
}

export interface ChannelExtension {
  /** The adapter this extension serves: its catalog slug, which is the adapter's `name`. */
  readonly slug: string;
  /** Adapter options the channel turns on by default (Slack: its feedback buttons). The caller's own options win. */
  readonly adapterDefaults?: Record<string, unknown>;
  /** The action ID the channel's native feedback buttons send. */
  readonly feedbackActionId?: string;
  /**
   * The longest text the platform shows in one message, as the platform counts
   * it. A longer reply goes as several messages, cut where the text breaks. Set
   * it where the adapter would otherwise cut a long message short (Discord's does).
   */
  readonly maxTextLength?: number;
  /** Variables set on the Voiceflow session for each turn, under the agent's own `variables`. */
  variables?(ctx: TurnContext): Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Shapes what the person wrote before it reaches the agent. `isNew` is true
   * on a conversation's first turn (where earlier messages can be caught up).
   */
  input?(text: string, ctx: TurnContext & { isNew: boolean }): string | Promise<string>;
  /** Called as a turn starts. Never fails the turn. */
  turnStarted?(ctx: TurnContext): void | Promise<void>;
  /** Called when a turn has ended, whether or not it failed. Never fails the turn. */
  turnEnded?(ctx: TurnContext): void | Promise<void>;
  /** Custom traces this channel shows natively, by trace type: its presentation tools. */
  traces?: Record<string, TraceHandler>;
  /** Tools this channel runs on your server, callable only from its own conversations: its server tools. */
  tools?: readonly ServerTool[];
  /** Registers the channel's own events on the bot. */
  attach?(bot: Chat<any, any>, host: ExtensionHost): void;
}
