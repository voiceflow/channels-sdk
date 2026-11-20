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

export interface VoiceflowClient {
  turn(input: TurnInput): Promise<TurnResult>;
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

  async function interact(sessionKey: string, action: VoiceflowAction, variables: Record<string, unknown>): Promise<Response> {
    return doFetch(`${runtime}/v4/interact`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: sessionKey, 'content-type': 'application/json' },
      body: JSON.stringify({ action, variables, config: { excludeTypes } }),
    });
  }

  return {
    async turn({ userID, action, variables = {}, sessions }) {
      let sessionKey = await sessions.get();
      if (!sessionKey) {
        sessionKey = await startSession(userID);
        await sessions.set(sessionKey);
      }
      let res = await interact(sessionKey, action, variables);
      if (res.status === 401 || res.status === 403) {
        // The session expired or was replaced: start a new one, once.
        await sessions.delete();
        sessionKey = await startSession(userID);
        await sessions.set(sessionKey);
        res = await interact(sessionKey, action, variables);
      }
      const text = await res.text();
      const outOfCredits = res.status === 402;
      if (!res.ok && !outOfCredits) {
        throw new ChannelsError('voiceflow_http', `Voiceflow interact failed (HTTP ${res.status}).`, { cause: text.slice(0, 500) });
      }
      const traces = safeJSON(text)?.traces;
      if (!Array.isArray(traces)) {
        throw new ChannelsError('voiceflow_response', 'Voiceflow answered without traces.');
      }
      return { traces, outOfCredits };
    },
  };
}

function safeJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
