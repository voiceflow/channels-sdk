// Test doubles for code built on this package, picked by shape: a fake
// Voiceflow runtime as a `fetch`, and a `waitUntil` that a test can wait on.
// Every channel package's contract tests use these.
import type { Trace, VoiceflowAction } from './voiceflow.js';

/** One interact call the fake runtime answered. */
export interface FakeInteract {
  sessionKey: string;
  action: VoiceflowAction;
  variables: Record<string, unknown>;
  config: Record<string, unknown>;
  /** `true` for `/v4/interact/stream`. */
  stream: boolean;
}

export interface FakeSession {
  url: string;
  userID: string;
  authorization: string;
  sessionKey: string;
}

/**
 * A fake Voiceflow runtime as a `fetch`. `answer(action, call)` returns the
 * traces for each interact call, or throws to fail it. Records sessions and
 * interact calls.
 */
export function fakeVoiceflow(answer: (action: VoiceflowAction, call: FakeInteract) => Trace[]) {
  const sessions: FakeSession[] = [];
  const interacts: FakeInteract[] = [];
  let n = 0;
  const fetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const href = String(url);
    const body = JSON.parse(String(init.body ?? '{}'));
    const headers = init.headers as Record<string, string>;
    if (/\/v4\/project\/[^/]+\/environment\/[^/]+\/session$/.test(href)) {
      const sessionKey = `sk-${++n}`;
      sessions.push({ url: href, userID: body.userID, authorization: headers.authorization!, sessionKey });
      return new Response(JSON.stringify({ sessionKey }), { status: 200 });
    }
    if (href.endsWith('/v4/interact') || href.endsWith('/v4/interact/stream')) {
      const stream = href.endsWith('/stream');
      const call: FakeInteract = { sessionKey: headers.authorization!, action: body.action, variables: body.variables, config: body.config, stream };
      interacts.push(call);
      const traces = answer(body.action, call);
      if (!stream) return new Response(JSON.stringify({ traces }), { status: 200 });
      // Server-sent events, the runtime's shape: one `trace` event per trace, then `end`.
      const sse = traces.map((t, i) => `event: trace\nid: ${i}\ndata: ${JSON.stringify(t)}\n\n`).join('') + 'event: end\ndata: {}\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, sessions, interacts };
}

/** Collects `waitUntil` promises so a test can wait for the bot to finish. */
export function waiter() {
  const pending: Promise<unknown>[] = [];
  return {
    options: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    async settle(): Promise<void> {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}
