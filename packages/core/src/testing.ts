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
 * traces for each interact call (or a promise of them), or throws to fail it.
 * Records sessions and interact calls.
 */
export function fakeVoiceflow(answer: (action: VoiceflowAction, call: FakeInteract) => Trace[] | Promise<Trace[]>) {
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
      // Awaited, so a fake turn can call a server tool partway through, as the runtime's functions do.
      const traces = await answer(body.action, call);
      if (!stream) return new Response(JSON.stringify({ traces }), { status: 200 });
      // Server-sent events, the runtime's shape: one `trace` event per trace, then `end`.
      const sse = `${traces.map((t, i) => `event: trace\nid: ${i}\ndata: ${JSON.stringify(t)}\n\n`).join('')}event: end\ndata: {}\n\n`;
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

// ── Voiceflow's API, for the installer ──────────────────────────────────────

export interface FakeApiCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
}

export interface FakeApiProject {
  id: string;
  name: string;
  workspaceID: string;
  /** The agent's avatar, a URL. */
  image?: string | null;
}

/**
 * A fake of Voiceflow's public API (`realtime-api.voiceflow.com`): the
 * project, functions, their variables and paths, agent tools, variables,
 * secrets and compiles, held in memory and checked the way the API checks them.
 * `fail(call)` returning true answers that call 500.
 */
export function fakeVoiceflowApi(options: { project: FakeApiProject; apiKey?: string; fail?: (call: FakeApiCall) => boolean }) {
  let n = 0;
  const id = (prefix: string) => `${prefix}${++n}`;
  const state = {
    functions: [] as { id: string; name: string; code: string; description: string | null; settings: unknown }[],
    functionVariables: [] as { id: string; name: string; type: 'input' | 'output'; functionID: string; description: string | null }[],
    functionPaths: [] as { id: string; name: string; functionID: string }[],
    tools: [] as { id: string; type: string; functionID: string; description: string | null; inputVariables: Record<string, any>; target: unknown }[],
    variables: [] as { id: string; name: string; color: string; description: string | null; isSystem: boolean }[],
    secrets: [] as { id: string; name: string; visibility: string; hasValue: boolean }[],
    secretValues: [] as { secretID: string; value: string; environmentAlias?: string; versionVariant?: string }[],
    compiles: [] as string[],
    calls: [] as FakeApiCall[],
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const refused = (status: number, message: string) => json(status, { message });
  const names = new Set<string>();
  const refs = (text: unknown) => [...String(text ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const query = Object.fromEntries(url.searchParams);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const call: FakeApiCall = { method, path: url.pathname, query, body };
    state.calls.push(call);
    const headers = new Headers(init.headers);
    if (options.apiKey && headers.get('authorization') !== options.apiKey) return refused(401, 'Unauthorized');
    if (options.fail?.(call)) return refused(500, 'Injected failure');
    const p = url.pathname;
    const env = query.environmentAlias;
    let m: RegExpMatchArray | null;

    if (method === 'GET' && (m = p.match(/^\/v1\/stable\/project\/([^/]+)$/))) {
      return m[1] === options.project.id ? json(200, { project: options.project }) : refused(404, 'Project not found');
    }
    if (query.projectID !== options.project.id) return refused(404, 'Project not found');
    const needsEnv = !p.startsWith('/v2/stable/secret') && !p.startsWith('/v1/stable/secret') && !p.includes('/compile');
    if (needsEnv && !env) return refused(400, 'environmentAlias is required');

    // Functions
    if (p === '/v1/stable/function' && method === 'GET') return json(200, { functions: state.functions });
    if (p === '/v1/stable/function' && method === 'POST') {
      if (!body.name || !body.code) return refused(400, 'name and code are required');
      const fn = { id: id('fn'), name: body.name, code: body.code, description: body.description ?? null, settings: body.settings ?? null };
      state.functions.push(fn);
      return json(201, { function: fn });
    }
    if ((m = p.match(/^\/v1\/stable\/function\/([^/]+)$/))) {
      const fn = state.functions.find((f) => f.id === m![1]);
      if (!fn) return refused(404, 'Function not found');
      if (method === 'PATCH') {
        Object.assign(fn, body);
        return json(200, { message: 'Updated' });
      }
      if (method === 'DELETE') {
        state.functions.splice(state.functions.indexOf(fn), 1);
        state.functionVariables = state.functionVariables.filter((v) => v.functionID !== fn.id);
        state.functionPaths = state.functionPaths.filter((v) => v.functionID !== fn.id);
        return json(200, { message: 'Deleted' });
      }
    }
    if (p === '/v1/stable/function-variable' && method === 'GET')
      return json(200, { variables: state.functionVariables.filter((v) => v.functionID === query.functionID) });
    if (p === '/v1/stable/function-variable' && method === 'POST') {
      if (!state.functions.some((f) => f.id === body.functionID)) return refused(404, 'Function not found');
      if (!['input', 'output'].includes(body.type)) return refused(400, 'type must be input or output');
      const v = { id: id('fv'), name: body.name, type: body.type, functionID: body.functionID, description: body.description ?? null };
      state.functionVariables.push(v);
      return json(201, { variable: v });
    }
    if ((m = p.match(/^\/v1\/stable\/function-variable\/([^/]+)$/))) {
      const v = state.functionVariables.find((x) => x.id === m![1]);
      if (!v) return refused(404, 'Variable not found');
      if (method === 'PATCH') Object.assign(v, body);
      if (method === 'DELETE') state.functionVariables.splice(state.functionVariables.indexOf(v), 1);
      return json(200, { message: 'OK' });
    }
    if (p === '/v1/stable/function-path' && method === 'GET') return json(200, { paths: state.functionPaths.filter((v) => v.functionID === query.functionID) });
    if (p === '/v1/stable/function-path' && method === 'POST') {
      const path = { id: id('fp'), name: body.name, functionID: body.functionID };
      state.functionPaths.push(path);
      return json(201, { path });
    }

    // Agent tools
    if (p === '/v2/stable/tool' && method === 'GET') return json(200, { tools: query.global === 'true' ? state.tools : [] });
    const checkInputs = (inputs: Record<string, any>, functionID: string) => {
      const unresolvedReferences: { token: string; path: string; reason: string }[] = [];
      for (const [name, input] of Object.entries(inputs)) {
        const fv = state.functionVariables.find((v) => v.id === input.functionInputVariableID);
        if (!fv || fv.functionID !== functionID || fv.type !== 'input')
          return { error: `inputVariables.${name}: functionInputVariableID is not an input of this function` };
        const tokens = refs(input.defaultValue);
        if (input.required === true && tokens.some((t) => state.secrets.some((s) => s.name === t)))
          return { error: `inputVariables.${name}: required can't be true with a secret default` };
        for (const token of tokens) {
          if (!state.secrets.some((s) => s.name === token) && !state.variables.some((v) => v.name === token)) {
            unresolvedReferences.push({ token, path: `inputVariables.${name}.defaultValue`, reason: 'no variable, entity or secret has this name' });
          }
        }
      }
      return { unresolvedReferences };
    };
    if (p === '/v2/stable/tool' && method === 'POST') {
      if (body.type !== 'function' || !state.functions.some((f) => f.id === body.functionID)) return refused(400, 'functionID must name a function');
      if (!body.target?.global) return refused(400, 'target is required');
      const checked = checkInputs(body.inputVariables ?? {}, body.functionID);
      if ('error' in checked) return refused(400, checked.error!);
      const tool = {
        id: id('tool'),
        type: 'function',
        functionID: body.functionID,
        description: body.description ?? null,
        inputVariables: body.inputVariables ?? {},
        target: body.target,
      };
      state.tools.push(tool);
      return json(201, { tool, unresolvedReferences: checked.unresolvedReferences });
    }
    if ((m = p.match(/^\/v2\/stable\/tool\/([^/]+)$/))) {
      const tool = state.tools.find((t) => t.id === m![1]);
      if (!tool) return refused(404, 'Tool not found');
      if (method === 'PATCH') {
        const checked = checkInputs(body.inputVariables ?? tool.inputVariables, tool.functionID);
        if ('error' in checked) return refused(400, checked.error!);
        Object.assign(tool, { description: body.description ?? tool.description, inputVariables: body.inputVariables ?? tool.inputVariables });
        return json(200, { message: 'Updated', unresolvedReferences: checked.unresolvedReferences });
      }
      if (method === 'DELETE') {
        if (query.type !== 'function') return refused(400, 'type is required');
        state.tools.splice(state.tools.indexOf(tool), 1);
        return json(200, { message: 'Deleted' });
      }
    }

    // Variables and secrets
    if (p === '/v2/stable/variable' && method === 'GET') return json(200, { variables: state.variables });
    if (p === '/v2/stable/variable' && method === 'POST') {
      if (!/^\w{1,64}$/.test(body.name ?? '') || !body.color) return refused(400, 'name and color are required');
      if (names.has(body.name)) return refused(409, 'A variable or entity already has this name');
      names.add(body.name);
      const v = { id: id('var'), name: body.name, color: body.color, description: body.description ?? null, isSystem: false };
      state.variables.push(v);
      return json(201, { variable: v });
    }
    if (p === '/v2/stable/secret' && method === 'GET') return json(200, { secrets: state.secrets });
    if (p === '/v2/stable/secret' && method === 'POST') {
      if (!/^\w{1,64}$/.test(body.name ?? '')) return refused(400, 'name is invalid');
      if (state.secrets.some((s) => s.name === body.name)) return refused(409, 'A secret already has this name');
      const secret = { id: id('sec'), name: body.name, visibility: body.visibility ?? 'masked', hasValue: Boolean(body.defaultValue) };
      state.secrets.push(secret);
      if (body.defaultValue) state.secretValues.push({ secretID: secret.id, value: body.defaultValue, environmentAlias: 'main', versionVariant: 'published' });
      return json(201, { secret });
    }
    if ((m = p.match(/^\/v1\/stable\/secret\/([^/]+)\/value$/)) && method === 'PUT') {
      const secret = state.secrets.find((s) => s.id === m![1]);
      if (!secret) return refused(404, 'Secret not found');
      if (!body.value) return refused(400, 'value is required');
      if (body.environmentAlias && !body.versionVariant) return refused(400, 'versionVariant is required with environmentAlias');
      secret.hasValue = true;
      state.secretValues.push({ secretID: secret.id, value: body.value, environmentAlias: body.environmentAlias, versionVariant: body.versionVariant });
      return json(200, { message: 'Updated', environmentAlias: body.environmentAlias ?? 'main', versionVariant: body.versionVariant ?? 'published' });
    }
    if ((m = p.match(/^\/v1\/stable\/environment\/([^/]+)\/compile$/)) && method === 'PUT') {
      state.compiles.push(decodeURIComponent(m[1]!));
      return json(200, { message: 'Compiled', durationMs: 1 });
    }
    return refused(404, `No fake for ${method} ${p}`);
  };
  /** What a caller wrote, leaving out reads. */
  const writes = () => state.calls.filter((c) => c.method !== 'GET');
  return { fetch: fetch as typeof globalThis.fetch, state, writes };
}

// ── The function sandbox ────────────────────────────────────────────────────

export interface FunctionResult {
  outputVars?: Record<string, string | number | boolean>;
  next?: { path?: string; listen?: boolean };
  trace?: { type: string; payload?: any }[];
}

/**
 * Runs a Voiceflow function's source the way Voiceflow's sandbox does, as far
 * as a test can tell: no Node or browser globals (`Buffer`, `process`, `URL`,
 * `URLSearchParams`, `setTimeout`, `atob`…), only the language's own, and a
 * `fetch` whose response carries `json` and `text` as properties. Code that
 * reaches for anything else fails here as it would there. The result is
 * returned as JSON would carry it.
 */
export async function runFunction(code: string, inputVars: Record<string, unknown>, options: { fetch?: typeof fetch } = {}): Promise<FunctionResult> {
  const { createContext, runInContext } = await import('node:vm');
  const outer = options.fetch ?? fetch;
  const vfFetch = async (url: string, init: RequestInit = {}) => {
    const res = await outer(url, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: Object.fromEntries((res.headers as any).entries()), json, text };
  };
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const context = createContext({ fetch: vfFetch, console: quiet });
  const source = code.replace(/^export default (async function main\s*\()/m, '$1');
  if (source === code) throw new Error('runFunction: the code has no `export default async function main(`');
  const main = runInContext(`${source}\n;main`, context, { timeout: 1000 });
  const result = await main({ inputVars: JSON.parse(JSON.stringify(inputVars)) });
  return JSON.parse(JSON.stringify(result ?? {}));
}
