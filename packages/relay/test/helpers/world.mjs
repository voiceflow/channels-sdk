// A relay for a test, and everything around it: two Voiceflow agents behind
// one fake of Voiceflow's API and runtime, Telegram stand-ins for their bots,
// and one state store for everything, as on a real relay.
import { randomBytes } from 'node:crypto';
import { createMemoryState } from '@chat-adapter/state-memory';
import { fakeVoiceflow, fakeVoiceflowApi, waiter } from '@voiceflow/channels-sdk/testing';
import { telegram } from '@voiceflow/channels-telegram';
import { start } from '../../../telegram/test/stand-in.mjs';
import { createRelay, memoryConnectionStore, parseKeys } from '../../dist/index.js';

export const KEY_A = 'VF.DM.aaaaaaaaaaaaaaaaaaaaaaaa.made-up-key-of-agent-a';
export const KEY_B = 'VF.DM.bbbbbbbbbbbbbbbbbbbbbbbb.made-up-key-of-agent-b';
export const PROJECT_A = '6a0000000000000000000a0a';
export const PROJECT_B = '6b0000000000000000000b0b';
export const PUBLIC = 'https://channels.example.com';

const text = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });

/** A server tool on the test's Telegram channel: it says which conversation it ran for. */
export const whoami = {
  name: 'whoami',
  description: 'Says which conversation this is.',
  approval: false,
  run: (_input, turn) => ({ ok: true, result: `thread ${turn.thread.id}` }),
};

/**
 * `answer(action, call, project)` scripts each agent's turns; by default it
 * says which project answered.
 */
export async function world({ answer, onError } = {}) {
  const apiA = fakeVoiceflowApi({ project: { id: PROJECT_A, name: 'Agent A', workspaceID: 'ws-a' }, apiKey: KEY_A });
  const apiB = fakeVoiceflowApi({ project: { id: PROJECT_B, name: 'Agent B', workspaceID: 'ws-b' }, apiKey: KEY_B });
  const runtime = fakeVoiceflow(async (action, call) => {
    const project = runtime.sessions.find((s) => s.sessionKey === call.sessionKey)?.url.match(/\/project\/([^/]+)\//)?.[1];
    return answer ? answer(action, call, project) : [text(`Agent ${project} heard ${action.payload ?? action.type}`)];
  });
  // Voiceflow's API for the project in the path; its runtime for everything else.
  const fetch = (input, init) => {
    const url = String(input);
    if (url.includes('/v1/stable/')) return (url.includes(PROJECT_B) ? apiB : apiA).fetch(input, init);
    return runtime.fetch(input, init);
  };

  const store = memoryConnectionStore();
  const keys = parseKeys(`k1:${randomBytes(32).toString('base64')}`);
  const errors = [];
  const relay = createRelay({
    publicURL: PUBLIC,
    store,
    keys,
    state: createMemoryState(),
    channels: {
      // A test's own channel: its stand-in's address comes in as a credential. A real relay's channels never take an address.
      telegram: {
        credentials: ['botToken', 'secretToken', 'apiUrl'],
        channel: (c) => {
          const spec = telegram({ adapter: { botToken: c.botToken, secretToken: c.secretToken, apiUrl: c.apiUrl } });
          return { ...spec, extension: { ...spec.extension, tools: [whoami] } };
        },
      },
    },
    voiceflow: { fetch },
    onError: (error, context) => {
      errors.push({ error, context });
      onError?.(error, context);
    },
  });

  const platforms = [];
  const w = waiter();
  /** Sends the relay a request, and waits for what it started. */
  const send = async (request) => {
    const response = await relay.fetch(await request, w.options);
    await w.settle();
    return response;
  };
  /** The platform's request, sent to the relay's address instead. */
  const to = async (url, request) => {
    const r = await request;
    return new Request(url, { method: r.method, headers: r.headers, body: await r.text() });
  };
  const api = (method, path, { token, body } = {}) =>
    new Request(`${PUBLIC}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  /** Adds a connection for an agent with a Telegram bot of its own, and returns what the API answered with the bot's stand-in. */
  async function connect(apiKey, projectID) {
    const platform = await start();
    platforms.push(platform);
    const { botToken, secretToken, apiUrl } = platform.adapter;
    const response = await send(
      api('POST', '/v1alpha1/connections', { body: { voiceflow: { apiKey, projectID }, channels: { telegram: { botToken, secretToken, apiUrl } } } }),
    );
    const created = await response.json();
    return { platform, response, created, hook: created.channels?.telegram?.url };
  }

  return {
    relay,
    store,
    keys,
    errors,
    runtime,
    apiCalls: () => [...apiA.state.calls, ...apiB.state.calls],
    send,
    to,
    api,
    connect,
    text,
    close: () => Promise.all(platforms.map((p) => p.close())),
  };
}
