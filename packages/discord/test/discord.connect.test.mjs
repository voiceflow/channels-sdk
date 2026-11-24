// `connect discord`, `point`, `disconnect` and `listen`, against a stand-in
// for Discord's API and a fake of Voiceflow's: the plan it shows before
// changing anything, what it changes, where it stops, and where the bot's
// token goes (Discord and the file you name, never a line it prints).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NeedsYou } from '@voiceflow/channels-sdk';
import { fakeVoiceflowApi } from '@voiceflow/channels-sdk/testing';
import { APP_FLAGS, BOT_PERMISSIONS, botNameOf, cli, createDiscordApi, installLink, listen, NEW_APPLICATION } from '../dist/connect/index.js';
import { CONTEXT_VARIABLES } from '../dist/index.js';
import { APP_ID, BOT_TOKEN, fakeDiscord } from './helpers/fake-discord.mjs';

const PROJECT = { id: 'proj1', name: 'Spike', workspaceID: 'ws1' };
const VF_KEY = 'VF.DM.discord-connect-test';
const PUBLIC = 'https://bot.example.com';
const VARIABLES = Object.keys(CONTEXT_VARIABLES).length;

/** Runs the command against the fakes, with an env file in a folder of its own. */
async function setup({
  api = {},
  file = { DISCORD_BOT_TOKEN: BOT_TOKEN, VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' },
  project = PROJECT,
  /** Images on the web, by URL: `{ bytes, type }`. */
  images = {},
} = {}) {
  const fake = await fakeDiscord(api);
  const voiceflow = fakeVoiceflowApi({ project, apiKey: VF_KEY });
  const dir = await mkdtemp(join(tmpdir(), 'discord-connect-'));
  const envFile = join(dir, '.env.local');
  if (file)
    await writeFile(
      envFile,
      `${Object.entries(file)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')}\n`,
    );
  /** The pages the command opened in the person's browser: none is ever really opened by a test. */
  const opened = [];
  const run = async (argv, io = {}) => {
    const out = [];
    const err = [];
    const code = await cli(argv, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: async (url) => (opened.push(url), true),
      env: { DISCORD_API_URL: fake.apiUrl },
      // Discord is the stand-in, over HTTP; a picture is wherever its URL says; everything else is Voiceflow's API.
      fetch: (url, init) => {
        const image = images[String(url)];
        if (image) return Promise.resolve(new Response(image.bytes, { status: image.status ?? 200, headers: { 'content-type': image.type } }));
        return String(url).startsWith('http://127.0.0.1') ? fetch(url, init) : voiceflow.fetch(url, init);
      },
      interactive: false,
      ...io,
    });
    return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') };
  };
  const writes = () =>
    fake
      .taken()
      .filter((c) => c.method !== 'GET')
      .map((c) => `${c.method} ${c.path}`);
  const env = async () =>
    Object.fromEntries(
      (await readFile(envFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  return { fake, voiceflow, envFile, run, writes, env, opened };
}

test('the link that adds the bot asks for what the bot uses, and nothing else', () => {
  // View and send in channels and threads, open and manage threads, read history, react, embed, attach, slash commands.
  assert.equal(BOT_PERMISSIONS, 328565115968n);
  assert.equal(installLink('123'), 'https://discord.com/oauth2/authorize?client_id=123&scope=bot+applications.commands&permissions=328565115968');
  // With a server, the page opens with it chosen.
  assert.equal(installLink('123', { server: '222222222222222222' }), `${installLink('123')}&guild_id=222222222222222222`);
});

test('the plan says everything it would do, and changes nothing', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const before = await readFile(s.envFile, 'utf8');
  const r = await s.run(['connect', '--env-file', s.envFile, '--dry-run']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Discord: app "Support Bot" \(111111111111111111\), bot support-bot/);
  assert.match(r.out, /~ name the bot "Spike", your agent's name in Voiceflow \(it is "support-bot" now; --name keep leaves it\)/);
  assert.match(r.out, /\+ set the bot's picture to Voiceflow's icon \(the agent has no avatar in Voiceflow\)/);
  assert.match(r.out, /\+ turn on the Message Content intent/);
  assert.match(r.out, /\+ add the \/ask command/);
  assert.match(r.out, /`voiceflow-channels dev` gives it to Discord each time it starts/);
  assert.match(r.out, /Voiceflow: project "Spike" \(proj1\) in workspace ws1, environment development/);
  assert.match(r.out, new RegExp(`\\+ ${VARIABLES} variables for your agent's prompts`));
  assert.match(r.out, /nothing is published, and nothing has to be/);
  assert.deepEqual(s.writes(), []);
  assert.equal(s.voiceflow.writes().length, 0);
  assert.equal(await readFile(s.envFile, 'utf8'), before);
  assert.ok(!r.all.includes(BOT_TOKEN) && !r.all.includes(VF_KEY));
});

test('without --yes and with nobody to ask, it shows the plan and changes nothing', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile]);
  assert.equal(r.code, 0);
  assert.match(r.err, /Nothing was changed: run it again with --yes/);
  assert.deepEqual(s.writes(), []);
});

test('from a bot token, connect does the rest', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 0, r.all);
  // The intent that lets the bot read messages, turned on without the portal.
  assert.equal(s.fake.state.app.flags & APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED, APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED);
  // The slash command, with the question as its one required option.
  assert.equal(s.fake.state.commands.length, 1);
  const [command] = s.fake.state.commands;
  assert.deepEqual(
    { name: command.name, type: command.type, description: command.description, options: command.options },
    {
      name: 'ask',
      type: 1,
      description: 'Ask Spike a question',
      options: [{ type: 3, name: 'question', description: 'What you want to ask', required: true }],
    },
  );
  // No address is given to Discord for a server on this machine: dev does that.
  assert.equal(s.fake.state.app.interactions_endpoint_url, null);
  // The agent's variables, on its draft, compiled; nothing published.
  assert.deepEqual(s.voiceflow.state.variables.map((v) => v.name).sort(), Object.keys(CONTEXT_VARIABLES).sort());
  assert.deepEqual(s.voiceflow.state.compiles, ['development']);
  assert.equal(s.voiceflow.state.publishes.length, 0);
  assert.equal(s.voiceflow.state.functions.length + s.voiceflow.state.secrets.length, 0);
  // What the server needs that nobody had to copy: read from Discord, written to the file.
  const env = await s.env();
  assert.equal(env.DISCORD_PUBLIC_KEY, s.fake.publicKey);
  assert.equal(env.DISCORD_APPLICATION_ID, APP_ID);
  assert.equal(env.DISCORD_BOT_TOKEN, BOT_TOKEN);
  assert.equal((await stat(s.envFile)).mode & 0o777, 0o600);
  assert.match(r.out, /\+ saved DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID to /);
  // How to add the bot, and what to run next.
  assert.ok(r.out.includes(installLink(APP_ID)));
  assert.match(r.out, /The bot is in no server yet/);
  assert.match(r.out, /voiceflow-channels dev -- <its command>/);
  assert.match(r.out, /DISCORD_BOT_TOKEN {7}in /);
  assert.ok(!r.all.includes(BOT_TOKEN) && !r.all.includes(VF_KEY), 'a secret was printed');
  // Discord refuses a request that doesn't say what sent it.
  assert.ok(s.fake.state.calls.every((c) => /^DiscordBot \(/.test(c.agent)));
  // Nobody is there, so no page is opened for anybody: the link is printed.
  assert.deepEqual(s.opened, []);
  assert.match(r.out, /Add it to one: open this link, pick the server, and authorize\./);

  // Run again: everything is there, and nothing is written anywhere.
  s.fake.taken();
  const wrote = s.voiceflow.writes().length;
  const again = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(again.code, 0, again.all);
  assert.match(again.out, /= the Message Content intent is on/);
  assert.match(again.out, /= the \/ask command is there/);
  assert.match(again.out, new RegExp(`= ${VARIABLES} variables: there already`));
  assert.deepEqual(s.writes(), []);
  assert.equal(s.voiceflow.writes().length, wrote);
});

test('with nobody there and nothing set, it stops once and says everything it waits on', async (t) => {
  const s = await setup({ file: null });
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile]);
  assert.equal(r.code, 3);
  assert.match(r.err, /No Voiceflow project/);
  assert.match(r.err, /No Voiceflow environment/);
  assert.match(r.err, /No Voiceflow API key/);
  // The one step by hand, said in full: where to make the app, and where the token goes.
  assert.match(r.err, /No Discord bot token\. Discord has no way to make an application from here/);
  assert.match(r.err, /https:\/\/discord\.com\/developers\/applications/);
  assert.match(r.err, /Reset Token/);
  assert.match(r.err, /DISCORD_BOT_TOKEN=<the token>.*Never in a chat or a command line/);
  assert.deepEqual(s.fake.taken(), [], 'Discord was called with no token');
  // The link goes straight to the dialog that makes an application. The agent isn't known yet, so its name isn't said.
  assert.ok(r.err.includes(`1. Make the application: ${NEW_APPLICATION}`), r.err);
  assert.match(r.err, /Name it after your agent/);
  assert.deepEqual(s.opened, []);

  // With the agent known, the stop says what to name the application: there is no way to fill it in for them.
  const known = await setup({ file: { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' } });
  t.after(known.fake.close);
  const r2 = await known.run(['connect', '--env-file', known.envFile]);
  assert.equal(r2.code, 3);
  assert.match(r2.err, /Name it "Spike": that name shows on the page that adds the bot/);
  assert.deepEqual(known.opened, []);
});

test('a person is shown the steps and asked for the token unseen, and it is saved for the server', async (t) => {
  const s = await setup({ file: { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' } });
  t.after(s.fake.close);
  const asked = [];
  const r = await s.run(['connect', '--env-file', s.envFile], {
    interactive: true,
    secret: async (q) => (asked.push(q), BOT_TOKEN),
    ask: async (q) => (asked.push(q), 'y'),
  });
  assert.equal(r.code, 0, r.all);
  // The dialog that makes an application is opened for them, and they're told what to name it.
  assert.ok(r.out.includes(`1. Make the application (the page is open in your browser): ${NEW_APPLICATION}`), r.out);
  assert.match(r.out, /Name it "Spike": that name shows on the page that adds the bot\. Tick the box and click Create\./);
  assert.deepEqual(asked, ['Discord bot token (hidden): ', '\nGo ahead? [y/N] ']);
  assert.equal((await s.env()).DISCORD_BOT_TOKEN, BOT_TOKEN);
  assert.ok(!r.all.includes(BOT_TOKEN));
  // And once it's connected, the page that adds the bot to a server: the one step left.
  assert.deepEqual(s.opened, [NEW_APPLICATION, installLink(APP_ID)]);
  assert.match(r.out, /The bot is in no server yet\. Add it to one: the page is open in your browser: pick the server, and authorize\./);

  // A person who says no changes nothing.
  const t2 = await setup();
  t.after(t2.fake.close);
  const no = await t2.run(['connect', '--env-file', t2.envFile], { interactive: true, ask: async () => 'n' });
  assert.equal(no.code, 0);
  assert.deepEqual(t2.writes(), []);
});

test('a page is opened only for a person who is there, when not told otherwise, and only while it is needed', async (t) => {
  const agent = { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' };
  const person = { interactive: true, secret: async () => BOT_TOKEN, ask: async () => 'y' };
  // --no-open: the links are printed, and nothing is opened.
  const quiet = await setup({ file: agent });
  t.after(quiet.fake.close);
  const r = await quiet.run(['connect', '--env-file', quiet.envFile, '--no-open'], person);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(quiet.opened, []);
  assert.ok(r.out.includes(`1. Make the application: ${NEW_APPLICATION}`), r.out);
  assert.match(r.out, /Add it to one: open this link, pick the server, and authorize\./);

  // A bot that is in a server already: the link is there to add it to another, and no page is opened for it.
  const there = await setup({ api: { servers: 2 } });
  t.after(there.fake.close);
  const r2 = await there.run(['connect', '--env-file', there.envFile], person);
  assert.equal(r2.code, 0, r2.all);
  assert.deepEqual(there.opened, []);
  assert.match(r2.out, /To add the bot to a server: open this link, pick the server, and authorize\./);

  // --server: the page opens with that server chosen.
  const chosen = await setup();
  t.after(chosen.fake.close);
  const r3 = await chosen.run(['connect', '--env-file', chosen.envFile, '--server', '222222222222222222'], person);
  assert.equal(r3.code, 0, r3.all);
  assert.deepEqual(chosen.opened, [`${installLink(APP_ID)}&guild_id=222222222222222222`]);
  assert.ok(r3.out.includes(`${installLink(APP_ID)}&guild_id=222222222222222222`));
  assert.match(r3.out, /the page is open in your browser: your server is chosen there, so authorize\./);

  // A browser that can't be opened is no failure: the link is printed, as for a script.
  const none = await setup({ file: agent });
  t.after(none.fake.close);
  const r4 = await none.run(['connect', '--env-file', none.envFile], { ...person, open: async () => false });
  assert.equal(r4.code, 0, r4.all);
  assert.ok(r4.out.includes(`1. Make the application: ${NEW_APPLICATION}`), r4.out);
  assert.match(r4.out, /Add it to one: open this link, pick the server, and authorize\./);
});

test('a key or a project that is wrong is said before anyone is sent to make an application', async (t) => {
  const s = await setup({ file: { VOICEFLOW_API_KEY: 'VF.DM.not-the-key', VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' } });
  t.after(s.fake.close);
  let asked = 0;
  const r = await s.run(['connect', '--env-file', s.envFile], { interactive: true, secret: async () => (asked++, BOT_TOKEN), ask: async () => 'y' });
  assert.equal(r.code, 1, r.all);
  assert.equal(asked, 0, 'the token was asked for with a key that does not work');
  assert.deepEqual(s.opened, []);
  assert.ok(!/Make the application/.test(r.all), r.all);
  assert.deepEqual(s.fake.taken(), []);
});

test('a token that came from somewhere else is never copied into the env file', async (t) => {
  const agent = { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' };
  // From the environment: the server's host sets it there too.
  const s = await setup({ file: agent });
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes'], { env: { DISCORD_API_URL: s.fake.apiUrl, DISCORD_BOT_TOKEN: BOT_TOKEN } });
  assert.equal(r.code, 0, r.all);
  assert.equal((await s.env()).DISCORD_BOT_TOKEN, undefined);
  assert.equal((await s.env()).DISCORD_PUBLIC_KEY, s.fake.publicKey);
  assert.match(r.out, /DISCORD_BOT_TOKEN {7}the bot token you gave/);
  assert.ok(!(await readFile(s.envFile, 'utf8')).includes(BOT_TOKEN));

  // From a file that holds only it.
  const f = await setup({ file: agent });
  t.after(f.fake.close);
  const tokenFile = join(f.envFile, '..', 'token');
  await writeFile(tokenFile, `${BOT_TOKEN}\n`);
  const fromFile = await f.run(['connect', '--env-file', f.envFile, '--token-file', tokenFile, '--yes']);
  assert.equal(fromFile.code, 0, fromFile.all);
  assert.ok(!(await readFile(f.envFile, 'utf8')).includes(BOT_TOKEN));
  assert.ok(!fromFile.all.includes(BOT_TOKEN));
});

test('a token Discord refuses is said plainly, and nothing is changed', async (t) => {
  const s = await setup({
    file: { DISCORD_BOT_TOKEN: 'not-the-bot-token-at-all', VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' },
  });
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Discord refused the bot token \(401\)\. Copy it again/);
  assert.ok(!r.all.includes('not-the-bot-token-at-all'));
  assert.equal(s.voiceflow.state.calls.length, 0);
});

// ── The bot's name and picture ──────────────────────────────────────────────

const AVATAR = 'https://assets.example.com/1768-agent%20face.png';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const VOICEFLOW_ICON = await readFile(new URL('../../core/assets/voiceflow-icon.png', import.meta.url));
const dataOf = (bytes, type = 'image/png') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const withAvatar = (more = {}) => ({ project: { ...PROJECT, image: AVATAR }, images: { [AVATAR]: { bytes: PNG_BYTES, type: 'image/png' } }, ...more });

test("an agent's name becomes a bot name Discord takes", () => {
  for (const [agent, bot] of [
    ['[SPIKE] Channel Relay', '[SPIKE] Channel Relay'],
    ['Acme: Support #1 @ HQ', 'Acme Support 1 HQ'],
    ['  Support   Bot  ', 'Support Bot'],
    ['The Very Long Name Of An Agent That Goes On', 'The Very Long Name Of An Agent T'],
    ['```', ''],
    ['A', ''],
  ]) {
    assert.equal(botNameOf(agent), bot);
    assert.ok(bot.length <= 32);
  }
});

test("a new bot takes the agent's name, and Voiceflow's icon when the agent has no avatar", async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 0, r.all);
  assert.equal(s.fake.state.app.bot.username, 'Spike');
  assert.match(r.out, /~ named the bot "Spike"/);
  // The bot's picture, and the application's icon: what the page that adds the bot shows.
  assert.equal(s.fake.state.pictures.avatar, dataOf(VOICEFLOW_ICON));
  assert.equal(s.fake.state.pictures.icon, dataOf(VOICEFLOW_ICON));
  assert.match(r.out, /\+ set the bot's picture to Voiceflow's icon/);
  // What it says at the end is the bot as it now is.
  assert.match(r.out, /Connected: Discord app 111111111111111111 "Support Bot", bot Spike\./);
});

test("the agent's avatar is the bot's picture, and Voiceflow's icon stands in when Discord won't take it", async (t) => {
  const s = await setup(withAvatar());
  t.after(s.fake.close);
  const plan = await s.run(['connect', '--env-file', s.envFile, '--dry-run']);
  assert.ok(plan.out.includes(`+ set the bot's picture to the agent's avatar in Voiceflow (Voiceflow's icon if Discord won't take it): ${AVATAR}`), plan.out);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 0, r.all);
  assert.equal(s.fake.state.pictures.avatar, dataOf(PNG_BYTES));
  assert.equal(s.fake.state.pictures.icon, dataOf(PNG_BYTES));
  assert.match(r.out, /\+ set the bot's picture to the agent's avatar/);

  // An avatar Discord refuses: the bot isn't left with Discord's blank one, and it is said. Nothing waits on anyone.
  const refused = await setup(withAvatar({ api: { takesAvatar: (data) => data !== dataOf(PNG_BYTES) } }));
  t.after(refused.fake.close);
  const r2 = await refused.run(['connect', '--env-file', refused.envFile, '--yes']);
  assert.equal(r2.code, 0, r2.all);
  assert.equal(refused.fake.state.pictures.avatar, dataOf(VOICEFLOW_ICON));
  assert.match(
    r2.out,
    /! Discord didn't take the agent's avatar as the bot's picture: .*Invalid image data.*It has Voiceflow's icon instead; set another in https:\/\/discord\.com\/developers\/applications\/111111111111111111\/bot/,
  );
  assert.equal(refused.fake.state.commands.length, 1, 'the rest of connect was not done');

  // An avatar that can't be downloaded is the same.
  const gone = await setup(withAvatar({ images: { [AVATAR]: { bytes: new Uint8Array(), type: 'text/html', status: 404 } } }));
  t.after(gone.fake.close);
  const r3 = await gone.run(['connect', '--env-file', gone.envFile, '--yes']);
  assert.equal(r3.code, 0, r3.all);
  assert.equal(gone.fake.state.pictures.avatar, dataOf(VOICEFLOW_ICON));
  assert.match(r3.out, /it couldn't be downloaded \(HTTP 404\)/);
});

test('a bot connected before keeps its name and its picture, unless you name them', async (t) => {
  const before = {
    commands: [
      {
        id: '1',
        name: 'ask',
        type: 1,
        description: 'Ask Spike a question',
        options: [{ type: 3, name: 'question', description: 'What you want to ask', required: true }],
      },
    ],
    avatar: 'f00d',
    icon: 'beef',
  };
  const s = await setup(withAvatar({ api: before }));
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 0, r.all);
  assert.equal(s.fake.state.app.bot.username, 'support-bot');
  assert.ok(!/name the bot|the bot's picture/.test(r.out), r.out);
  assert.ok(!s.writes().includes('PATCH /users/@me'));

  // A name and a picture you give go on any bot, and the application's icon follows the picture.
  const NEW = 'https://cdn.example.com/new.gif';
  const named = await setup(withAvatar({ api: before, images: { [NEW]: { bytes: PNG_BYTES, type: 'image/gif' } } }));
  t.after(named.fake.close);
  const r2 = await named.run(['connect', '--env-file', named.envFile, '--name', 'Helper', '--icon', NEW, '--yes']);
  assert.equal(r2.code, 0, r2.all);
  assert.match(r2.out, /~ name the bot "Helper" \(it is "support-bot" now\)/);
  assert.ok(r2.out.includes(`+ set the bot's picture to the image: ${NEW}`));
  assert.equal(named.fake.state.app.bot.username, 'Helper');
  assert.equal(named.fake.state.pictures.avatar, dataOf(PNG_BYTES, 'image/gif'));
  assert.equal(named.fake.state.pictures.icon, dataOf(PNG_BYTES, 'image/gif'));

  // And a new bot is left as it is when you say so.
  const kept = await setup(withAvatar());
  t.after(kept.fake.close);
  const r3 = await kept.run(['connect', '--env-file', kept.envFile, '--name', 'keep', '--icon', 'none', '--yes']);
  assert.equal(r3.code, 0, r3.all);
  assert.equal(kept.fake.state.app.bot.username, 'support-bot');
  assert.equal(kept.fake.state.pictures.avatar, null);
  assert.ok(!kept.writes().includes('PATCH /users/@me'));
});

test("a name Discord won't take is said, and connect does everything else", async (t) => {
  const s = await setup({ api: { denyName: true } });
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  // The bot works under any name: nothing waits on anyone.
  assert.equal(r.code, 0, r.all);
  assert.match(
    r.out,
    /! Discord didn't take "Spike" as the bot's name: .*too fast.*It is still "support-bot"; name it in https:\/\/discord\.com\/developers\/applications\/111111111111111111\/bot/,
  );
  assert.equal(s.fake.state.app.bot.username, 'support-bot');
  assert.match(r.out, /Connected: Discord app 111111111111111111 "Support Bot", bot support-bot\./);
  assert.equal(s.fake.state.commands.length, 1);
  assert.equal(s.voiceflow.state.variables.length, VARIABLES);
  assert.ok(!r.all.includes(BOT_TOKEN));

  // A picture that is the bot's but not the application's is said too.
  const icon = await setup({ api: { takesIcon: () => false } });
  t.after(icon.fake.close);
  const r2 = await icon.run(['connect', '--env-file', icon.envFile, '--yes']);
  assert.equal(r2.code, 0, r2.all);
  assert.equal(icon.fake.state.pictures.avatar, dataOf(VOICEFLOW_ICON));
  assert.match(r2.out, /The bot has its picture, but Discord didn't take it as the application's icon/);
});

test('with --public-url Discord is given the address, and checks it', async (t) => {
  const asked = [];
  const s = await setup({ api: { verify: (url) => (asked.push(url), true) } });
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--public-url', `${PUBLIC}/`, '--yes']);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(asked, [`${PUBLIC}/api/discord`]);
  assert.equal(s.fake.state.app.interactions_endpoint_url, `${PUBLIC}/api/discord`);
  assert.match(r.out, /Discord sends slash commands and buttons to https:\/\/bot\.example\.com\/api\/discord\./);
  assert.match(r.out, /a standing connection your server has to hold/);
});

test("an address Discord can't verify leaves everything else done, and says how to finish", async (t) => {
  const s = await setup({ api: { verify: () => false } });
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--public-url', PUBLIC, '--yes']);
  assert.equal(r.code, 3, r.all);
  assert.equal(s.fake.state.commands.length, 1);
  assert.equal(s.voiceflow.state.variables.length, VARIABLES);
  assert.equal((await s.env()).DISCORD_PUBLIC_KEY, s.fake.publicKey);
  assert.match(r.err, /Discord couldn't verify https:\/\/bot\.example\.com\/api\/discord/);
  assert.match(r.err, /could not be verified/);
  assert.ok(r.err.includes(`voiceflow-channels point discord --public-url ${PUBLIC} --env-file ${s.envFile}`));
});

test('a mistake in the command is said as one, before anything is asked or changed', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  for (const argv of [
    ['connect', '--public-url', 'http://bot.example.com', '--env-file', s.envFile],
    ['connect', '--command', '/Ask Me', '--env-file', s.envFile],
    ['connect', '--publish', '--no-publish', '--env-file', s.envFile],
    ['connect', '--icon', 'agent.png', '--env-file', s.envFile],
    ['connect', '--server', 'my-server', '--env-file', s.envFile],
    ['connect', '--name', '  ', '--env-file', s.envFile],
    ['point', '--env-file', s.envFile],
    ['install'],
  ]) {
    const r = await s.run(argv);
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.all}`);
  }
  assert.equal((await s.run(['--help'])).code, 0);
  assert.deepEqual(s.fake.taken(), []);
});

test('the command and the variables are each optional, and a changed command is updated', async (t) => {
  const s = await setup({
    api: {
      flags: APP_FLAGS.GATEWAY_MESSAGE_CONTENT,
      commands: [
        { id: '1', name: 'ask', type: 1, description: 'An old one', options: [] },
        { id: '2', name: 'other', type: 1, description: 'Yours' },
      ],
      // An app someone set up already: it has a picture of its own.
      avatar: 'f00d',
      icon: 'beef',
    },
  });
  t.after(s.fake.close);
  const none = await s.run(['connect', '--env-file', s.envFile, '--command', 'none', '--no-variables', '--yes']);
  assert.equal(none.code, 0, none.all);
  assert.match(none.out, /no variables \(then pass context: false to discord\(\)/);
  assert.deepEqual(s.writes(), []);
  assert.equal(s.voiceflow.state.variables.length, 0);

  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 0, r.all);
  // An intent Discord granted the app is the intent: nothing to turn on.
  assert.match(r.out, /= the Message Content intent is on/);
  assert.match(r.out, /~ update the \/ask command/);
  assert.deepEqual(s.writes(), [`POST /applications/${APP_ID}/commands`]);
  // The app's other command is left alone.
  assert.deepEqual(s.fake.state.commands.map((c) => c.name).sort(), ['ask', 'other']);
  assert.equal(s.fake.state.commands.find((c) => c.name === 'ask').description, 'Ask Spike a question');
});

test("an intent Discord won't turn on is left to the person, with where to do it", async (t) => {
  const s = await setup({ api: { denyFlags: true } });
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 3, r.all);
  assert.match(r.err, /Discord didn't turn on the Message Content intent/);
  assert.ok(r.err.includes(`https://discord.com/developers/applications/${APP_ID}/bot`));
  // Everything else was done.
  assert.equal(s.fake.state.commands.length, 1);
});

test('--publish publishes the environment, and only then', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const dry = await s.run(['connect', '--env-file', s.envFile, '--publish', '--dry-run']);
  assert.match(dry.out, /\+ publish development: its whole draft goes live \(--publish\)/);
  assert.equal(s.voiceflow.state.publishes.length, 0);
  const r = await s.run(['connect', '--env-file', s.envFile, '--publish', '--yes']);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(s.voiceflow.state.publishes, [
    { environment: 'development', name: 'Discord variables (Channels SDK)', description: 'Published by `voiceflow-channels connect discord --publish`.' },
  ]);
});

test('a project in another workspace stops it before anything is changed', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const r = await s.run(['connect', '--env-file', s.envFile, '--workspace', 'ws-other', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /is in workspace ws1, not ws-other\. Nothing was changed/);
  assert.deepEqual(s.writes(), []);
});

/** Your server on this machine: it takes a Gateway event only with its own bot token. */
async function localServer(token = BOT_TOKEN, status) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-discord-gateway-token'] });
    res.writeHead(status ?? (req.url !== '/api/discord' ? 404 : req.headers['x-discord-gateway-token'] === token ? 200 : 401));
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('point asks your server first, then gives Discord the address, and needs nothing of Voiceflow', async (t) => {
  const s = await setup({ file: { DISCORD_BOT_TOKEN: BOT_TOKEN } });
  const server = await localServer();
  t.after(() => Promise.all([s.fake.close(), server.close()]));
  const r = await s.run(['point', '--public-url', PUBLIC, '--local-url', server.url, '--env-file', s.envFile]);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(server.seen, [{ url: '/api/discord', token: BOT_TOKEN }]);
  assert.match(r.out, /= your server takes Discord's events at http:\/\/127\.0\.0\.1:\d+\/api\/discord, with this bot's token/);
  assert.match(r.out, /~ Discord sends slash commands and buttons to https:\/\/bot\.example\.com\/api\/discord \(it had no address for them\)/);
  assert.equal(s.fake.state.app.interactions_endpoint_url, `${PUBLIC}/api/discord`);
  assert.equal(s.voiceflow.state.calls.length, 0);
  assert.ok(!r.all.includes(BOT_TOKEN));

  // Another address the next time: it's moved, and where it was is said.
  const moved = await s.run(['point', '--public-url', 'https://next.example.com', '--env-file', s.envFile]);
  assert.match(
    moved.out,
    /~ Discord sends slash commands and buttons to https:\/\/next\.example\.com\/api\/discord \(it sent them to https:\/\/bot\.example\.com\/api\/discord\)/,
  );
  // The same address again changes nothing.
  s.fake.taken();
  const same = await s.run(['point', '--public-url', 'https://next.example.com', '--env-file', s.envFile]);
  assert.match(same.out, /= Discord sends slash commands and buttons to https:\/\/next\.example\.com\/api\/discord/);
  assert.deepEqual(s.writes(), []);
});

test("a server that's down, has no route, or runs with another token is said before Discord is pointed at it", async (t) => {
  const s = await setup({ file: { DISCORD_BOT_TOKEN: BOT_TOKEN } });
  const other = await localServer('another-bot-token-entirely');
  const broken = await localServer(BOT_TOKEN, 500);
  t.after(() => Promise.all([s.fake.close(), other.close(), broken.close()]));
  const point = (local, more = []) => s.run(['point', '--public-url', PUBLIC, '--local-url', local, '--env-file', s.envFile, ...more]);

  const wrong = await point(other.url);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /runs with another DISCORD_BOT_TOKEN than the one in .*\.env\.local\. Restart it/);
  const failed = await point(broken.url);
  assert.match(failed.err, /answered 500\. Its own output says why/);
  const noRoute = await point(other.url, ['--request-url', `${PUBLIC}/hooks/discord`]);
  assert.match(noRoute.err, /has no Discord route at http:\/\/127\.0\.0\.1:\d+\/hooks\/discord \(it answered 404\)/);
  const down = await point('http://127.0.0.1:9');
  assert.equal(down.code, 1);
  assert.match(down.err, /Nothing answers at http:\/\/127\.0\.0\.1:9\/api\/discord/);
  // The token goes with the check, so only a server on this machine is asked.
  const away = await point('https://elsewhere.example.com');
  assert.equal(away.code, 1);
  assert.match(away.err, /isn't on this machine/);

  assert.deepEqual(s.writes(), [], 'Discord was pointed at a server that failed its check');
  assert.equal(s.fake.state.app.interactions_endpoint_url, null);
});

test('point says when Discord refuses the address, and when the server would refuse Discord', async (t) => {
  const s = await setup({ api: { verify: () => false }, file: { DISCORD_BOT_TOKEN: BOT_TOKEN, DISCORD_PUBLIC_KEY: 'ab'.repeat(32) } });
  t.after(s.fake.close);
  const refused = await s.run(['point', '--public-url', PUBLIC, '--env-file', s.envFile]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Discord couldn't verify https:\/\/bot\.example\.com\/api\/discord/);

  s.fake.state.verify = () => true;
  const taken = await s.run(['point', '--public-url', PUBLIC, '--env-file', s.envFile]);
  assert.equal(taken.code, 0);
  assert.match(taken.err, /DISCORD_PUBLIC_KEY in .* isn't this app's public key/);

  // With no token there is nothing to point: connect comes first.
  const none = await setup({ file: null });
  t.after(none.fake.close);
  const r = await none.run(['point', '--public-url', PUBLIC, '--env-file', none.envFile]);
  assert.equal(r.code, 3);
  assert.match(r.err, /No DISCORD_BOT_TOKEN in .*Run connect first/);
});

test('disconnect takes back the command and the address, and leaves the rest to you', async (t) => {
  const s = await setup({
    api: {
      endpoint: `${PUBLIC}/api/discord`,
      commands: [
        { id: '7', name: 'ask', type: 1, description: 'Ask' },
        { id: '8', name: 'other', type: 1, description: 'Yours' },
      ],
    },
  });
  t.after(s.fake.close);
  const plan = await s.run(['disconnect', '--env-file', s.envFile]);
  assert.match(plan.out, /- delete the \/ask command/);
  assert.match(plan.out, /the app and its bot stay/);
  assert.deepEqual(s.writes(), []);
  const r = await s.run(['disconnect', '--env-file', s.envFile, '--yes']);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(
    s.fake.state.commands.map((c) => c.name),
    ['other'],
  );
  assert.equal(s.fake.state.app.interactions_endpoint_url, null);
  assert.match(r.out, /Disconnected\./);
  assert.equal(s.voiceflow.state.calls.length, 0);
});

test("Discord's errors are said with the field they're about, and never with the token", async (t) => {
  const s = await setup({ api: { verify: () => false } });
  t.after(s.fake.close);
  const api = createDiscordApi({ token: BOT_TOKEN, apiUrl: s.fake.apiUrl });
  await assert.rejects(api('PATCH', '/applications/@me', { interactions_endpoint_url: PUBLIC }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 50035);
    assert.match(
      error.message,
      /Discord PATCH \/applications\/@me answered 400: Invalid Form Body \(interactions_endpoint_url: The specified interactions endpoint url could not be verified\.\)/,
    );
    return true;
  });
  // Asked to slow down, it waits as long as Discord says and asks again.
  let n = 0;
  const waits = [];
  const slow = createDiscordApi({
    token: BOT_TOKEN,
    wait: async (ms) => void waits.push(ms),
    fetch: async () =>
      ++n < 3 ? new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.25 }), { status: 429 }) : new Response('{"ok":true}'),
  });
  assert.deepEqual(await slow('GET', '/applications/@me'), { ok: true });
  assert.deepEqual(waits, [250, 250]);
  // An error that repeats the token back doesn't carry it out.
  const echo = createDiscordApi({ token: BOT_TOKEN, fetch: async () => new Response(`bad token ${BOT_TOKEN}`, { status: 403 }) });
  await assert.rejects(echo('GET', '/x'), (error) => !error.message.includes(BOT_TOKEN) && /\[bot token\]/.test(error.message));
});

// ── listen: what `voiceflow-channels dev` holds open beside the server ──────

function listening(s, { env = {}, localUrl = 'http://127.0.0.1:3000' } = {}) {
  const out = [];
  const err = [];
  const started = [];
  const stop = new AbortController();
  const done = listen(
    { localUrl, envFile: s.envFile, signal: stop.signal, out: (l) => out.push(l), err: (l) => err.push(l) },
    {
      env: { DISCORD_API_URL: s.fake.apiUrl, ...env },
      gateway: async (options) => {
        started.push(options);
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      },
    },
  );
  return { out, err, started, stop, done };
}

test("listen holds Discord's connection for the server on this machine, with the app's own values", async (t) => {
  const s = await setup({ api: { flags: APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED } });
  t.after(s.fake.close);
  await s.run(['connect', '--env-file', s.envFile, '--yes']);
  const l = listening(s, { env: { DISCORD_RESPOND_TO_CHANNEL_IDS: '1, 2' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(l.started.length, 1);
  const [started] = l.started;
  assert.equal(started.webhookUrl, 'http://127.0.0.1:3000/api/discord');
  assert.deepEqual(started.adapter, {
    botToken: BOT_TOKEN,
    publicKey: s.fake.publicKey,
    applicationId: APP_ID,
    apiUrl: s.fake.apiUrl,
    respondToChannelIds: ['1', '2'],
  });
  // The bot is in no server: the link is said again, where it's needed.
  assert.ok(l.out.join('\n').includes(installLink(APP_ID)));
  started.onConnected('support-bot');
  started.onProblem(`Failed to forward Gateway event: ${BOT_TOKEN}`);
  assert.match(l.out.at(-1), /= connected to Discord as support-bot: what people write reaches your server at http:\/\/127\.0\.0\.1:3000\/api\/discord/);
  assert.match(l.err.at(-1), /! discord: Failed to forward Gateway event/);
  assert.ok(![...l.out, ...l.err].join('\n').includes(BOT_TOKEN));
  l.stop.abort();
  await l.done;
});

test('listen says what it waits on: connect not run, or an intent that is off', async (t) => {
  const none = await setup({ file: null });
  t.after(none.fake.close);
  await assert.rejects(
    listening(none).done,
    (error) =>
      error instanceof NeedsYou && /No DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID here or in .*Run connect first/.test(error.message),
  );

  const off = await setup({ file: { DISCORD_BOT_TOKEN: BOT_TOKEN, DISCORD_PUBLIC_KEY: 'ab'.repeat(32), DISCORD_APPLICATION_ID: APP_ID } });
  t.after(off.fake.close);
  const l = listening(off);
  await assert.rejects(l.done, (error) => error instanceof NeedsYou && /The Message Content intent is off for "Support Bot"/.test(error.message));
  assert.equal(l.started.length, 0);

  // Events go with the bot's token: only to a server on this machine.
  const away = listening(off, { localUrl: 'https://elsewhere.example.com' });
  await assert.rejects(away.done, /isn't on this machine/);
  assert.equal(away.started.length, 0);
});
