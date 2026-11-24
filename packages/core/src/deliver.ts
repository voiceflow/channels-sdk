// How one turn reaches the thread. A whole turn is rendered and posted reply
// by reply. A streamed turn writes text into one live message as the runtime
// sends it, with a progress card per tool call, and closes that message
// whenever something that can't stream (buttons, a card, an image) comes next.
// A rich post the channel refuses is sent again as text, and the turn goes on.
import type { SentMessage, StreamChunk, Thread } from 'chat';
import { toPlain } from './plain.js';
import { type ButtonsShown, type Post, type Renderer, type RenderOptions, withSources } from './render.js';
import { type Measure, splitMarkdown, splitText } from './split.js';
import { type Choice, type Reply, type Source, sourcesOf, translate } from './translate.js';
import type { Trace } from './voiceflow.js';

type AnyThread = Thread<any, any>;

/** A posted message with buttons, and its ID on the channel. */
export type ShownMessage = ButtonsShown & { messageId: string };

export interface DeliveryOptions extends RenderOptions {
  /** The title on a tool call's progress card. `null` shows no progress cards. */
  progressTitle?: string | null;
  /**
   * Offers a turn's buttons another way (as suggested prompts) instead of
   * posting them. Returns `true` when it did.
   */
  offerChoices?: (choices: readonly Choice[]) => Promise<boolean>;
  /** Called for each message with buttons once it's posted, so they can be taken off later. */
  onButtons?: (message: ShownMessage) => void;
  /** Called when the channel refused a post and its text form was sent instead. */
  onRefused?: (error: unknown) => void;
  /** Custom traces the channel shows natively, by type. Each runs in its place in the turn. */
  traces?: Record<string, CustomTrace>;
  /** The longest text the channel shows in one message: a longer one goes as several, cut where the text breaks. */
  maxText?: number;
  /** How long a text is as the channel counts it. Default: its characters. */
  measureText?: Measure;
  /** Rewrites a text post into what the channel shows, before it is measured and sent. */
  shapeText?: (markdown: string) => string;
  /** Sends text as plain words: the channel shows Markdown as it is typed. */
  plain?: boolean;
}

/** What a custom trace's handler can do in the turn: post below what's shown, or close the streamed message. */
export interface TraceIO {
  post(post: Post, text?: Post): Promise<SentMessage | null>;
  flush(): Promise<void>;
}

export type CustomTrace = (trace: Trace, io: TraceIO) => Promise<void>;

export const DEFAULT_PROGRESS_TITLE = 'Working on it';

/** Text alone: the one kind of post that can go as several messages. */
function plainText(post: Post): string | null {
  if (typeof post !== 'object' || post === null) return null;
  const keys = Object.keys(post);
  const { markdown } = post as { markdown?: unknown };
  return keys.length === 1 && typeof markdown === 'string' ? markdown : null;
}

/**
 * Posts a post. Text is first put into what the channel shows (`shapeText`, and plain words where the channel
 * shows no Markdown). Text longer than the channel shows
 * in one message goes as several, in order: some adapters cut a long message short and say nothing, and the end
 * of an answer would be lost. Returns the last message sent.
 */
async function postFitting(thread: AnyThread, post: Post, options: DeliveryOptions): Promise<SentMessage> {
  const written = options.maxText || options.shapeText || options.plain ? plainText(post) : null;
  if (written === null) return thread.post(post);
  const text = options.shapeText ? options.shapeText(written) : written;
  if (options.plain) {
    // A string is sent as it is: no adapter reads it as Markdown, or writes it back with marks of its own.
    const words = toPlain(text);
    let sent!: SentMessage;
    // And it is as long as it is written: measured as Markdown, marks in it that are only text would not be counted.
    for (const part of options.maxText ? splitText(words, options.maxText) : [words]) sent = await thread.post(part);
    return sent;
  }
  const whole: Post = text === written ? post : { markdown: text };
  if (!options.maxText) return thread.post(whole);
  const parts = splitMarkdown(text, options.maxText, options.measureText);
  if (parts.length === 1) return thread.post(whole);
  let sent!: SentMessage;
  for (const markdown of parts) sent = await thread.post({ markdown });
  return sent;
}

/** Posts a post, or `text` if the channel refuses it. Returns the sent message, or `null` when its text form went. */
async function postOrText(thread: AnyThread, shown: Post, text: Post | null | undefined, options: DeliveryOptions): Promise<SentMessage | null> {
  try {
    return await postFitting(thread, shown, options);
  } catch (error) {
    // An image the channel can't fetch, say. Text keeps the reply, and its choices stay answerable by number.
    if (!text) throw error;
    options.onRefused?.(error);
    await postFitting(thread, text, options);
    return null;
  }
}

/** Posts one rendered post, or its text form if the channel refuses it. */
async function send(thread: AnyThread, renderer: Renderer, post: Post, options: DeliveryOptions): Promise<void> {
  const sent = await postOrText(thread, post, renderer.textOf(post), options);
  const buttons = renderer.buttonsOf(post);
  if (buttons && sent?.id) options.onButtons?.({ ...buttons, messageId: sent.id });
}

/** Runs a custom trace's handler, if the channel has one for its type. */
async function custom(thread: AnyThread, trace: Trace, options: DeliveryOptions, flush: () => Promise<void>): Promise<boolean> {
  const handler = options.traces?.[trace.type];
  if (!handler) return false;
  await handler(trace, {
    flush,
    post: async (post, text) => {
      await flush();
      return postOrText(thread, post, text, options);
    },
  });
  return true;
}

/** Posts one reply, unless `offerChoices` took its buttons. */
async function postReply(thread: AnyThread, renderer: Renderer, reply: Reply, options: DeliveryOptions): Promise<void> {
  if (reply.type === 'trace') {
    await custom(thread, reply.trace, options, async () => {});
    return;
  }
  if (reply.type === 'choices' && (await options.offerChoices?.(reply.choices))) {
    renderer.offer(reply.choices);
    return;
  }
  for (const post of renderer.render(reply)) await send(thread, renderer, post, options);
}

export async function deliverWhole(thread: AnyThread, replies: readonly Reply[], renderer: Renderer, options: DeliveryOptions): Promise<void> {
  for (const reply of replies) await postReply(thread, renderer, reply, options);
}

/** A push-driven async iterable: the live message reads from it as the turn writes. */
function chunkQueue() {
  const items: StreamChunk[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(chunk: StreamChunk) {
      items.push(chunk);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      while (true) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/** Streams one turn. Returns every trace it saw, for the turn's record. */
export async function deliverStream(thread: AnyThread, traces: AsyncIterable<Trace>, renderer: Renderer, options: DeliveryOptions): Promise<Trace[]> {
  const seen: Trace[] = [];
  const progressTitle = options.progressTitle === undefined ? DEFAULT_PROGRESS_TITLE : options.progressTitle;
  const sourcesMode = options.sources ?? 'off';

  let live: { queue: ReturnType<typeof chunkQueue>; posted: Promise<unknown>; wrote: boolean } | null = null;
  const running = new Set<string>();
  const completions = new Map<string, { sources: Source[]; wrote: boolean }>();

  const open = () => {
    if (!live) {
      const queue = chunkQueue();
      // Kept as a settled value so a failed post surfaces when the message closes, not as an unhandled rejection.
      const posted = thread.post(queue).then(
        () => null,
        (error: unknown) => ({ error }),
      );
      live = { queue, posted, wrote: false };
    }
    return live;
  };
  const write = (text: string, separate: boolean) => {
    if (!text) return;
    const m = open();
    m.queue.push({ type: 'markdown_text', text: separate && m.wrote ? `\n\n${text}` : text });
    m.wrote = true;
  };
  const task = (id: string, status: 'in_progress' | 'complete') => {
    if (progressTitle === null) return;
    open().queue.push({ type: 'task_update', id, title: progressTitle, status });
  };
  const close = async () => {
    const m = live;
    if (!m) return;
    live = null;
    // A tool whose end never came is finished once the turn moves on.
    if (progressTitle !== null) for (const id of running) m.queue.push({ type: 'task_update', id, title: progressTitle, status: 'complete' });
    running.clear();
    m.queue.close();
    const result = (await m.posted) as { error: unknown } | null;
    if (result) throw result.error;
  };

  try {
    for await (const trace of traces) {
      seen.push(trace);
      const p = trace.payload;
      if (trace.type === 'completion') {
        const id = String(p?.messageID ?? '_');
        if (p?.state === 'start') {
          completions.set(id, { sources: sourcesOf(p?.sourceUrls), wrote: false });
        } else if (p?.state === 'content' && typeof p?.content === 'string') {
          const c = completions.get(id) ?? { sources: [], wrote: false };
          completions.set(id, c);
          // A new answer starts a new paragraph; its own pieces join as they come.
          write(p.content, !c.wrote);
          c.wrote ||= p.content.length > 0;
        } else if (p?.state === 'end') {
          const c = completions.get(id);
          const sources = sourcesOf(p?.sourceUrls).length ? sourcesOf(p?.sourceUrls) : (c?.sources ?? []);
          if (c?.wrote && sourcesMode === 'links' && sources.length) write(withSources('', sources, 'links').trimStart(), true);
          completions.delete(id);
        }
        continue;
      }
      if (await custom(thread, trace, options, close)) continue;
      if (trace.type === 'tool-call' && typeof p?.callID === 'string') {
        if (p.state === 'start') {
          running.add(p.callID);
          task(p.callID, 'in_progress');
        } else if (p.state === 'end' && running.delete(p.callID)) {
          task(p.callID, 'complete');
        }
        continue;
      }
      for (const reply of translate([trace], { custom: (type) => type in (options.traces ?? {}) }).replies) {
        if (reply.type === 'text') {
          write(withSources(reply.markdown, reply.sources, sourcesMode), true);
        } else {
          await close();
          await postReply(thread, renderer, reply, options);
        }
      }
    }
  } finally {
    await close();
  }
  return seen;
}
