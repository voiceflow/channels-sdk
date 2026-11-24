// What every channel's package is built from: the channel itself (channel.ts),
// its commands (connect.ts), and the text and buttons a platform is sent where
// it shows less than Markdown or fewer buttons than the agent offers.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { channelCommands, missingSettings, toMake } from '../dist/connect.js';
import { channel, contextVariables, createChannelExtension, loadAdapter, render, toPlain } from '../dist/index.js';
import { fakeVoiceflowApi } from '../dist/testing.js';

test("Markdown as plain words keeps what a person needs: the words, a list's numbers, a link's address", () => {
  assert.equal(toPlain('# Plan\n\nPick **one** of _these_, ~~not~~ `that`.'), 'Plan\n\nPick one of these, not that.');
  assert.equal(toPlain('1. Track order\n2. Talk to someone'), '1. Track order\n2. Talk to someone');
  assert.equal(toPlain('3. Third\n4. Fourth'), '3. Third\n4. Fourth', 'a list keeps the number it starts at');
  assert.equal(toPlain('- apples\n- pears\n  - conference'), '- apples\n- pears\n  - conference');
  assert.equal(toPlain('1. One\n\n   More of one.\n2. Two'), '1. One\n   More of one.\n2. Two', "an item's second line sits under its words");
  assert.equal(
    toPlain('See [our site](https://example.com/returns) or <https://example.com/faq>.'),
    'See our site (https://example.com/returns) or https://example.com/faq.',
  );
  assert.equal(toPlain('Write to [help@example.com](mailto:help@example.com)'), 'Write to help@example.com', 'an address written as itself is said once');
  assert.equal(toPlain('![A chart](https://example.com/c.png)'), 'A chart (https://example.com/c.png)');
  assert.equal(toPlain('> quoted **text**'), 'quoted text');
  assert.equal(toPlain('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(toPlain('| a | b |\n|---|---|\n| 1 | 2 |'), 'a | b\n1 | 2');
  assert.equal(toPlain('one  \ntwo\n\n---\n\nthree'), 'one\ntwo\n\nthree');
  assert.equal(toPlain('5\\. Not a list, 2 * 3 = 6'), '5. Not a list, 2 * 3 = 6', 'what was escaped is read as written');
  assert.equal(toPlain('Just words.'), 'Just words.');
  assert.equal(toPlain(''), '');
});

test("a channel is the adapter's module, its variables, and what its package says of the platform", () => {
  const module = { createTelegramAdapter() {} };
  const spec = channel(
    'telegram',
    module,
    { adapter: { botToken: 't' } },
    { maxTextLength: 4000, adapterDefaults: { mode: 'webhook' }, plainText: true, capabilities: { maxButtons: 3 }, follow: false, text: (m) => m },
  );
  assert.equal(spec.slug, 'telegram');
  assert.equal(spec.module, module);
  assert.deepEqual(spec.options, { botToken: 't' });
  const { extension } = spec;
  assert.deepEqual(
    [extension.slug, extension.maxTextLength, extension.plainText, extension.capabilities, extension.follow],
    ['telegram', 4000, true, { maxButtons: 3 }, false],
  );
  assert.deepEqual(extension.adapterDefaults, { mode: 'webhook' });
  assert.equal(extension.text('x'), 'x');

  const bare = createChannelExtension('telegram');
  assert.deepEqual(Object.keys(bare).sort(), ['slug', 'variables'], 'a channel with nothing to say of its platform says nothing');
  assert.equal(createChannelExtension('telegram', { context: false }).variables, undefined, 'context: false sets no variables');
  assert.equal(createChannelExtension('telegram', { follow: true }, { follow: false }).follow, undefined, "the caller's follow wins over the platform's");
  assert.equal(createChannelExtension('telegram', { follow: false }).follow, false);
  assert.equal(createChannelExtension('telegram', {}, { follow: false }).follow, false, "and the platform's own is used where the caller says nothing");
  assert.deepEqual(Object.keys(contextVariables('telegram')), ['telegram_user_id', 'telegram_user_name', 'telegram_thread_id', 'telegram_message_id']);
  assert.throws(() => channel('not-a-platform', {}), /not in the Chat SDK adapter catalog/);
});

test('the variables say who and where on every turn, and a name that is only an ID is no name', () => {
  const { variables } = createChannelExtension('twilio');
  const thread = { id: 'twilio:+15550001:+15550002' };
  const message = (author) => ({ id: 'SM1', author });
  assert.deepEqual(variables({ thread, message: message({ userId: '+15550002', userName: '+15550002', fullName: '+15550002' }) }), {
    twilio_user_id: '+15550002',
    twilio_user_name: '',
    twilio_thread_id: thread.id,
    twilio_message_id: 'SM1',
  });
  assert.equal(variables({ thread, message: message({ userId: 'U1', userName: 'ada', fullName: 'Ada Lovelace' }) }).twilio_user_name, 'Ada Lovelace');
  assert.equal(variables({ thread, message: message({ userId: 'U2', userName: 'grace', fullName: '' }) }).twilio_user_name, 'grace');
  // A button's click says only who clicked: the name is the one they last wrote under.
  assert.deepEqual(variables({ thread, userId: 'U1' }), {
    twilio_user_id: 'U1',
    twilio_user_name: 'Ada Lovelace',
    twilio_thread_id: thread.id,
    twilio_message_id: '',
  });
  assert.deepEqual(variables({ thread, userId: 'U9' }), { twilio_user_id: 'U9', twilio_user_name: '', twilio_thread_id: thread.id, twilio_message_id: '' });
  assert.deepEqual(
    variables({}),
    { twilio_user_id: '', twilio_user_name: '', twilio_thread_id: '', twilio_message_id: '' },
    'every one, even with nothing known',
  );
});

test('where a platform shows only so many buttons, a longer list is numbered and a shorter one keeps its buttons', () => {
  const caps = {
    buttons: true,
    linkButtons: true,
    cards: true,
    imagesInCards: true,
    typingIndicator: false,
    streaming: false,
    editMessages: false,
    selectMenus: false,
  };
  const choices = ['One', 'Two', 'Three', 'Four'].map((label) => ({ label, action: { type: label.toLowerCase() } }));
  const three = render([{ type: 'choices', choices: choices.slice(0, 3) }], { ...caps, maxButtons: 3 });
  assert.equal(three.posts[0].card.children.find((c) => c.type === 'actions').children.length, 3);
  const four = render([{ type: 'choices', choices }], { ...caps, maxButtons: 3 });
  assert.deepEqual(four.posts, [{ markdown: '1. One\n2. Two\n3. Three\n4. Four' }]);
  assert.equal(four.choices.length, 4, 'and every one can still be taken by its number');
  const none = render([{ type: 'choices', choices: choices.slice(0, 1) }], { ...caps, maxButtons: 0 });
  assert.deepEqual(none.posts, [{ markdown: '1. One' }], 'with none at all, even one choice is numbered');
  const card = render([{ type: 'card', card: { title: 'Plan', description: 'Details', choices } }], { ...caps, maxButtons: 3 });
  assert.deepEqual(card.posts, [{ markdown: '**Plan**\nDetails\n1. One\n2. Two\n3. Three\n4. Four' }], 'a card with too many goes as text too');
  assert.ok(render([{ type: 'choices', choices }], caps).posts[0].card, 'and with no limit said, nothing changes');
});

test("an adapter that lives at a path inside another's package is loaded from there", async () => {
  const asked = [];
  const importer = async (specifier) => {
    asked.push(specifier);
    return { createXchatAdapter: () => ({ name: 'xchat' }), createXAdapter: () => ({ name: 'x' }) };
  };
  assert.equal((await loadAdapter('xchat', { importer })).name, 'xchat');
  assert.equal((await loadAdapter('x', { importer })).name, 'x');
  assert.deepEqual(asked, ['@chat-adapter/x/chat', '@chat-adapter/x']);
});

// The commands, with a made-up platform's needs on a real catalog entry (Telegram: one needed setting).
const VF_KEY = 'VF.DM.channel-commands';
async function commands(t, setup, file = 'TELEGRAM_BOT_TOKEN=110:made-up\n') {
  const dir = await mkdtemp(join(tmpdir(), 'channel-commands-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env.local');
  await writeFile(envFile, file);
  const api = fakeVoiceflowApi({ project: { id: 'proj1', name: 'Acme Support', workspaceID: 'ws1' }, apiKey: VF_KEY });
  const set = channelCommands('telegram', setup);
  const pointed = [];
  const run = async (argv, { env = {}, fetch = api.fetch, withFile = true, ...io } = {}) => {
    const said = [];
    const code = await set.cli([...argv, ...(withFile ? ['--env-file', envFile] : [])], {
      out: (line) => said.push(line),
      err: (line) => said.push(line),
      env: { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: 'proj1', VOICEFLOW_ENVIRONMENT: 'development', ...env },
      fetch,
      interactive: false,
      ...io,
    });
    return { code, said: said.join('\n') };
  };
  return { set, run, api, envFile, pointed, read: () => readFile(envFile, 'utf8') };
}

test('what a channel still lacks: the needed settings, one whole way of signing in, and never a secret connect makes', () => {
  const none = () => false;
  assert.deepEqual(
    missingSettings('telegram', none).map((v) => v.key),
    ['TELEGRAM_BOT_TOKEN'],
  );
  assert.deepEqual(
    missingSettings('telegram', (key) => key === 'TELEGRAM_BOT_TOKEN'),
    [],
  );
  const setup = {
    settings: [
      { key: 'BOT_NAME', description: 'Its name.' },
      { key: 'HOOK_SECRET', description: 'A secret.', make: true },
    ],
    later: { TELEGRAM_BOT_TOKEN: 'It comes later.' },
  };
  assert.deepEqual(
    missingSettings('telegram', none, setup),
    [{ key: 'BOT_NAME', description: 'Its name.' }],
    'one that comes later is not waited for, and one connect makes is not asked for',
  );
  assert.deepEqual(
    toMake(none, setup).map((v) => v.key),
    ['HOOK_SECRET'],
  );
  assert.deepEqual(
    toMake((key) => key === 'HOOK_SECRET', setup),
    [],
  );
  // Several ways to sign in: the first is said in full, with the others by name; any one whole way is enough.
  const github = missingSettings('github', none);
  assert.deepEqual(
    github.map((v) => v.key),
    ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN'],
  );
  assert.equal(github[1].oneOf, 'GitHub App');
  assert.deepEqual(
    missingSettings('github', (key) => ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY'].includes(key)),
    [],
  );
  assert.deepEqual(
    missingSettings('github', (key) => ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID'].includes(key)).map((v) => v.key),
    ['GITHUB_TOKEN'],
    'half of another way is not a way',
  );
  // A setting named twice (needed by the catalog, and made by connect) is made, not asked for.
  assert.deepEqual(
    missingSettings('github', none, { settings: [{ key: 'GITHUB_WEBHOOK_SECRET', description: 'x', make: true }] }).map((v) => v.key),
    ['GITHUB_TOKEN'],
  );
});

test('connect shows its plan and changes nothing until told to; then it makes the variables and the secret, once', async (t) => {
  const setup = { settings: [{ key: 'HOOK_SECRET', description: 'The secret the platform sends back.', make: true }], addressGoes: 'Settings → Webhooks' };
  const c = await commands(t, setup);
  const dry = await c.run(['connect', '--dry-run', '--yes']);
  assert.equal(dry.code, 0, dry.said);
  assert.match(dry.said, /Voiceflow: project "Acme Support" \(proj1\) in workspace ws1, environment development/);
  assert.match(dry.said, /\+ 4 variables for your agent's prompts \(telegram_user_id, telegram_user_name, …\)/);
  assert.match(dry.said, /\+ make HOOK_SECRET, a secret of your own that Telegram sends back, and save it in /);
  assert.match(dry.said, /nothing is published, and nothing has to be/);
  const unasked = await c.run(['connect']);
  assert.equal(unasked.code, 0);
  assert.match(unasked.said, /Nothing was changed: run it again with --yes to go ahead\./);
  assert.equal(c.api.state.calls.filter((call) => call.method !== 'GET').length, 0, 'neither run changed the agent');
  assert.doesNotMatch(await c.read(), /HOOK_SECRET/, 'nor the env file');

  const done = await c.run(['connect', '--yes', '--public-url', 'https://bot.example.com/']);
  assert.equal(done.code, 0, done.said);
  assert.equal(c.api.state.variables.length, 4);
  const secret = /^HOOK_SECRET=([0-9a-f]{64})$/m.exec(await c.read())?.[1];
  assert.ok(secret, 'the secret is in the env file');
  assert.ok(!done.said.includes(secret), 'and nowhere in what was printed');
  assert.match(
    done.said,
    /! Give Telegram this address, where it asks where to send messages \(Settings → Webhooks\): https:\/\/bot\.example\.com\/api\/telegram/,
  );
  assert.match(done.said, /channels: \[telegram\(\)\]/);
  assert.equal(await c.set.connected({ envFile: c.envFile, env: { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: 'proj1' } }), true);
  assert.equal(await c.set.connected({ envFile: c.envFile, env: {} }), false, 'with no agent named, it is not connected');

  await c.run(['connect', '--yes']);
  assert.ok((await c.read()).includes(`HOOK_SECRET=${secret}`) && (await c.read()).match(/HOOK_SECRET/g).length === 1, 'a second run keeps the secret it made');
  assert.equal(c.api.state.variables.length, 4);
});

test('connect waits on a person for what only they have, says it all in one stop, and never guesses', async (t) => {
  const setup = {
    settings: [
      { key: 'BOT_NAME', description: "The bot's name." },
      { key: 'HOOK_SECRET', description: 'The webhook secret.', make: true },
    ],
  };
  const c = await commands(t, setup, '');
  const stop = await c.run(['connect', '--yes'], { env: { VOICEFLOW_API_KEY: '' } });
  assert.equal(stop.code, 3, stop.said);
  assert.match(stop.said, /No Voiceflow API key/);
  assert.match(
    stop.said,
    /These settings are missing in .*\.env\.local:\n {2}TELEGRAM_BOT_TOKEN=… {3}Telegram bot token\.\n {2}BOT_NAME=… {3}The bot's name\./,
  );
  assert.doesNotMatch(stop.said, /HOOK_SECRET/, 'what connect makes itself is not asked for');
  assert.match(stop.said, /never in a chat or a command line/);
  assert.equal(c.api.state.calls.length, 0, 'and Voiceflow was asked nothing');

  // With no env file there is nowhere to keep a secret it makes: then that is one more setting to bring.
  const nowhere = await c.run(['connect', '--yes'], { withFile: false, env: { TELEGRAM_BOT_TOKEN: 't', BOT_NAME: 'b' } });
  assert.equal(nowhere.code, 3);
  assert.match(nowhere.said, /One setting is missing in the environment:\n {2}HOOK_SECRET=… {3}The webhook secret\. Any long random text of your own\./);
});

test('connected is every setting, every secret connect makes, and the agent: no less', async (t) => {
  const setup = { settings: [{ key: 'HOOK_SECRET', description: 'x', make: true }] };
  const c = await commands(t, setup, '');
  const agent = { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: 'proj1' };
  assert.equal(await c.set.connected({ env: { ...agent, TELEGRAM_BOT_TOKEN: 't', HOOK_SECRET: 's' } }), true);
  assert.equal(await c.set.connected({ env: { ...agent, HOOK_SECRET: 's' } }), false, 'a setting missing');
  assert.equal(await c.set.connected({ env: { ...agent, TELEGRAM_BOT_TOKEN: 't' } }), false, 'the secret not made yet');
  assert.equal(await c.set.connected({ env: { TELEGRAM_BOT_TOKEN: 't', HOOK_SECRET: 's', VOICEFLOW_API_KEY: VF_KEY } }), false, 'no project');
  assert.equal(await c.set.connected({ env: { TELEGRAM_BOT_TOKEN: 't', HOOK_SECRET: 's', VOICEFLOW_PROJECT_ID: 'proj1' } }), false, 'no key');
  assert.deepEqual(c.set.settings, { needed: ['TELEGRAM_BOT_TOKEN'], made: ['HOOK_SECRET'] });
});

test('the platform is given the address with the secret connect just made, and never before there is one', async (t) => {
  const given = [];
  const setup = {
    settings: [{ key: 'HOOK_SECRET', description: 'x', make: true }],
    point: async ({ url, env }) => (given.push([url, env.HOOK_SECRET]), `+ pointed with ${env.TELEGRAM_BOT_TOKEN}`),
  };
  const c = await commands(t, setup);
  const early = await c.run(['point', '--public-url', 'https://bot.example.com']);
  assert.equal(early.code, 3, early.said);
  assert.match(
    early.said,
    /Telegram isn't connected here yet: run `voiceflow-channels connect telegram --env-file .*` first\. It makes HOOK_SECRET and saves it there\./,
  );
  assert.deepEqual(given, [], 'and the platform was given nothing');

  const done = await c.run(['connect', '--yes', '--public-url', 'https://bot.example.com']);
  assert.equal(done.code, 0, done.said);
  const secret = /^HOOK_SECRET=([0-9a-f]{64})$/m.exec(await c.read())?.[1];
  assert.deepEqual(given, [['https://bot.example.com/api/telegram', secret]], 'the secret made in this run went with the address');
  assert.match(done.said, /\+ pointed with /);
  assert.ok(!done.said.includes('110:made-up'), "a line a channel's own code prints is cleaned of secrets too");

  const bare = await commands(t, setup, '');
  const lacking = await bare.run(['point', '--public-url', 'https://bot.example.com']);
  assert.equal(lacking.code, 3);
  assert.match(lacking.said, /One setting is missing in .*:\n {2}TELEGRAM_BOT_TOKEN=…/);
});

test('a setting that can only come later is said, not waited for', async (t) => {
  const c = await commands(t, { later: { TELEGRAM_BOT_TOKEN: 'The platform sends it once it has your address.' } }, '');
  const { code, said } = await c.run(['connect', '--yes']);
  assert.equal(code, 0, said);
  assert.match(said, /! TELEGRAM_BOT_TOKEN isn't set yet, and can't be: The platform sends it once it has your address\./);
  assert.deepEqual(c.set.settings, { needed: [], made: [] });
});

test('point gives the platform the address where a command can, checks the server first, and changes nothing else', async (t) => {
  const given = [];
  const c = await commands(t, { point: async ({ url, env }) => (given.push([url, env.TELEGRAM_BOT_TOKEN]), `+ pointed at ${url}`) });
  const none = await c.run(['point']);
  assert.equal(none.code, 2);
  assert.match(none.said, /Missing --public-url/);
  assert.equal((await c.run(['point', '--public-url', 'http://bot.example.com'])).code, 2, 'an address that is not https is a mistake');

  const local = (status) => async (input, init) =>
    String(input).startsWith('http://localhost:3000/') ? (assert.equal(init.method, 'POST'), new Response('', { status })) : c.api.fetch(input, init);
  const ok = await c.run(['point', '--public-url', 'https://bot.example.com', '--local-url', 'http://localhost:3000'], { fetch: local(401) });
  assert.equal(ok.code, 0, ok.said);
  assert.match(
    ok.said,
    /= your server has its Telegram route at http:\/\/localhost:3000\/api\/telegram\n\+ pointed at https:\/\/bot\.example\.com\/api\/telegram/,
  );
  assert.deepEqual(given, [['https://bot.example.com/api/telegram', '110:made-up']], 'the address, and the settings from the env file');
  await c.run(['point', '--public-url', 'https://bot.example.com'], { env: { TELEGRAM_BOT_TOKEN: '' } });
  assert.equal(given.pop()[1], '110:made-up', "a variable that is set and empty doesn't hide the env file's value");
  await c.run(['point', '--public-url', 'https://bot.example.com'], { env: { TELEGRAM_BOT_TOKEN: '220:from-the-environment' } });
  assert.equal(given.pop()[1], '220:from-the-environment', "and the environment's own value wins");

  for (const [status, why] of [
    [404, /has no Telegram route at .* \(HTTP 404\)\. The starter puts it at app\/api\/telegram\/route\.ts/],
    [500, /Your server failed at .* \(HTTP 500\)/],
  ]) {
    const bad = await c.run(['point', '--public-url', 'https://bot.example.com', '--local-url', 'http://localhost:3000'], { fetch: local(status) });
    assert.equal(bad.code, 1);
    assert.match(bad.said, why);
  }
  const down = await c.run(['point', '--public-url', 'https://bot.example.com', '--local-url', 'http://localhost:3000'], {
    fetch: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.match(down.said, /Your server didn't answer at http:\/\/localhost:3000\/api\/telegram \(connect ECONNREFUSED\)\. Is it running\?/);
  assert.equal(
    (await c.run(['point', '--public-url', 'https://bot.example.com', '--local-url', 'https://elsewhere.example.com'])).code,
    2,
    'a "local" address that is not this machine is a mistake',
  );
  assert.equal(given.length, 1, 'and none of those gave the platform an address');
  assert.equal(c.api.state.calls.length, 0, 'point asks Voiceflow nothing');

  const whole = await c.run(['point', '--request-url', 'https://bot.example.com/hooks/telegram']);
  assert.equal(whole.code, 0);
  assert.equal(given.at(-1)[0], 'https://bot.example.com/hooks/telegram', 'a whole address of your own is given as it is');
});

test('disconnect takes back what the command gave, and says so where there was nothing to take', async (t) => {
  const plain = await commands(t, {});
  const nothing = await plain.run(['disconnect']);
  assert.equal(nothing.code, 3);
  assert.match(nothing.said, /Nothing of Telegram's was made from here, so there is nothing here to remove\./);
  assert.match(nothing.said, /The telegram_\* variables stay on the agent/);

  let removed = 0;
  const own = await commands(t, { remove: async () => (removed++, '- the address was taken back') });
  const done = await own.run(['disconnect']);
  assert.equal(done.code, 0, done.said);
  assert.equal(removed, 1);
  assert.match(done.said, /- the address was taken back\nThe bot or app itself is taken out on Telegram's own pages/);
});

test('whatever is printed, a secret is not in it', async (t) => {
  const c = await commands(t, {
    point: async ({ env }) => {
      throw new Error(`refused with token ${env.TELEGRAM_BOT_TOKEN} and key ${env.VOICEFLOW_API_KEY}`);
    },
  });
  const { code, said } = await c.run(['point', '--public-url', 'https://bot.example.com']);
  assert.equal(code, 1);
  assert.match(said, /refused with token/);
  assert.ok(!said.includes('110:made-up') && !said.includes(VF_KEY), said);
});

test('--help says the same commands for every channel, and a flag that makes no sense is a mistake', async (t) => {
  const c = await commands(t, {});
  const help = await c.run(['--help'], { withFile: false });
  assert.equal(help.code, 0);
  for (const line of [
    'voiceflow-channels connect telegram --env-file <path>',
    'voiceflow-channels point telegram --public-url',
    'voiceflow-channels disconnect telegram',
    '--dry-run',
    '--no-variables',
    'exits 0 when done, 1 on a failure, 2 on a mistake in the command, and 3',
  ]) {
    assert.ok(help.said.includes(line), line);
  }
  assert.equal((await c.run(['connect', '--publish', '--no-publish'])).code, 2);
  assert.equal((await c.run(['reconnect'], { withFile: false })).code, 2);
  const bare = await c.run(['connect', '--yes', '--no-variables']);
  assert.equal(bare.code, 0, bare.said);
  assert.equal(c.api.state.variables.length, 0, '--no-variables creates none');
  assert.match(bare.said, /no variables \(then pass context: false to telegram\(\) on your server\)/);
});
