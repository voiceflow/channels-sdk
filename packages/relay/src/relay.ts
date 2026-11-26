// One server for many agents' channels. Each connection is one Voiceflow
// agent on one or more channels, with its own credentials, kept in a store
// and sealed. A platform's webhook (and the agent's server tools, which call
// the same address) reaches `/v1/hooks/<connection>/<channel>`, and the relay
// answers it with that connection's own bot: `createChannels`, as a server of
// your own would make it, made once per instance and kept while unchanged.
//
// The decisions behind it:
// - Connections are kept apart. Each one's state is under its own prefix
//   (`namespacedState`), and each signs its turns' passes with a key of its
//   own, made at random: never its Voiceflow API key, and never another's.
// - Whoever adds a connection proves the agent is theirs: Voiceflow has to
//   let their key read the project. They get a management token, shown once
//   and kept only as a hash, and every later change needs it.
// - The relay only runs turns. It reads the project once to check the key, and
//   never installs a tool, writes to the agent or publishes. `connect` does
//   that on the person's own machine, with their own key.
// - What a connection gives is checked against what its channels take: only
//   credentials, never an address, so nothing points the relay elsewhere.
// - Nothing it answers or reports carries a credential: errors are cleaned of
//   the connection's own before they reach `onError`.
// - The operator's switch (`setDisabled`) turns one connection off at once,
//   on every instance: each request reads its connection's record.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type ChannelSpec, type Channels, createChannels, redact } from '@voiceflow/channels-sdk';
import { DEFAULT_API_URL } from '@voiceflow/channels-sdk/install';
import type { StateAdapter, WebhookOptions } from 'chat';
import { open, type RelayKeys, seal } from './seal.js';
import { namespacedState } from './state.js';
import type { ConnectionRecord, ConnectionStore } from './store.js';

/** A channel a connection can have: the credentials it takes, and how its bot is made from them. */
export interface RelayChannel {
  /**
   * The credentials a connection gives for this channel, by name: each is
   * required, and nothing else is taken. Offer only a channel whose adapter
   * checks every request it is sent with one of these: Slack's signing
   * secret, say. Never take an address here.
   */
  credentials: readonly string[];
  /** The channel for one connection, from its credentials: `slack({ adapter: { botToken, signingSecret } })`. */
  channel(credentials: Readonly<Record<string, string>>): ChannelSpec;
}

export interface RelayOptions {
  /** Where the relay is reached: `https://channels.voiceflow.com`. The addresses it gives out start with it; a request's own Host never does. */
  publicURL: string;
  store: ConnectionStore;
  /** The keys connections are sealed with (`parseKeys`). */
  keys: RelayKeys;
  /** One state store for every connection. Each sees only its own part of it. */
  state: StateAdapter;
  /** The channels a connection can have, by their slug in Chat SDK's catalog. */
  channels: Readonly<Record<string, RelayChannel>>;
  /** Voiceflow's addresses and timeout, for every connection. A connection can't set them. */
  voiceflow?: { runtimeURL?: string; apiURL?: string; timeoutMs?: number; fetch?: typeof fetch };
  /** Called when something fails, with its message cleaned of the connection's credentials. Default: the console. */
  onError?: (error: Error, context: { connection?: string }) => void;
  /** How many connections' bots one instance keeps ready. Default: 200. */
  cacheSize?: number;
}

export interface Relay {
  /** Answers a request to the relay: a webhook, a tool's call, or the connections API. */
  fetch(request: Request, options?: WebhookOptions): Promise<Response>;
  /** The operator's switch: a connection turned off answers nothing until it is turned back on. `false` when there's no such connection. */
  setDisabled(id: string, disabled: boolean): Promise<boolean>;
}

/** What a connection's record seals. */
interface Secrets {
  apiKey: string;
  /** Signs the connection's turn passes. */
  toolSecret: string;
  channels: Record<string, Record<string, string>>;
}

/** A connection's bot, kept between requests while its record is at `revision`. */
interface Bot {
  revision: number;
  channels: Promise<Channels>;
  /** Its credentials, to clean out of whatever it reports. */
  known: readonly string[];
}

const ID = /^c_[A-Za-z0-9_-]{22}$/;
const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 64 * 1024;
const MAX_CREDENTIAL = 8192;
const DEFAULT_CACHE = 200;

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const problem = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const NOT_FOUND = () => problem(404, 'not_found', "There's nothing here.");
const NO_CONNECTION = () => problem(404, 'not_found', "There's no connection with that ID that this token opens.");

/** A request the relay refuses, with what to tell the caller. */
class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && x.length === y.length && timingSafeEqual(x, y);
}

export function createRelay(options: RelayOptions): Relay {
  const publicURL = new URL(options.publicURL).origin;
  const doFetch = options.voiceflow?.fetch ?? fetch;
  const apiURL = (options.voiceflow?.apiURL ?? DEFAULT_API_URL).replace(/\/$/, '');
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE;
  /** Each connection's bot, at the revision it was made from; the longest unused first. */
  const bots = new Map<string, Bot>();
  const now = () => new Date().toISOString();

  const report = (error: unknown, context: { connection?: string }, secrets: readonly string[] = []) => {
    const cleaned = new Error(redact(error instanceof Error ? error.message : String(error), secrets));
    cleaned.name = error instanceof Error ? error.name : 'Error';
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string') (cleaned as Error & { code?: string }).code = code;
    try {
      if (options.onError) options.onError(cleaned, context);
      else console.error(`[channels-relay]${context.connection ? ` ${context.connection}:` : ''} ${cleaned.name}: ${cleaned.message}`);
    } catch {
      // A failing error handler must not fail the request with it.
    }
  };

  const secretsOf = (s: Secrets) => [s.apiKey, s.toolSecret, ...Object.values(s.channels).flatMap((c) => Object.values(c))];

  const describe = (record: ConnectionRecord) => ({
    id: record.id,
    projectID: record.projectID,
    workspaceID: record.workspaceID,
    environment: record.environment,
    disabled: record.disabled,
    // The one address each channel needs: its webhook, which the agent's server tools call too.
    channels: Object.fromEntries(record.channels.map((slug) => [slug, { url: `${publicURL}/v1/hooks/${record.id}/${slug}` }])),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  function forget(id: string) {
    bots.delete(id);
  }

  /** The connection's bot, made from its record once per revision, with the credentials to keep out of what it reports. */
  function botFor(record: ConnectionRecord): Bot {
    const kept = bots.get(record.id);
    if (kept && kept.revision === record.revision) {
      bots.delete(record.id);
      bots.set(record.id, kept);
      return kept;
    }
    const secrets = open<Secrets>(options.keys, record.id, record.sealed);
    const known = secretsOf(secrets);
    const made = (async () =>
      createChannels({
        voiceflow: {
          apiKey: secrets.apiKey,
          projectID: record.projectID,
          environment: record.environment,
          ...(options.voiceflow?.runtimeURL ? { runtimeURL: options.voiceflow.runtimeURL } : {}),
          ...(options.voiceflow?.timeoutMs ? { timeoutMs: options.voiceflow.timeoutMs } : {}),
          ...(options.voiceflow?.fetch ? { fetch: options.voiceflow.fetch } : {}),
        },
        channels: record.channels.map((slug) => {
          const offered = Object.hasOwn(options.channels, slug) ? options.channels[slug] : undefined;
          if (!offered) throw new Error(`Connection ${record.id} has channel "${slug}", which this relay no longer offers.`);
          return offered.channel(secrets.channels[slug] ?? {});
        }),
        // Its own part of the store, and its own pass key: a thread or a pass of another connection's means nothing here.
        state: namespacedState(options.state, `relay:${record.id}`),
        toolSecret: secrets.toolSecret,
        onError: (error) => report(error, { connection: record.id }, known),
      }))();
    const bot: Bot = { revision: record.revision, channels: made, known };
    // A bot that couldn't be made is made again on the next request.
    made.catch(() => {
      if (bots.get(record.id) === bot) bots.delete(record.id);
    });
    bots.delete(record.id);
    bots.set(record.id, bot);
    while (bots.size > cacheSize) bots.delete(bots.keys().next().value!);
    return bot;
  }

  async function hook(id: string, slug: string, request: Request, webhookOptions?: WebhookOptions): Promise<Response> {
    if (!ID.test(id) || !SLUG.test(slug)) return NOT_FOUND();
    const record = await options.store.get(id);
    // Off, gone or never there: the same answer, so the address says nothing about which.
    if (!record || record.disabled || !record.channels.includes(slug)) return NOT_FOUND();
    let known: readonly string[] = [];
    try {
      const bot = botFor(record);
      known = bot.known;
      return await (await bot.channels).webhook(slug, request, webhookOptions);
    } catch (error) {
      report(error, { connection: record.id }, known);
      return problem(500, 'failed', "This connection couldn't answer.");
    }
  }

  // ── The connections API ─────────────────────────────────────────────────

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) throw new Refused(413, 'too_large', 'That is more than a connection takes.');
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Refused(413, 'too_large', 'That is more than a connection takes.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Refused(400, 'not_json', "The request wasn't JSON.");
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Refused(400, 'not_json', 'The request is a JSON object.');
    return parsed as Record<string, unknown>;
  }

  const objectAt = (value: unknown, where: string): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refused(400, 'invalid', `\`${where}\` is an object.`);
    return value as Record<string, unknown>;
  };
  /** Anything a request sets beyond what it may is refused, not ignored: a Voiceflow address, say, or turning a connection back on. */
  const only = (value: Record<string, unknown>, names: readonly string[], where: string) => {
    const extra = Object.keys(value).filter((name) => !names.includes(name));
    if (extra.length) throw new Refused(400, 'invalid', `${where} takes ${names.map((n) => `\`${n}\``).join(', ')}, and nothing else.`);
  };
  const nameAt = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || !NAME.test(value)) throw new Refused(400, 'invalid', `\`${where}\` is 1 to 64 letters, digits, "_" or "-".`);
    return value;
  };
  const keyAt = (value: unknown): string => {
    if (typeof value !== 'string' || value.length < 8 || value.length > 1024 || /\s/.test(value)) {
      throw new Refused(400, 'invalid', '`voiceflow.apiKey` is a Voiceflow API key.');
    }
    return value;
  };

  /** A channel's credentials, exactly the ones it takes. Errors name fields, never values. */
  function credentialsFor(slug: string, value: unknown): Record<string, string> {
    const offered = Object.hasOwn(options.channels, slug) ? options.channels[slug] : undefined;
    if (!SLUG.test(slug) || !offered) {
      throw new Refused(400, 'unknown_channel', `This relay has no "${slug.slice(0, 32)}" channel. It has: ${Object.keys(options.channels).join(', ')}.`);
    }
    const given = objectAt(value, `channels.${slug}`) ?? {};
    const extra = Object.keys(given).filter((name) => !offered.credentials.includes(name));
    if (extra.length) throw new Refused(400, 'invalid', `${slug} takes ${offered.credentials.join(', ')}, and nothing else.`);
    const out: Record<string, string> = {};
    for (const name of offered.credentials) {
      const credential = given[name];
      if (typeof credential !== 'string' || !credential || credential.length > MAX_CREDENTIAL) {
        throw new Refused(400, 'invalid', `${slug} needs \`${name}\`.`);
      }
      out[name] = credential;
    }
    return out;
  }

  /** The project the key reads, or a refusal: the key has to be able to read the very project it is for. */
  async function projectFor(apiKey: string, projectID: string): Promise<{ id: string; workspaceID: string }> {
    let res: Response;
    try {
      res = await doFetch(`${apiURL}/v1/stable/project/${encodeURIComponent(projectID)}`, { headers: { authorization: apiKey, accept: 'application/json' } });
    } catch {
      throw new Refused(502, 'voiceflow_unavailable', "Voiceflow couldn't be reached to check the key. Try again.");
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new Refused(401, 'key_refused', `That Voiceflow API key can't read project ${projectID}.`);
    }
    if (!res.ok) throw new Refused(502, 'voiceflow_unavailable', `Voiceflow answered ${res.status} when the key was checked. Try again.`);
    const project = ((await res.json().catch(() => null)) as { project?: { id?: unknown; workspaceID?: unknown } } | null)?.project;
    if (project?.id !== projectID || typeof project.workspaceID !== 'string') {
      throw new Refused(401, 'key_refused', `That Voiceflow API key can't read project ${projectID}.`);
    }
    return { id: projectID, workspaceID: project.workspaceID };
  }

  /** The connection this request's token opens, or `null`: a wrong token and a missing connection look the same. */
  async function authorized(request: Request, id: string): Promise<ConnectionRecord | null> {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token || !ID.test(id)) return null;
    const record = await options.store.get(id);
    return record && sameHash(hash(token), record.tokenHash) ? record : null;
  }

  async function create(request: Request): Promise<Response> {
    const input = await body(request);
    only(input, ['voiceflow', 'channels'], 'A connection');
    const voiceflow = objectAt(input.voiceflow, 'voiceflow');
    if (!voiceflow) throw new Refused(400, 'invalid', 'A connection needs `voiceflow`: its `apiKey` and `projectID`.');
    only(voiceflow, ['apiKey', 'projectID', 'environment'], '`voiceflow`');
    const apiKey = keyAt(voiceflow.apiKey);
    const projectID = nameAt(voiceflow.projectID, 'voiceflow.projectID');
    const environment = voiceflow.environment === undefined ? 'production' : nameAt(voiceflow.environment, 'voiceflow.environment');
    const channels: Record<string, Record<string, string>> = {};
    for (const [slug, value] of Object.entries(objectAt(input.channels, 'channels') ?? {})) channels[slug] = credentialsFor(slug, value);
    const project = await projectFor(apiKey, projectID);

    const id = `c_${randomBytes(16).toString('base64url')}`;
    const token = `vfr_${randomBytes(32).toString('base64url')}`;
    const secrets: Secrets = { apiKey, toolSecret: randomBytes(32).toString('base64url'), channels };
    const at = now();
    const record: ConnectionRecord = {
      id,
      projectID: project.id,
      workspaceID: project.workspaceID,
      environment,
      channels: Object.keys(channels).sort(),
      disabled: false,
      tokenHash: hash(token),
      sealed: seal(options.keys, id, secrets),
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    await options.store.create(record);
    // The token is shown this once: only its hash is kept.
    return json(201, { ...describe(record), token });
  }

  async function change(request: Request, record: ConnectionRecord): Promise<Response> {
    const input = await body(request);
    only(input, ['voiceflow', 'channels'], 'A change');
    const voiceflow = objectAt(input.voiceflow, 'voiceflow') ?? {};
    only(voiceflow, ['apiKey', 'projectID', 'environment'], '`voiceflow`');
    if (voiceflow.projectID !== undefined && voiceflow.projectID !== record.projectID) {
      throw new Refused(400, 'invalid', "A connection's project doesn't change. Make a new connection for another agent.");
    }
    const secrets = open<Secrets>(options.keys, record.id, record.sealed);
    let { workspaceID } = record;
    if (voiceflow.apiKey !== undefined) {
      secrets.apiKey = keyAt(voiceflow.apiKey);
      ({ workspaceID } = await projectFor(secrets.apiKey, record.projectID));
    }
    const environment = voiceflow.environment === undefined ? record.environment : nameAt(voiceflow.environment, 'voiceflow.environment');
    // A channel given is replaced whole; one given as null is taken off.
    for (const [slug, value] of Object.entries(objectAt(input.channels, 'channels') ?? {})) {
      if (value === null) delete secrets.channels[slug];
      else secrets.channels[slug] = credentialsFor(slug, value);
    }
    const next: ConnectionRecord = {
      ...record,
      workspaceID,
      environment,
      channels: Object.keys(secrets.channels).sort(),
      sealed: seal(options.keys, record.id, secrets),
      revision: record.revision + 1,
      updatedAt: now(),
    };
    if (!(await options.store.update(next, record.revision))) throw new Refused(409, 'conflict', 'The connection changed while this was sent. Send it again.');
    forget(record.id);
    return json(200, describe(next));
  }

  async function newToken(record: ConnectionRecord): Promise<Response> {
    const token = `vfr_${randomBytes(32).toString('base64url')}`;
    const next: ConnectionRecord = { ...record, tokenHash: hash(token), revision: record.revision + 1, updatedAt: now() };
    if (!(await options.store.update(next, record.revision))) throw new Refused(409, 'conflict', 'The connection changed while this was sent. Send it again.');
    return json(200, { ...describe(next), token });
  }

  async function connections(request: Request, rest: string[]): Promise<Response> {
    const [id, action, ...more] = rest;
    if (id === undefined) return request.method === 'POST' ? create(request) : problem(405, 'method', 'Add a connection with POST.');
    if (more.length || (action !== undefined && action !== 'token')) return NOT_FOUND();
    const record = await authorized(request, id);
    if (!record) return NO_CONNECTION();
    if (action === 'token') return request.method === 'POST' ? newToken(record) : problem(405, 'method', 'Get a new token with POST.');
    switch (request.method) {
      case 'GET':
        return json(200, describe(record));
      case 'PATCH':
        return change(request, record);
      case 'DELETE':
        await options.store.delete(record.id);
        forget(record.id);
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      default:
        return problem(405, 'method', 'A connection takes GET, PATCH and DELETE.');
    }
  }

  return {
    async fetch(request, webhookOptions) {
      const parts = new URL(request.url).pathname.split('/').filter(Boolean);
      try {
        if (parts[0] === 'v1' && parts[1] === 'hooks' && parts.length === 4) return await hook(parts[2]!, parts[3]!, request, webhookOptions);
        if (parts[0] === 'v1alpha1' && parts[1] === 'connections') return await connections(request, parts.slice(2));
        return NOT_FOUND();
      } catch (error) {
        if (error instanceof Refused) return problem(error.status, error.code, error.message);
        report(error, {});
        return problem(500, 'failed', 'Something went wrong.');
      }
    },

    async setDisabled(id, disabled) {
      const changed = await setConnectionDisabled(options.store, id, disabled);
      if (changed) forget(id);
      return changed;
    },
  };
}

/**
 * The operator's switch, on the store itself: for a script, with no relay
 * running. Every instance reads the record on each request, so it takes hold
 * at once. `false` when there's no such connection, or it changed meanwhile.
 */
export async function setConnectionDisabled(store: ConnectionStore, id: string, disabled: boolean): Promise<boolean> {
  const record = await store.get(id);
  if (!record) return false;
  const next: ConnectionRecord = { ...record, disabled, revision: record.revision + 1, updatedAt: new Date().toISOString() };
  return store.update(next, record.revision);
}

/** Seals every connection still under an older key with the current one. Run it after a new key comes first in `keys`. */
export async function resealConnections(options: { store: ConnectionStore; keys: RelayKeys }): Promise<{ resealed: number; failed: string[] }> {
  let resealed = 0;
  const failed: string[] = [];
  for await (const record of options.store.list()) {
    if (record.sealed.key === options.keys.current) continue;
    try {
      const sealed = seal(options.keys, record.id, open(options.keys, record.id, record.sealed));
      const next: ConnectionRecord = { ...record, sealed, revision: record.revision + 1, updatedAt: new Date().toISOString() };
      if (await options.store.update(next, record.revision)) resealed++;
      else failed.push(record.id);
    } catch {
      failed.push(record.id);
    }
  }
  return { resealed, failed };
}
