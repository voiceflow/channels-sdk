// The Voiceflow side: one v4 turn per incoming message.
//
// A session key is kept per conversation and reused, because starting a
// session ends the previous one: a fresh session per message would wipe the
// agent's memory every turn. The key lives wherever the caller's SessionStore
// puts it (the agent keeps it in the Chat SDK thread state).
import { ChannelsError } from './errors.js';

export const DEFAULT_RUNTIME_URL = 'https://general-runtime.voiceflow.com';

/** Trace types a messaging channel never shows. A `debug` trace that explains a 402 is always returned by the runtime. */
export const DEFAULT_EXCLUDED_TRACES = ['block', 'path', 'flow', 'debug', 'log'] as const;

export type Secret = string | (() => string | Promise<string>);

export interface VoiceflowConfig {
  /** A Voiceflow API key for the project (a service key or a personal key), or a function returning one per turn. */
  apiKey: Secret;
  projectID: string;
  /** Environment ID or alias. Default: `production`. */
  environment?: string;
  runtimeURL?: string;
  /** Per-request timeout. Default: 90 s. */
  timeoutMs?: number;
  excludeTypes?: readonly string[];
  fetch?: typeof fetch;
}

/** A Voiceflow request (the `action` of an interact call). */
export interface VoiceflowAction {
  type: string;
  payload?: unknown;
  [key: string]: unknown;
}

/** A runtime trace. Only the fields this package reads are typed. */
export interface Trace {
  type: string;
  payload?: any;
  [key: string]: unknown;
}

export interface SessionStore {
  get(): Promise<string | null>;
  set(sessionKey: string): Promise<void>;
  delete(): Promise<void>;
}

export interface TurnInput {
  /** The Voiceflow user ID. One per conversation thread. Max 256 characters. */
  userID: string;
  action: VoiceflowAction;
  variables?: Record<string, unknown>;
  sessions: SessionStore;
}

export interface TurnResult {
  traces: Trace[];
  /** `true` when the runtime answered 402 (out of credits); the traces explain it. */
  outOfCredits: boolean;
}

export interface StreamResult {
  /** The turn's traces as the runtime sends them. Completions arrive as `start`, `content`…, `end`. */
  traces: AsyncIterable<Trace>;
  outOfCredits: boolean;
}

export interface VoiceflowClient {
  /** One turn, answered whole. */
  turn(input: TurnInput): Promise<TurnResult>;
  /** One turn, streamed (`/v4/interact/stream` with completion events). */
  stream(input: TurnInput): Promise<StreamResult>;
}

async function resolve(secret: Secret): Promise<string> {
  return typeof secret === 'function' ? secret() : secret;
}

export function createVoiceflowClient(config: VoiceflowConfig): VoiceflowClient {
  const runtime = (config.runtimeURL ?? DEFAULT_RUNTIME_URL).replace(/\/+$/, '');
  const environment = config.environment ?? 'production';
  const timeoutMs = config.timeoutMs ?? 90_000;
  const excludeTypes = [...(config.excludeTypes ?? DEFAULT_EXCLUDED_TRACES)];
  const doFetch = config.fetch ?? fetch;

  async function startSession(userID: string): Promise<string> {
    const url = `${runtime}/v4/project/${encodeURIComponent(config.projectID)}/environment/${encodeURIComponent(environment)}/session`;
    const res = await doFetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${await resolve(config.apiKey)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userID }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ChannelsError('voiceflow_http', `Voiceflow refused to start a session (HTTP ${res.status}).`, { cause: text.slice(0, 500) });
    }
    const sessionKey = safeJSON(text)?.sessionKey;
    if (typeof sessionKey !== 'string' || !sessionKey) {
      throw new ChannelsError('voiceflow_response', 'Voiceflow started a session but returned no session key.');
    }
    return sessionKey;
  }

  type Send = (sessionKey: string) => Promise<Response>;

  /** Sends with the conversation's session, replacing it once if the runtime refuses it. */
  async function withSession({ userID, sessions }: TurnInput, send: Send): Promise<Response> {
    let sessionKey = await sessions.get();
    if (!sessionKey) {
      sessionKey = await startSession(userID);
      await sessions.set(sessionKey);
    }
    let res = await send(sessionKey);
    if (res.status === 401 || res.status === 403) {
      // The session expired or was replaced: start a new one, once.
      await res.body?.cancel().catch(() => {});
      await sessions.delete();
      sessionKey = await startSession(userID);
      await sessions.set(sessionKey);
      res = await send(sessionKey);
    }
    return res;
  }

  /** A refused turn: 402 (out of credits) carries the traces that explain it; anything else throws. */
  async function refused(res: Response): Promise<Trace[]> {
    const text = await res.text();
    if (res.status !== 402) {
      throw new ChannelsError('voiceflow_http', `Voiceflow interact failed (HTTP ${res.status}).`, { cause: text.slice(0, 500) });
    }
    const traces = safeJSON(text)?.traces;
    return Array.isArray(traces) ? traces : [];
  }

  return {
    async turn(input) {
      const { action, variables = {} } = input;
      const res = await withSession(input, (sessionKey) =>
        doFetch(`${runtime}/v4/interact`, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: sessionKey, 'content-type': 'application/json' },
          body: JSON.stringify({ action, variables, config: { excludeTypes } }),
        }),
      );
      if (!res.ok) return { traces: await refused(res), outOfCredits: true };
      const traces = safeJSON(await res.text())?.traces;
      if (!Array.isArray(traces)) {
        throw new ChannelsError('voiceflow_response', 'Voiceflow answered without traces.');
      }
      return { traces, outOfCredits: false };
    },

    async stream(input) {
      const { action, variables = {} } = input;
      const res = await withSession(input, (sessionKey) =>
        doFetch(`${runtime}/v4/interact/stream`, {
          method: 'POST',
          // The whole turn, stream included, gets the same budget as a whole reply.
          signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: sessionKey, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ action, variables, config: { completionEvents: true } }),
        }),
      );
      if (!res.ok) return { traces: fromArray(await refused(res)), outOfCredits: true };
      if (!res.body) throw new ChannelsError('voiceflow_response', 'Voiceflow answered the stream without a body.');
      return { traces: traceEvents(res.body), outOfCredits: false };
    },
  };
}

async function* fromArray(traces: Trace[]): AsyncIterable<Trace> {
  yield* traces;
}

/**
 * The runtime's server-sent events: `trace` events carry one trace each, and an
 * `end` event closes the turn. A trace may come bare or wrapped as `{ event, data }`.
 */
export async function* traceEvents(body: ReadableStream<Uint8Array>): AsyncIterable<Trace> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
        if (line === '') {
          // A blank line dispatches the event.
          if (event === 'end') return;
          if (data.length && (event === 'trace' || event === 'message')) {
            const parsed = safeJSON(data.join('\n'));
            const trace = parsed?.event === 'trace' && parsed?.data ? parsed.data : parsed;
            if (trace && typeof trace.type === 'string') yield trace as Trace;
          }
          event = 'message';
          data = [];
        } else if (line.startsWith(':')) {
          // A comment (a keep-alive).
        } else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const raw = colon === -1 ? '' : line.slice(colon + 1);
          const val = raw.startsWith(' ') ? raw.slice(1) : raw;
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function safeJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
