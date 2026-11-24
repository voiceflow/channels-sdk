// A Voiceflow agent in Discord, end to end on this machine: the real Discord
// adapter and core's agent, against a stand-in for Discord's API and a scripted
// Voiceflow runtime. Requests arrive as Discord sends them: interactions signed
// with the application's key, and Gateway events passed on with the bot's token.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels } from '@voiceflow/channels-sdk';
import { fakeVoiceflow, waiter } from '@voiceflow/channels-sdk/testing';
import { CONTEXT_VARIABLES, createDiscordExtension, discord, titleOf } from '../dist/index.js';
import { ADA, APP_ID, BOT_TOKEN, CHANNEL, DM, fakeDiscord, GUILD } from './helpers/fake-discord.mjs';

const URL_ = 'https://bot.example.com/api/discord';
const text = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });

async function setup({ options = {}, api = {}, answer } = {}) {
  const fake = await fakeDiscord(api);
  const errors = [];
  const voiceflow = fakeVoiceflow(
    answer ??
      ((action) => {
        if (action.type === 'path-track') return [text('It ships tomorrow.')];
        return [
          text(`You said: ${typeof action.payload === 'string' ? action.payload : action.type}`),
          { type: 'choice', payload: { buttons: [{ name: 'Track order', request: { type: 'path-track', payload: { label: 'Track order' } } }] } },
        ];
      }),
  );
  const channels = await createChannels({
    voiceflow: { apiKey: 'VF.DM.discord-contract', projectID: 'proj1', environment: 'development', fetch: voiceflow.fetch },
    channels: [
      discord({ ...options, adapter: { botToken: BOT_TOKEN, publicKey: fake.publicKey, applicationId: APP_ID, apiUrl: fake.apiUrl, logger: silent } }),
    ],
    state: createMemoryState(),
    onError: (error) => errors.push(error),
  });
  const wait = waiter();
  const send = async (request) => {
    const response = await channels.webhook('discord', request, wait.options);
    await wait.settle();
    return response;
  };
  return {
    fake,
    voiceflow,
    errors,
    channels,
    interaction: (payload, how) => send(fake.signed(URL_, payload, how)),
    gateway: (data, token) => send(fake.forwarded(URL_, 'GATEWAY_MESSAGE_CREATE', data, token)),
    /** The calls since the last look, as "METHOD /path". */
    calls: () => fake.taken().map((c) => ({ ...c, at: `${c.method} ${c.path.replace(/\/(interactions|webhooks)\/\d+\/[^/]+/, '/$1/:id/:token')}` })),
  };
}

const silent = { child: () => silent, debug() {}, info() {}, warn() {}, error() {} };
const posted = (calls) => calls.filter((c) => /messages$|:token$|@original$/.test(c.at) && c.body?.content !== undefined).map((c) => c.body.content);
const slash = (fake, more = {}) => ({
  type: 2,
  id: fake.next(),
  application_id: APP_ID,
  token: 'interaction-token',
  version: 1,
  locale: 'en-US',
  guild_id: GUILD,
  channel_id: CHANNEL,
  channel: { id: CHANNEL, type: 0 },
  member: { user: ADA, roles: [], nick: null },
  data: { id: '9', name: 'ask', type: 1, options: [{ name: 'question', type: 3, value: "what's the refund policy?" }] },
  ...more,
});

test("Discord's signed check of the address is answered, and a forged one is refused", async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const ping = { type: 1, id: '1', application_id: APP_ID, token: 't', version: 1 };
  const ok = await s.interaction(ping);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { type: 1 });
  assert.equal((await s.interaction(ping, { forged: true })).status, 401);
  assert.equal((await s.gateway(s.fake.written(`<@${APP_ID}> hi`), 'not-the-bot-token')).status, 401);
  assert.equal(s.voiceflow.interacts.length, 0);
});

test('a mention opens a thread named after the question, and the agent answers in it with who and where', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const message = s.fake.written(`<@${APP_ID}> where is my order?`);
  assert.equal((await s.gateway(message)).status, 200);
  const calls = s.calls();
  const at = calls.map((c) => c.at);
  // The thread is the adapter's: started from the person's message, so it has that message's ID.
  const started = calls.find((c) => c.at === `POST /channels/${CHANNEL}/messages/${message.id}/threads`);
  assert.ok(started, at.join('\n'));
  // It is made under its name: what was asked, without the mention it began with. A rename afterwards would
  // leave "changed the channel name" as the thread's first line, so there is none.
  assert.equal(started.body.name, 'where is my order?');
  assert.equal(s.fake.state.threads.get(message.id).name, 'where is my order?');
  assert.ok(!calls.some((c) => c.at === `PATCH /channels/${message.id}`), 'the thread was renamed after it was made');
  // The answer is in the thread, and nowhere else.
  assert.ok(at.includes(`POST /channels/${message.id}/messages`), at.join('\n'));
  assert.ok(!at.includes(`POST /channels/${CHANNEL}/messages`));
  assert.match(posted(calls).join('\n'), /You said: .*where is my order\?/);

  const turn = s.voiceflow.interacts.at(-1);
  assert.deepEqual(
    Object.keys(CONTEXT_VARIABLES).sort(),
    Object.keys(turn.variables)
      .filter((k) => k.startsWith('discord_'))
      .sort(),
  );
  assert.deepEqual(Object.fromEntries(Object.keys(CONTEXT_VARIABLES).map((k) => [k, turn.variables[k]])), {
    discord_user_id: ADA.id,
    discord_user_name: 'Ada Lovelace',
    discord_user_handle: 'ada',
    discord_guild_id: GUILD,
    discord_channel_id: CHANNEL,
    discord_thread_id: message.id,
    discord_channel_type: 'thread',
    discord_message_id: message.id,
  });
  assert.deepEqual(s.errors, []);

  // A later message in that thread needs no mention, and the thread keeps its name.
  const more = s.fake.written('and when will it arrive?', { channel_id: message.id, channel_type: 11 });
  await s.gateway(more);
  const later = s.calls();
  assert.ok(later.some((c) => c.at === `POST /channels/${message.id}/messages`));
  assert.ok(!later.some((c) => c.method === 'PATCH' && c.path === `/channels/${message.id}`), 'the thread was renamed again');
  assert.equal(s.voiceflow.interacts.at(-1).variables.discord_message_id, more.id);
  assert.equal(s.voiceflow.sessions.length, 1, 'the thread is one conversation');

  // A message in the channel that doesn't mention the bot isn't for it.
  const before = s.voiceflow.interacts.length;
  await s.gateway(s.fake.written('lunch?'));
  assert.equal(s.voiceflow.interacts.length, before);
});

test('a direct message is answered where it was sent', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const message = s.fake.written('hello', { guild_id: undefined, channel_id: DM, channel_type: 1 });
  await s.gateway(message);
  const calls = s.calls();
  assert.ok(calls.some((c) => c.at === `POST /channels/${DM}/messages`));
  assert.ok(!calls.some((c) => /threads$/.test(c.at)), 'a thread was opened in a direct message');
  const { variables } = s.voiceflow.interacts.at(-1);
  assert.equal(variables.discord_channel_type, 'dm');
  assert.equal(variables.discord_guild_id, '');
  assert.equal(variables.discord_thread_id, '');
  assert.equal(variables.discord_channel_id, DM);
});

test("a button's click sends its own request, as the person who clicked", async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const message = s.fake.written(`<@${APP_ID}> I need help`);
  await s.gateway(message);
  // The choices are a message of buttons alone. Discord refuses an embed with nothing in it, so none is sent.
  const choices = [...s.fake.state.messages.values()].find((m) => m.components.length);
  assert.ok(choices, 'the choices were posted as buttons, and Discord took them');
  assert.deepEqual(choices.embeds, []);
  const button = choices.components.flatMap((row) => row.components ?? []).find((c) => c.label === 'Track order');
  assert.ok(button?.custom_id, 'the choice was posted as a button');
  s.calls();
  const click = await s.interaction({
    type: 3,
    id: s.fake.next(),
    application_id: APP_ID,
    token: 'click-token',
    version: 1,
    guild_id: GUILD,
    channel_id: message.id,
    channel: { id: message.id, type: 11, parent_id: CHANNEL },
    member: { user: ADA, roles: [], nick: null },
    message: { id: s.fake.next(), channel_id: message.id, author: { id: APP_ID, bot: true }, content: '', components: [], embeds: [] },
    data: { component_type: 2, custom_id: button.custom_id },
  });
  assert.equal(click.status, 200);
  const turn = s.voiceflow.interacts.at(-1);
  assert.equal(turn.action.type, 'path-track');
  // A click has no message: who clicked is known from an earlier one, with nothing looked up.
  assert.equal(turn.variables.discord_user_id, ADA.id);
  assert.equal(turn.variables.discord_user_name, 'Ada Lovelace');
  assert.equal(turn.variables.discord_message_id, '');
  const after = s.calls();
  assert.ok(!after.some((c) => c.at === `GET /users/${ADA.id}`), 'someone already known was looked up again');
  assert.match(posted(after).join('\n'), /It ships tomorrow/);
  // The turn is over, so its buttons come off: Discord keeps a message's buttons unless an edit says otherwise.
  const retired = s.fake.state.messages.get(choices.id);
  assert.deepEqual(retired.components, [], 'the buttons were left on the message, to be clicked again');
  assert.equal(retired.embeds[0]?.description, '✓ Track order');
});

test('a card with text keeps its embed, and a message of text has no buttons added', async (t) => {
  const card = { title: 'Plan A', description: { text: 'The basic plan' }, buttons: [{ name: 'Pick A', request: { type: 'pick-a' } }] };
  const s = await setup({ answer: () => [text('Here is a plan:'), { type: 'cardV2', payload: card }] });
  t.after(s.fake.close);
  await s.gateway(s.fake.written(`<@${APP_ID}> show me a plan`));
  const sent = s.calls().filter((c) => /^POST \/channels\/\d+\/messages$/.test(c.at));
  const plain = sent.find((c) => c.body.content === 'Here is a plan:');
  assert.ok(plain && !('components' in plain.body) && !('embeds' in plain.body), JSON.stringify(plain?.body));
  const shown = sent.find((c) => c.body.embeds?.length);
  assert.equal(shown?.body.embeds[0].title, 'Plan A');
  assert.equal(shown.body.components[0].components[0].label, 'Pick A');
  assert.deepEqual(s.errors, []);
});

test('an answer longer than Discord shows in one message goes as several, with nothing cut off', async (t) => {
  // The adapter cuts a message at 2,000 characters and ends it "...", without a word to anyone.
  const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} of a long answer about the returns policy.`);
  const long = sentences.join(' ');
  assert.ok(long.length > 3000);
  const s = await setup({ answer: () => [text(long)] });
  t.after(s.fake.close);
  await s.gateway(s.fake.written(`<@${APP_ID}> tell me everything`));
  const parts = posted(s.calls());
  assert.ok(parts.length >= 2, `one message of ${parts[0]?.length} characters`);
  assert.ok(
    parts.every((part) => part.length <= 2000),
    parts.map((p) => p.length).join(','),
  );
  // In order, each ending where a sentence does, and every sentence there once.
  assert.ok(
    parts.every((part) => part.endsWith('policy.')),
    parts.map((p) => p.slice(-12)).join(' | '),
  );
  assert.equal(parts.join(' '), long);
  assert.deepEqual(s.errors, []);
});

test('an image the agent sends is shown as an image', async (t) => {
  const url = 'https://cdn.example.com/chart.png';
  const s = await setup({ answer: () => [text('Here it is:'), { type: 'visual', payload: { visualType: 'image', image: url } }] });
  t.after(s.fake.close);
  await s.gateway(s.fake.written(`<@${APP_ID}> show me the chart`));
  const calls = s.calls().filter((c) => /^POST \/channels\/\d+\/messages$/.test(c.at));
  // In an embed, which Discord draws: not an embed with nothing in it, which it refuses, with the link sent in its place.
  const image = calls.find((c) => c.body.embeds?.length);
  assert.equal(image?.body.embeds[0].image?.url, url);
  assert.ok(!posted(calls).includes(url), 'the image went as a link');
  assert.deepEqual(s.errors, []);
});

test('the slash command posts the question, and answers in a thread on it', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  const response = await s.interaction(slash(s.fake));
  // Discord is told at once that an answer is coming.
  assert.equal(response.status, 200);
  assert.equal((await response.json()).type, 5);
  const calls = s.calls();
  const at = calls.map((c) => c.at);
  // The question is the command's own answer, where everyone can see it.
  const question = calls.find((c) => c.at === 'PATCH /webhooks/:id/:token/messages/@original');
  assert.equal(question?.body.content, `<@${ADA.id}> asked: what's the refund policy?`);
  // The thread is started from that message, named after the question, and the answer goes in it.
  const thread = calls.find((c) => /^POST \/channels\/\d+\/messages\/\d+\/threads$/.test(c.at));
  assert.ok(thread, at.join('\n'));
  const threadId = thread.path.split('/')[4];
  // The thread is on the bot's own message ("… asked: …"), and is made under the question alone.
  assert.equal(thread.body.name, "what's the refund policy?");
  assert.equal(s.fake.state.threads.get(threadId).name, "what's the refund policy?");
  assert.ok(!calls.some((c) => c.at === `PATCH /channels/${threadId}`), 'the thread was renamed after it was made');
  assert.ok(at.includes(`POST /channels/${threadId}/messages`), at.join('\n'));
  assert.ok(!at.includes(`POST /channels/${CHANNEL}/messages`));
  const turn = s.voiceflow.interacts.at(-1);
  assert.deepEqual(turn.action, { type: 'text', payload: "what's the refund policy?" });
  assert.equal(turn.variables.discord_thread_id, threadId);
  assert.equal(turn.variables.discord_user_id, ADA.id);
  // A command says only who ran it: their name is looked up.
  assert.equal(turn.variables.discord_user_name, 'Ada Lovelace');
  assert.ok(at.includes(`GET /users/${ADA.id}`));
  assert.deepEqual(s.errors, []);

  // The thread is followed: the next message in it needs no command and no mention.
  await s.gateway(s.fake.written('and for sale items?', { channel_id: threadId, channel_type: 11 }));
  assert.deepEqual(s.voiceflow.interacts.at(-1).action, { type: 'text', payload: 'and for sale items?' });
  assert.equal(s.voiceflow.sessions.length, 1);
});

test('the slash command\'s first answer is tried again while Discord hasn\'t taken "thinking…" yet', async (t) => {
  // Discord knows of an interaction's answer only once it has the reply to its own request. A post that gets
  // there first is refused as an unknown webhook: twice here, as when the reply comes back through a tunnel.
  const s = await setup({ api: { unknownWebhook: 2 } });
  t.after(s.fake.close);
  await s.interaction(slash(s.fake));
  const calls = s.calls();
  // The adapter sends its first try as an edit of "thinking…", and each one after as a follow-up: Discord takes
  // the first follow-up to a deferred answer as that edit, so either way the question lands where it should.
  const tries = calls.filter((c) => /^(PATCH|POST) \/webhooks\/:id\/:token/.test(c.at) && c.body?.content === `<@${ADA.id}> asked: what's the refund policy?`);
  assert.equal(tries.length, 3, 'two refusals, then the one Discord took');
  assert.equal(s.fake.state.unknownWebhook, 0);
  assert.equal(s.voiceflow.interacts.at(-1)?.action.payload, "what's the refund policy?");
  assert.match(posted(calls).join('\n'), /You said: what's the refund policy\?/);
  assert.deepEqual(s.errors, []);
});

test('in a direct message the slash command is answered in place', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  await s.interaction(slash(s.fake, { guild_id: undefined, channel_id: DM, channel: { id: DM, type: 1 }, member: undefined, user: ADA }));
  const calls = s.calls();
  assert.ok(!calls.some((c) => /threads$/.test(c.at)), 'a thread was opened in a direct message');
  assert.match(posted(calls).join('\n'), /asked: what's the refund policy\?[\s\S]*You said: what's the refund policy\?/);
  assert.equal(s.voiceflow.interacts.at(-1).variables.discord_channel_type, 'dm');
});

test("where the bot can't open a thread, the slash command is answered in the channel and the failure is reported", async (t) => {
  const s = await setup({ api: { denyThreads: true } });
  t.after(s.fake.close);
  await s.interaction(slash(s.fake));
  const calls = s.calls();
  // Still answered: through the command's own webhook, as a follow-up to the question.
  assert.ok(
    calls.some((c) => c.at === 'POST /webhooks/:id/:token' && /You said/.test(c.body?.content ?? '')),
    calls.map((c) => c.at).join('\n'),
  );
  assert.equal(s.errors.length, 1);
  assert.match(String(s.errors[0]?.message ?? s.errors[0]), /403|Missing Permissions/);
  // An open channel isn't followed: the next message there isn't taken as one for the agent.
  const before = s.voiceflow.interacts.length;
  await s.gateway(s.fake.written('unrelated chatter'));
  assert.equal(s.voiceflow.interacts.length, before);
});

test('each part can be turned off', async (t) => {
  const s = await setup({ options: { titles: false, context: false, slashCommands: false } });
  t.after(s.fake.close);
  const message = s.fake.written(`<@${APP_ID}> hi`);
  await s.gateway(message);
  const calls = s.calls();
  // With titles off the thread keeps the adapter's name: nothing reads the message back to name it, and nothing renames it.
  assert.match(calls.find((c) => /\/threads$/.test(c.at))?.body.name, /^Thread /);
  assert.ok(!calls.some((c) => c.at === `GET /channels/${CHANNEL}/messages/${message.id}`), 'the message was read back for a name');
  assert.ok(!calls.some((c) => c.method === 'PATCH' && c.path === `/channels/${message.id}`), 'the thread was renamed');
  assert.deepEqual(
    Object.keys(s.voiceflow.interacts.at(-1).variables ?? {}).filter((k) => k.startsWith('discord_')),
    [],
  );
  const before = s.voiceflow.interacts.length;
  await s.interaction(slash(s.fake));
  assert.equal(s.voiceflow.interacts.length, before, 'the slash command ran a turn');
});

test("where the bot can't read the message back, the thread is made as the adapter names it and renamed after", async (t) => {
  const s = await setup({ api: { denyRead: true } });
  t.after(s.fake.close);
  const message = s.fake.written(`<@${APP_ID}> where is my order?`);
  await s.gateway(message);
  const calls = s.calls();
  assert.match(calls.find((c) => /\/threads$/.test(c.at))?.body.name, /^Thread /);
  assert.deepEqual(calls.find((c) => c.at === `PATCH /channels/${message.id}`)?.body, { name: 'where is my order?' });
  assert.equal(s.fake.state.threads.get(message.id).name, 'where is my order?');
  assert.match(posted(calls).join('\n'), /You said/);
});

test("a name Discord won't take for the thread doesn't cost the answer", async (t) => {
  const s = await setup({ api: { denyRead: true, denyRename: true } });
  t.after(s.fake.close);
  const message = s.fake.written(`<@${APP_ID}> where is my order?`);
  await s.gateway(message);
  assert.match(posted(s.calls()).join('\n'), /You said/);
  assert.equal(s.voiceflow.interacts.length, 1);
});

test('a thread people made is never renamed', async (t) => {
  const s = await setup();
  t.after(s.fake.close);
  // A mention inside a thread someone else started: the message isn't the thread's first.
  s.fake.state.threads.set('777777777777777777', { parent: CHANNEL, name: 'Lunch plans' });
  await s.gateway(s.fake.written(`<@${APP_ID}> any ideas?`, { channel_id: '777777777777777777', channel_type: 11 }));
  assert.equal(s.fake.state.threads.get('777777777777777777').name, 'Lunch plans');
  assert.match(posted(s.calls()).join('\n'), /You said/);
});

test("every variable is set on every turn, empty when unknown: none keeps the last turn's value", async () => {
  const { variables } = createDiscordExtension();
  const names = Object.keys(CONTEXT_VARIABLES).sort();
  // A turn that says nothing of who or where: a thread ID the adapter can't read, and nobody named.
  const unknown = {
    id: 'not-a-discord-thread',
    adapter: {
      decodeThreadId() {
        throw new Error('not a Discord thread');
      },
      getUser: async () => null,
    },
  };
  const nothing = await variables({ thread: unknown });
  assert.deepEqual(Object.keys(nothing).sort(), names);
  assert.deepEqual([...new Set(Object.values(nothing))], ['']);
  // Someone Discord doesn't know: their ID, and the rest empty.
  const stranger = await variables({ thread: unknown, userId: '999' });
  assert.deepEqual(Object.keys(stranger).sort(), names);
  assert.equal(stranger.discord_user_id, '999');
  assert.equal(stranger.discord_user_name, '');
});

test("the adapter's own logging is kept to warnings unless you give it a logger", () => {
  const defaults = createDiscordExtension().adapterDefaults;
  const printed = [];
  const { info, warn } = console;
  console.info = console.log = (...args) => printed.push(['info', ...args]);
  console.warn = (...args) => printed.push(['warn', ...args]);
  try {
    defaults.logger.info('Discord forwarded Gateway event received');
    defaults.logger.warn('Invalid gateway token');
  } finally {
    Object.assign(console, { info, warn, log: info });
  }
  assert.deepEqual(
    printed.map((p) => p[0]),
    ['warn'],
  );
});

test('a title is the question on one line, without its mention, cut at a word', () => {
  assert.equal(titleOf('<@111> where   is\nmy order?'), 'where is my order?');
  assert.equal(titleOf('@support-bot @other hello'), 'hello');
  assert.equal(titleOf('<@&222>'), '');
  const long = titleOf(`${'word '.repeat(40)}end`);
  assert.ok(long.length <= 100 && long.endsWith('…') && !long.includes('  '), long);
  assert.equal(titleOf('x'.repeat(300)).length, 100);
});
