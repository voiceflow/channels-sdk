// The conversation every channel has to carry, whatever the platform: the
// same tests for each channel's package, run against Chat SDK's real adapter
// and a stand-in for the platform that the package's tests supply. It is what
// lets a channel be added without first being run on the platform itself: a
// message that isn't the platform's is refused, one that is gets the agent's
// answer, a choice can be taken, a long answer arrives whole, what the agent
// writes is readable there, connect sets it up, and nothing leaves this machine.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StateAdapter } from 'chat';
import { capabilities, platformEntry } from './catalog.js';
import { type ChannelSpec, createChannels } from './channels.js';
import type { ChannelCommandSet } from './connect.js';
import { fakeVoiceflow, fakeVoiceflowApi, waiter } from './testing.js';
import type { Trace } from './voiceflow.js';

/** One thing the bot sent: its words, its buttons' labels, and the call as the platform got it. */
export interface SentItem {
  text: string;
  buttons: string[];
  raw: unknown;
}

/** A platform, for the tests: what it sends a bot, and what the bot sent it. */
export interface ChannelStandIn {
  /** The adapter's config that points it here, with made-up credentials. */
  adapter: Record<string, unknown>;
  /** Who `message` is from. */
  person: { id: string; name?: string };
  /** What the platform sends when that person writes `text` to the bot, where the bot answers every message: signed as the platform signs. */
  message(text: string): Request | Promise<Request>;
  /** The same from somebody else: not signed, or signed with another key. */
  forged(text: string): Request | Promise<Request>;
  /** What the bot sent since the last look, in order: messages only (not "typing", not reads). */
  sent(): SentItem[] | Promise<SentItem[]>;
  /**
   * The same person, in the same conversation, saying something that doesn't
   * mention the bot: only where a conversation has other people in it, and
   * the bot is spoken to by name.
   */
  unaddressed?(text: string): Request | Promise<Request>;
  /** A click on a button of something the bot sent: only where the platform has buttons. */
  click?(item: SentItem, label: string): Request | Promise<Request>;
  /** The longest text the platform takes in one message, where the stand-in refuses a longer one as the platform does. */
  maxTextLength?: number;
  /** True where the platform shows a message's text exactly as it was sent, mark for mark: a text message, say. */
  literal?: boolean;
  /** True where a conversation is a whole room that anyone speaks in, and not a thread about one thing. */
  room?: boolean;
  close(): Promise<void>;
}

export interface ChannelContractOptions {
  /** The channel's name in Chat SDK's catalog. */
  slug: string;
  /** The package's channel: `telegram`, say. */
  channel: (options?: { adapter?: Record<string, unknown>; context?: boolean; follow?: boolean }) => ChannelSpec;
  /** The package's variables. */
  variables: Record<string, string>;
  /** The package's commands. */
  commands: ChannelCommandSet;
  /** Starts a stand-in for the platform. */
  start: () => Promise<ChannelStandIn>;
  /** Makes the bot's state: `createMemoryState`. */
  state: () => StateAdapter;
}

const text = (message: string): Trace => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } }) as unknown as Trace;
const CHOICES = ['Track order', 'Talk to someone'];
/** Two things as a numbered list, in whatever marks the platform keeps: "1. One", "(1) One", "1) One". */
const NUMBERED = (one: string, two: string) => new RegExp(`(^|\\s)\\(?1[.)]\\s*${one}[\\s\\S]*\\s\\(?2[.)]\\s*${two}`);
const silent = { child: () => silent, debug() {}, info() {}, warn() {}, error() {} };

/** What a test is given by `setup`: the platform's stand-in, the scripted agent, and a way to send the bot a request. */
export interface ChannelHarness {
  platform: ChannelStandIn;
  voiceflow: ReturnType<typeof fakeVoiceflow>;
  /** What reached `onError`. */
  errors: unknown[];
  /** Sends the bot a request, and waits for everything it started to finish. */
  send(request: Request | Promise<Request>): Promise<Response>;
  /** What the agent was asked, turn by turn. */
  said(): unknown[];
}

/**
 * A bot on the channel, for a test: Chat SDK's real adapter and the core's
 * agent, a stand-in for the platform and a scripted Voiceflow runtime. The
 * contract below runs on it, and a package's own tests of what only its
 * platform has can too. Call it once per test file: it stops anything from
 * leaving this machine, and closes each test's stand-ins when the test ends.
 */
export function channelHarness(options: Pick<ChannelContractOptions, 'slug' | 'channel' | 'start' | 'state'>) {
  const { slug } = options;

  // Whatever the adapter reaches for beyond this machine is stopped and written down.
  const outside: string[] = [];
  for (const transport of [http, https]) {
    const request = transport.request;
    (transport as { request: unknown }).request = function guarded(this: unknown, ...args: unknown[]) {
      const req = (request as (...a: unknown[]) => http.ClientRequest).apply(this, args);
      const host = String(req.getHeader?.('host') ?? req.host ?? '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        outside.push(`${req.method} ${host}${req.path}`);
        req.destroy(new Error('the tests reach nothing outside this machine'));
      }
      return req;
    };
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
    outside.push(`${init?.method ?? 'GET'} ${url}`);
    return Promise.reject(new Error('the tests reach nothing outside this machine'));
  }) as typeof fetch;

  /** The stand-ins a test started: each is closed when the test ends, passed or failed. */
  const started: ChannelStandIn[] = [];
  test.afterEach(async () => {
    await Promise.all(started.splice(0).map((standIn) => standIn.close()));
    assert.deepEqual(outside.splice(0), [], 'nothing was reached outside this machine');
  });

  async function setup(
    answer?: (action: { type: string; payload?: unknown }) => Trace[],
    channelOptions: { context?: boolean; follow?: boolean; adapter?: Record<string, unknown> } = {},
  ) {
    const platform = await options.start();
    started.push(platform);
    const errors: unknown[] = [];
    const voiceflow = fakeVoiceflow(
      (answer ??
        ((action) => {
          if (action.type === 'path-track') return [text('It ships tomorrow.')];
          return [
            text(`You said: ${typeof action.payload === 'string' ? action.payload : action.type}`),
            {
              type: 'choice',
              payload: { buttons: [{ name: CHOICES[0], request: { type: 'path-track', payload: { label: CHOICES[0] } } }, { name: CHOICES[1] }] },
            } as unknown as Trace,
          ];
        })) as Parameters<typeof fakeVoiceflow>[0],
    );
    const channels = await createChannels({
      voiceflow: { apiKey: `VF.DM.${slug}-contract`, projectID: 'proj1', environment: 'development', fetch: voiceflow.fetch },
      channels: [options.channel({ ...channelOptions, adapter: { logger: silent, ...platform.adapter, ...channelOptions.adapter } })],
      state: options.state(),
      onError: (error) => errors.push(error),
    });
    const wait = waiter();
    const send = async (request: Request | Promise<Request>) => {
      const response = await channels.webhook(slug, await request, wait.options);
      await wait.settle();
      // The adapter answers the platform, then goes on: what it started is given a moment to finish.
      for (let quiet = 0, seen = -1; quiet < 3; ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await wait.settle();
        const now = voiceflow.interacts.length;
        quiet = now === seen ? quiet + 1 : 0;
        seen = now;
      }
      return response;
    };
    return { platform, voiceflow, errors, send, said: () => voiceflow.interacts.map((turn) => turn.action) } satisfies ChannelHarness;
  }
  return { setup, started };
}

/** Runs the conversation every channel has to carry. Call it from a test file: it registers its tests with `node:test`. */
export function channelContract(options: ChannelContractOptions): void {
  const { slug } = options;
  const { name } = platformEntry(slug);
  const extension = (options.channel() as Extract<ChannelSpec, object>).extension;
  // What the platform can show, as the agent is told: the catalog's word, and the channel's own where it knows better.
  const can = { ...capabilities(slug), ...extension?.capabilities };
  const { setup, started } = channelHarness(options);
  const words = (items: SentItem[]) => items.map((item) => item.text).join('\n');

  test(`${name}: the channel is Chat SDK's adapter, with its module along for a bundled server`, () => {
    const spec = options.channel() as Extract<ChannelSpec, object>;
    assert.equal(spec.slug, slug);
    assert.equal(typeof spec.module?.[platformEntry(slug).factoryExport], 'function');
    assert.equal(spec.extension?.slug, slug);
    assert.deepEqual(Object.keys(options.variables), [`${slug}_user_id`, `${slug}_user_name`, `${slug}_thread_id`, `${slug}_message_id`]);
  });

  test(`${name}: a request that isn't ${name}'s is refused, and nothing happens`, async () => {
    const t = await setup();
    const response = await t.send(t.platform.forged('hello'));
    assert.ok(response.status >= 400 && response.status < 500, `refused with ${response.status}`);
    assert.equal(t.voiceflow.interacts.length, 0, 'the agent was told nothing');
    assert.deepEqual(await t.platform.sent(), [], 'and nothing was sent');
  });

  test(`${name}: a message gets the agent's answer, and its choices can be taken`, async () => {
    const t = await setup();
    const response = await t.send(t.platform.message('where is my order?'));
    assert.ok(response.status < 300, `taken with ${response.status}`);
    assert.deepEqual(t.said(), [{ type: 'text', payload: 'where is my order?' }], "the agent is sent the person's words, and only them");
    const first = await t.platform.sent();
    assert.match(words(first), /You said: where is my order\?/);
    const offered = first.find((item) => item.buttons.length);
    if (can.buttons) {
      assert.deepEqual(offered?.buttons, CHOICES, 'its choices are buttons');
    } else {
      assert.equal(offered, undefined, `${name} is sent no buttons`);
      assert.match(words(first), NUMBERED('Track order', 'Talk to someone'), 'its choices are a numbered list');
    }
    // A click where there are buttons; the number, typed, where there are none.
    await t.send(can.buttons && offered && t.platform.click ? t.platform.click(offered, CHOICES[0]!) : t.platform.message('1'));
    assert.deepEqual(t.said().at(-1), { type: 'path-track', payload: { label: 'Track order' } });
    assert.match(words(await t.platform.sent()), /It ships tomorrow\./);
    assert.deepEqual(t.errors, []);
  });

  test(`${name}: who and where are set as variables, every one on every turn`, async () => {
    const t = await setup();
    await t.send(t.platform.message('hello'));
    const variables = t.voiceflow.interacts.at(-1)?.variables as Record<string, string>;
    assert.deepEqual(Object.keys(variables).sort(), Object.keys(options.variables).sort());
    assert.equal(variables[`${slug}_user_id`], t.platform.person.id);
    // Where the platform gives no name, none is made of the person's ID or number.
    assert.equal(variables[`${slug}_user_name`], t.platform.person.name ?? '');
    assert.ok(variables[`${slug}_thread_id`], 'the conversation is named');
    assert.ok(variables[`${slug}_message_id`], 'and the message');

    const off = await setup(undefined, { context: false });
    await off.send(off.platform.message('hello'));
    assert.deepEqual(off.voiceflow.interacts.at(-1)?.variables ?? {}, {}, 'context: false sets none');
  });

  test(`${name}: what isn't said to the bot is answered only in a conversation it is following`, async (context) => {
    const probe = await options.start();
    started.push(probe);
    if (!probe.unaddressed) return context.skip(`the stand-in for ${name} says nothing that isn't to the bot`);
    // A room's bot answers its name and nothing else; a thread's goes on with the conversation.
    const follows = !probe.room;
    for (const follow of [true, false]) {
      const t = await setup(undefined, { follow });
      await t.send(t.platform.unaddressed!('is anyone there?'));
      assert.equal(t.voiceflow.interacts.length, 0, 'before a mention, nothing is answered');
      await t.send(t.platform.message('hello'));
      assert.equal(t.voiceflow.interacts.length, 1, 'a mention is');
      await t.platform.sent();
      await t.send(t.platform.unaddressed!('and another thing'));
      assert.equal(t.voiceflow.interacts.length, follow ? 2 : 1, follow ? 'and after it, what is said next' : 'and after it, only another mention');
      assert.equal((await t.platform.sent()).length > 0, follow);
      assert.deepEqual(t.errors, []);
    }
    // Left alone, the channel does what its platform calls for.
    const t = await setup();
    await t.send(t.platform.message('hello'));
    await t.send(t.platform.unaddressed!('and another thing'));
    assert.equal(
      t.voiceflow.interacts.length,
      follows ? 2 : 1,
      follows ? `${name}'s bot follows a conversation by default` : `${name}'s bot answers only a mention by default`,
    );
  });

  test(`${name}: a long answer arrives whole`, async () => {
    const probe = await options.start();
    started.push(probe);
    const limit = probe.maxTextLength;
    const sentences = Array.from(
      { length: Math.ceil(((limit ?? 1500) * 3) / 60) },
      (_, i) => `Sentence number ${i + 1} of a long answer about the returns policy.`,
    );
    const long = sentences.join(' ');
    const t = await setup(() => [text(long)]);
    await t.send(t.platform.message('tell me everything'));
    const parts = (await t.platform.sent()).map((item) => item.text);
    assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), long, 'the whole answer, in order');
    if (limit) {
      assert.ok(parts.length > 1, `in ${parts.length} messages`);
      assert.ok(
        parts.every((part) => part.length <= limit),
        `each within ${name}'s ${limit} characters`,
      );
    }
    assert.deepEqual(t.errors, [], `and ${name} refused none of it`);
  });

  test(`${name}: what the agent writes is readable there: a link keeps its address, a list its numbers`, async () => {
    const written = 'Read the **returns policy** at [our site](https://example.com/returns).\n\n1. Send it back\n2. Get a refund';
    const t = await setup(() => [text(written)]);
    await t.send(t.platform.message('how do returns work?'));
    const items = await t.platform.sent();
    const got = words(items);
    assert.match(got, /returns policy/);
    // In the words themselves, or behind them where the platform shows a link as its label.
    assert.match(JSON.stringify(items), /https:\/\/example\.com\/returns/, "the link's address is there to follow");
    assert.match(got, NUMBERED('Send it back', 'Get a refund'), 'and the list is still numbered');
    if (t.platform.literal) {
      assert.match(got, /https:\/\/example\.com\/returns/, 'written out, where a link is only its words');
      // Where text is shown as typed, none of Markdown's marks are sent for a person to read.
      assert.doesNotMatch(got, /\*\*|\]\(|\\[.!()-]/, `${name} is sent plain words`);
    }
    assert.deepEqual(t.errors, []);
  });

  test(`${name}: a card and a picture are shown, or said in words`, async () => {
    const card = {
      title: 'Plan A',
      description: { text: 'The basic plan' },
      imageUrl: 'https://example.com/a.png',
      buttons: [{ name: 'Pick A', request: { type: 'pick-a' } }],
    };
    const t = await setup(() => [text('Here is the plan:'), { type: 'cardV2', payload: card } as unknown as Trace]);
    await t.send(t.platform.message('show me'));
    const shown = JSON.stringify(await t.platform.sent());
    assert.match(shown, /Here is the plan:/);
    assert.match(shown, /Plan A/);
    assert.match(shown, /The basic plan/);
    assert.match(shown, /Pick A/);
    assert.deepEqual(t.errors, []);
  });

  test(`${name}: its commands are the same as every channel's, and know what it needs`, async () => {
    const out: string[] = [];
    assert.equal(await options.commands.cli(['--help'], { out: (line) => out.push(line), err: (line) => out.push(line), env: {} }), 0);
    assert.match(out.join('\n'), new RegExp(`voiceflow-channels connect ${slug} --env-file`));
    assert.equal(await options.commands.cli(['point'], { out: () => {}, err: () => {}, env: {} }), 2, 'point with no address is a mistake in the command');
    const { needed, made } = options.commands.settings;
    const agent = { VOICEFLOW_API_KEY: 'k', VOICEFLOW_PROJECT_ID: 'p' };
    const set = Object.fromEntries([...needed, ...made].map((key) => [key, 'x']));
    assert.equal(await options.commands.connected({ env: { ...set, ...agent } }), true, 'every setting and the agent: connected');
    assert.equal(await options.commands.connected({ env: set }), false, 'no agent: not connected');
    assert.equal(await options.commands.connected({ env: agent }), needed.length + made.length === 0, 'no settings: not connected');
    const some = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, 'x']));
    if (needed.length)
      assert.equal(await options.commands.connected({ env: { ...agent, ...some(made) } }), false, "without the platform's own settings: not connected");
    if (made.length)
      assert.equal(await options.commands.connected({ env: { ...agent, ...some(needed) } }), false, 'before connect has made its secret: not connected');
    if (needed.length) {
      const said: string[] = [];
      const code = await options.commands.cli(['connect', '--yes'], {
        out: (l) => said.push(l),
        err: (l) => said.push(l),
        env: { ...agent, VOICEFLOW_ENVIRONMENT: 'development' },
        interactive: false,
      });
      assert.equal(code, 3, 'it waits on a person');
      for (const key of needed) assert.match(said.join('\n'), new RegExp(`${key}=…`), `and says ${key} is missing`);
    }
  });

  test(`${name}: connect sets it up, and a second run changes nothing`, async () => {
    const { needed, made } = options.commands.settings;
    const dir = await mkdtemp(join(tmpdir(), `${slug}-connect-`));
    try {
      const envFile = join(dir, '.env.local');
      await writeFile(envFile, needed.map((key) => `${key}=contract-${key.toLowerCase()}\n`).join(''));
      const apiKey = `VF.DM.${slug}-connect`;
      const api = fakeVoiceflowApi({ project: { id: 'proj1', name: 'Contract Agent', workspaceID: 'ws1' }, apiKey });
      const env = { VOICEFLOW_API_KEY: apiKey, VOICEFLOW_PROJECT_ID: 'proj1', VOICEFLOW_ENVIRONMENT: 'development' };
      const run = async () => {
        const said: string[] = [];
        const code = await options.commands.cli(['connect', '--yes', '--env-file', envFile], {
          out: (l) => said.push(l),
          err: (l) => said.push(l),
          env,
          fetch: api.fetch as typeof fetch,
          interactive: false,
        });
        return { code, said: said.join('\n') };
      };
      const first = await run();
      assert.equal(first.code, 0, first.said);
      assert.deepEqual(api.state.variables.map((v) => v.name).sort(), Object.keys(options.variables).sort(), "the channel's variables are on the agent");
      assert.deepEqual(api.state.publishes, [], 'and nothing was published');
      const saved = Object.fromEntries(
        (await readFile(envFile, 'utf8'))
          .split('\n')
          .flatMap((line) => (line.includes('=') ? [[line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]] : [])),
      );
      for (const key of made) {
        assert.match(saved[key] ?? '', /^[0-9a-f]{64}$/, `${key} was made and saved`);
        assert.ok(!first.said.includes(saved[key]!), `and ${key} was never printed`);
      }
      assert.ok(!first.said.includes(apiKey), 'nor the Voiceflow key');
      assert.equal(await options.commands.connected({ envFile, env }), true);

      const calls = api.state.calls.filter((call) => call.method !== 'GET').length;
      const again = await run();
      assert.equal(again.code, 0, again.said);
      const after = await readFile(envFile, 'utf8');
      for (const key of made) assert.ok(after.includes(`${key}=${saved[key]}`), `${key} is the one already there`);
      assert.equal(api.state.variables.length, Object.keys(options.variables).length, 'no variable is made twice');
      assert.ok(api.state.calls.filter((call) => call.method !== 'GET').length - calls <= 1, 'and nothing but a compile is asked of Voiceflow');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
