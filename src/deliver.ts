// How one turn reaches the thread. A whole turn is rendered and posted reply
// by reply. A streamed turn writes text into one live message as the runtime
// sends it, with a progress card per tool call, and closes that message
// whenever something that can't stream (buttons, a card, an image) comes next.
import type { StreamChunk, Thread } from 'chat';
import { withSources, type Post, type RenderOptions, type Renderer } from './render.js';
import { sourcesOf, translate, type Choice, type Reply, type Source } from './translate.js';
import type { Trace } from './voiceflow.js';

type AnyThread = Thread<any, any>;

export interface DeliveryOptions extends RenderOptions {
  /** The title on a tool call's progress card. `null` shows no progress cards. */
  progressTitle?: string | null;
  /**
   * Offers a turn's buttons another way (as suggested prompts) instead of
   * posting them. Returns `true` when it did.
   */
  offerChoices?: (choices: readonly Choice[]) => Promise<boolean>;
}

export const DEFAULT_PROGRESS_TITLE = 'Working on it';

/** Posts one reply, unless `offerChoices` took its buttons. */
async function postReply(thread: AnyThread, renderer: Renderer, reply: Reply, options: DeliveryOptions): Promise<void> {
  if (reply.type === 'choices' && (await options.offerChoices?.(reply.choices))) {
    renderer.offer(reply.choices);
    return;
  }
  for (const post of renderer.render(reply)) await thread.post(post as Post);
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
export async function deliverStream(
  thread: AnyThread,
  traces: AsyncIterable<Trace>,
  renderer: Renderer,
  options: DeliveryOptions,
): Promise<Trace[]> {
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
      if (trace.type === 'tool-call' && typeof p?.callID === 'string') {
        if (p.state === 'start') {
          running.add(p.callID);
          task(p.callID, 'in_progress');
        } else if (p.state === 'end' && running.delete(p.callID)) {
          task(p.callID, 'complete');
        }
        continue;
      }
      for (const reply of translate([trace]).replies) {
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
