// Slack's workspace tools, each run as the server runs it, against a small
// Slack workspace: what they ask Slack, where they refuse (the bot can reach
// more than the person it's acting for), and what waits for that person's
// approval. Who is asking and where come from the turn, as the server knows
// them, never from the tool's inputs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { PASS_VARIABLE, TOOLS_URL_SECRET } from '@voiceflow/channelkit';
import { createWorkspaceTools, RETIRED_SECRETS, slackToolScopes, slackTools, workspaceTools } from '../dist/index.js';
import { unixTime } from '../dist/workspace.js';

const NOW = Math.floor(Date.now() / 1000);

/** A Slack workspace as the adapter's client: people, channels with members (the bot is UBOT), history, and every call recorded. */
function workspace({ fail = {} } = {}) {
  const users = [
    {
      id: 'U2',
      team_id: 'T1',
      name: 'ada',
      real_name: 'Ada Lovelace',
      tz: 'America/Toronto',
      profile: { title: 'Engineer', email: 'ada@example.com', display_name: 'ada' },
    },
    { id: 'U3', team_id: 'T1', name: 'grace', real_name: 'Grace Hopper', tz: 'America/New_York', profile: { title: 'Admiral', email: 'grace@example.com' } },
    { id: 'U4', team_id: 'T1', name: 'ghopkins', real_name: 'Grace Hopkins', profile: { title: 'Designer', email: 'gh@example.com' } },
    { id: 'UBOT', team_id: 'T1', name: 'voiceflow', real_name: 'Voiceflow', is_bot: true, profile: {} },
    { id: 'U5', team_id: 'T1', name: 'gone', real_name: 'Gone Person', deleted: true, profile: {} },
    // A guest, and someone from another organization in a shared channel.
    { id: 'U6', team_id: 'T1', name: 'guest', real_name: 'Gus Visitor', is_restricted: true, profile: { title: 'Contractor' } },
    { id: 'U7', team_id: 'T9', name: 'partner', real_name: 'Pat Partner', profile: { title: 'Partner' } },
    // Someone whose handle and display name, which they chose, are other people's names.
    { id: 'U8', team_id: 'T1', name: 'hopkins', real_name: 'Mallory Smith', profile: { display_name: 'grace hopper', title: 'Contractor' } },
    // Another app in the workspace: its messages can start a turn too.
    { id: 'UAPP', team_id: 'T1', name: 'relay', real_name: 'Relay', is_bot: true, profile: {} },
  ];
  const channels = [
    { id: 'C1', name: 'general', members: ['U2', 'U3', 'UBOT'] },
    { id: 'C2', name: 'secret', is_private: true, members: ['U3', 'UBOT'] },
    { id: 'C3', name: 'random', members: ['U2', 'U3'] },
  ];
  const history = {
    C1: [
      { ts: '1700000300.000100', user: 'U3', text: 'Shipping Friday.', reply_count: 2 },
      { ts: '1700000200.000100', subtype: 'channel_join', user: 'U4', text: 'joined' },
      { ts: '1700000100.000100', user: 'U2', text: 'Is the release on track?' },
    ],
  };
  const calls = [];
  let posted = 0;
  const page = (items, cursor, size) => {
    const start = Number(cursor || 0);
    const next = start + size < items.length ? String(start + size) : '';
    return { items: items.slice(start, start + size), next };
  };
  const answer = (method, b) => {
    if (fail[method]) return fail[method];
    const channel = channels.find((c) => c.id === (b.channel ?? b.channel_id));
    const botIn = (id) => id?.startsWith('D') || channels.find((c) => c.id === id)?.members.includes('UBOT');
    switch (method) {
      case 'auth.test':
        return { ok: true, url: 'https://acme.slack.com/', team_id: 'T1', user_id: 'UBOT' };
      case 'users.conversations': {
        // The bot's channels, one per page, so every lookup walks the cursor.
        const { items, next } = page(
          channels.filter((c) => c.members.includes('UBOT')),
          b.cursor,
          1,
        );
        return { ok: true, channels: items.map(({ members, ...c }) => c), response_metadata: { next_cursor: next } };
      }
      case 'conversations.members': {
        if (!channel || (channel.is_private && !channel.members.includes('UBOT'))) return { ok: false, error: 'channel_not_found' };
        const { items, next } = page(channel.members, b.cursor, 2);
        return { ok: true, members: items, response_metadata: { next_cursor: next } };
      }
      case 'conversations.history':
        if (!botIn(b.channel)) return { ok: false, error: 'not_in_channel' };
        return { ok: true, messages: (history[b.channel] ?? []).filter((m) => !b.oldest || Number(m.ts) > Number(b.oldest)).slice(0, Number(b.limit)) };
      case 'users.info': {
        const user = users.find((u) => u.id === b.user);
        return user ? { ok: true, user } : { ok: false, error: 'user_not_found' };
      }
      case 'users.lookupByEmail': {
        const user = users.find((u) => u.profile.email === b.email);
        return user ? { ok: true, user } : { ok: false, error: 'users_not_found' };
      }
      case 'users.list': {
        const { items, next } = page(users, b.cursor, 2);
        return { ok: true, members: items, response_metadata: { next_cursor: next } };
      }
      case 'conversations.open':
        return { ok: true, channel: { id: `D-${b.users}` } };
      case 'chat.postMessage': {
        if (!botIn(b.channel)) return { ok: false, error: 'not_in_channel' };
        // Slack stores the post, newest first, as the bot's, with its text escaped.
        const ts = `${Math.floor(Date.now() / 1000)}.${String(++posted).padStart(6, '0')}`;
        const escaped = String(b.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        (history[b.channel] ??= []).unshift({ ts, user: 'UBOT', bot_id: 'B1', text: escaped, blocks: b.blocks });
        return { ok: true, channel: b.channel, ts };
      }
      case 'chat.getPermalink':
        return { ok: true, permalink: `https://acme.slack.com/archives/${b.channel}/p${b.message_ts.replace('.', '')}` };
      case 'chat.scheduleMessage':
        if (Number(b.post_at) < NOW) return { ok: false, error: 'time_in_past' };
        return { ok: true, scheduled_message_id: 'Q1', channel: b.channel, post_at: Number(b.post_at) };
      case 'pins.add':
      case 'bookmarks.add':
      case 'canvases.access.set':
        return { ok: true };
      case 'canvases.create':
        return { ok: true, canvas_id: 'F0CANVAS' };
      case 'files.getUploadURLExternal':
        return { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0FILE' };
      case 'files.completeUploadExternal':
        return { ok: true, files: [{ id: 'F0FILE' }] };
      default:
        return { ok: false, error: 'unknown_method' };
    }
  };
  // Slack's client, as the adapter holds it: what Slack refuses, it throws, with Slack's answer as `data`.
  const apiCall = async (method, body = {}) => {
    const call = { method, body };
    calls.push(call);
    call.answer = answer(method, body);
    if (!call.answer.ok)
      throw Object.assign(new Error(`An API error occurred: ${call.answer.error}`), { code: 'slack_webapi_platform_error', data: call.answer });
    return call.answer;
  };
  // The one request a tool makes itself: a file's upload, to the address Slack gave it.
  const fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://files.slack.com/upload/')) throw new Error(`a tool reached outside Slack: ${url}`);
    calls.push({ method: 'upload', body: init.body, headers: init.headers });
    return new Response('OK - 6', { status: 200 });
  };
  return { apiCall, fetch, calls, of: (method) => calls.filter((c) => c.method === method) };
}

const THREAD_TS = '1700000000.000100';
/** A Slack thread as the tools use it: its ID, and the adapter's client. */
function threadIn(channel, ws, threadTs = THREAD_TS) {
  return {
    id: `slack:${channel}:${threadTs}`,
    adapter: {
      name: 'slack',
      webClient: { apiCall: ws.apiCall },
      decodeThreadId: (id) => {
        const [, c, ts = ''] = id.split(':');
        return { channel: c, threadTs: ts };
      },
    },
  };
}

/**
 * Runs a tool for Ada (U2) in #general's thread, approved, unless `turn` says
 * otherwise: `{ user, here, viewing, approved }`. Inputs the model left out arrive empty.
 */
async function run(name, input = {}, turn = {}) {
  const { ws = workspace(), here = 'C1', viewing, approved = true } = turn;
  // `user: undefined` means no one, so it isn't defaulted.
  const user = 'user' in turn ? turn.user : 'U2';
  const tool = createWorkspaceTools({ viewing: () => viewing, fetch: ws.fetch }).find((t) => t.name === name);
  const given = Object.fromEntries(Object.keys(tool.inputs ?? {}).map((k) => [k, String(input[k] ?? '')]));
  const out = await tool.run(given, { thread: threadIn(here, ws), userId: user, approved });
  return { out, ws };
}

const everything = {
  text: 'x',
  channel: '#general',
  person: '<@U3>',
  query: 'grace',
  post_at: '2030-01-01T09:00',
  title: 't',
  link: 'https://x.test',
  content: 'c',
  filename: 'a.txt',
};

// ── All of them ─────────────────────────────────────────────────────────────

test('the agent holds no Slack credential: each tool is a call to your server, with the pass', () => {
  for (const t of workspaceTools) {
    assert.equal(t.kind, 'server', t.name);
    const wired = Object.entries(t.inputs).filter(([, input]) => input.from);
    assert.deepEqual(wired.map(([name]) => name).sort(), [TOOLS_URL_SECRET, PASS_VARIABLE].sort(), `${t.name} reads only the server's address and the pass`);
    for (const name of ['token', 'user_id', 'current_channel', 'current_thread']) assert.equal(name in t.inputs, false, `${t.name} has no ${name} input`);
    assert.doesNotMatch(t.code, /slack\.com|xoxb|Bearer \$\{token\}/, `${t.name}'s function never talks to Slack`);
    assert.ok(t.requires?.length, `${t.name} names its scopes`);
  }
  const set = slackTools();
  assert.deepEqual(Object.keys(set.secrets), [TOOLS_URL_SECRET]);
  assert.ok(PASS_VARIABLE in set.variables && 'slack_user_id' in set.variables);
  assert.deepEqual(Object.keys(set.retiredSecrets), ['slack_bot_token']);
  assert.deepEqual(Object.keys(RETIRED_SECRETS), ['slack_bot_token']);
  const wiredFrom = new Set(
    set.tools.flatMap((t) =>
      Object.values(t.inputs)
        .map((i) => i.from)
        .filter(Boolean),
    ),
  );
  for (const name of wiredFrom) assert.ok(name in set.variables || name in set.secrets, `${name} is created by the install`);
  const presentationOnly = slackTools({ workspace: false });
  assert.equal(presentationOnly.secrets, undefined);
  assert.equal(PASS_VARIABLE in presentationOnly.variables, false);
  assert.ok(slackToolScopes().includes('canvases:write'));
});

test('every workspace tool refuses, without calling Slack, when no Slack person is asking', async () => {
  for (const t of workspaceTools) {
    for (const user of [undefined, '', '0', 'not-a-user']) {
      const { out, ws } = await run(t.name, everything, { user });
      assert.equal(out.ok, false, `${t.name} with user "${user}"`);
      assert.match(out.result, /can't tell who's asking/);
      assert.equal(ws.calls.length, 0, `${t.name} called Slack`);
    }
  }
});

test('every workspace tool returns only primitive outputs, the ones it declares', async () => {
  for (const t of workspaceTools) {
    const { out } = await run(t.name, everything);
    assert.equal(out.ok, true, `${t.name}: ${out.result}`);
    for (const [k, v] of Object.entries(out)) {
      assert.ok(['string', 'number', 'boolean'].includes(typeof v), `${t.name}.${k} is ${typeof v}`);
      assert.ok(k in t.outputs, `${t.name} declares ${k}`);
    }
  }
});

// ── What waits for approval ─────────────────────────────────────────────────

test("what leaves the conversation waits for the person's approval, and nothing is done until then", async () => {
  const asks = async (name, input, turn) => {
    const { out, ws } = await run(name, input, { ...turn, approved: false });
    assert.ok(out.approval, `${name} asks first: ${JSON.stringify(out)}`);
    for (const method of ['chat.postMessage', 'chat.scheduleMessage', 'pins.add', 'bookmarks.add', 'conversations.open']) {
      assert.equal(ws.of(method).length, 0, `${name} called ${method} before approval`);
    }
    return out.approval;
  };
  // The request says where, by ID, and all of what; what runs once approved is that ID, whatever the name comes to mean.
  const post = await asks('slack_post_to_channel', { channel: '#general', text: 'Release is Friday.\nBring cake.' });
  assert.deepEqual(post, {
    title: 'Post this message?',
    text: 'In <#C1>:\n\n> Release is Friday.\n> Bring cake.',
    input: { channel: 'C1', text: 'Release is Friday.\nBring cake.' },
  });
  // Who it goes to is named as the workspace has them, with their title: a display name is whatever its owner typed.
  const dm = await asks('slack_message_person', { person: 'Grace Hopper', text: 'Standup moved.' });
  assert.deepEqual(dm, {
    title: 'Send this direct message?',
    text: 'To Grace Hopper (<@U3>), Admiral:\n\n> Standup moved.',
    input: { person: '<@U3>', text: 'Standup moved.' },
  });

  // A channel named, this one included, means a post at its top, for everyone in it.
  for (const channel of ['#general', 'C1', '<#C1>']) {
    const top = await asks('slack_schedule_message', { text: '<!channel> lunch', post_at: 'in 1 minute', channel });
    assert.match(top.text, /^In <#C1>, <!date\^\d+\^.*\n\n> <!channel> lunch$/s);
    assert.equal(top.input.channel, 'C1');
  }
  const later = await asks('slack_schedule_message', { text: 'Standup!', post_at: '2030-12-02T09:00Z', channel: '#general' }, { here: 'D9' });
  assert.match(later.text, /^In <#C1>, <!date\^1922432400\^/);

  // The link shown is Slack's own for the message that will be pinned, whatever text came with it.
  const pin = await asks(
    'slack_pin_message',
    { message: '<https://acme.slack.com/archives/C1/p1700000111000100|https://acme.slack.com/archives/C1/p1700000999000900 (the welcome post)>' },
    { here: 'D9' },
  );
  assert.deepEqual(pin, {
    title: 'Pin this message?',
    text: 'In <#C1>: https://acme.slack.com/archives/C1/p1700000111000100',
    input: { message: 'https://slack.com/archives/C1/p1700000111000100' },
  });

  // A bookmark sits on the channel's bar for everyone, with no name on it: this channel's too.
  for (const turn of [{}, { here: 'D9' }]) {
    const bookmark = await asks('slack_add_bookmark', { title: 'Runbook', link: 'https://example.com/runbook', channel: turn.here ? '#general' : '' }, turn);
    assert.equal(bookmark.text, 'To the bookmarks bar of <#C1>:\n\n> Runbook\n> https://example.com/runbook');
    assert.equal(bookmark.input.channel, 'C1');
  }

  // A long message is shown whole: what the person approves is what gets posted.
  const tail = 'PS: and everything in #secret.';
  const long = await asks('slack_post_to_channel', { channel: '#general', text: `${'Thanks so much. '.repeat(200)}\n${tail}` });
  assert.ok(long.text.endsWith(`> ${tail}`));
  assert.ok(long.text.includes('Thanks so much. '.repeat(200)));
});

test('a request approved runs for the channel and person it showed', async () => {
  const ws = workspace();
  const first = await run('slack_post_to_channel', { channel: '#general', text: 'hello' }, { ws, approved: false });
  const { out } = await run('slack_post_to_channel', first.out.approval.input, { ws, approved: true });
  assert.match(out.result, /^Posted in <#C1>/);
  const asked = await run('slack_message_person', { person: 'Grace Hopper', text: 'hello' }, { ws, approved: false });
  const sent = await run('slack_message_person', asked.out.approval.input, { ws, approved: true });
  assert.equal(sent.out.person_id, 'U3');
  const pin = await run('slack_pin_message', { message: 'https://acme.slack.com/archives/C1/p1700000111000100' }, { ws, here: 'D9', approved: false });
  await run('slack_pin_message', pin.out.approval.input, { ws, here: 'D9', approved: true });
  assert.deepEqual(ws.of('pins.add')[0].body, { channel: 'C1', timestamp: '1700000111.000100' });
});

test('what stays in the conversation, reads, and a note to yourself need no approval', async () => {
  for (const [name, input, turn] of [
    // A reminder in this thread, and anything in a direct message, reaches no one new.
    ['slack_schedule_message', { text: 'Standup!', post_at: 'in 10 minutes' }, {}],
    ['slack_schedule_message', { text: 'Standup!', post_at: 'in 10 minutes' }, { here: 'D9' }],
    ['slack_add_bookmark', { title: 'Runbook', link: 'https://example.com/runbook' }, { here: 'D9' }],
    ['slack_pin_message', {}, {}],
    ['slack_create_canvas', { title: 't', content: 'c' }, {}],
    ['slack_send_file', { filename: 'a.txt', content: 'c' }, {}],
    ['slack_read_channel', {}, {}],
    ['slack_find_person', { query: 'grace' }, {}],
    ['slack_message_person', { person: '<@U2>', text: 'note to self' }, {}],
  ]) {
    const { out } = await run(name, input, { ...turn, approved: false });
    assert.equal(out.ok, true, `${name}: ${JSON.stringify(out)}`);
  }
  // Reading has nothing to approve, so asking before every tool leaves these two alone.
  const tools = createWorkspaceTools();
  assert.deepEqual(
    tools.filter((t) => t.approval === false).map((t) => t.name),
    ['slack_read_channel', 'slack_find_person'],
  );
});

test("the person isn't asked to approve what would be refused", async () => {
  for (const [name, input, turn] of [
    ['slack_post_to_channel', { channel: '#secret', text: 'hi' }, {}],
    ['slack_post_to_channel', { channel: '#general', text: '' }, {}],
    ['slack_message_person', { person: '<@U3>', text: 'x' }, { user: 'U6' }],
    ['slack_message_person', { person: 'nobody at all', text: 'x' }, {}],
    ['slack_schedule_message', { text: 'x', post_at: 'tomorrow', channel: '#general' }, { here: 'D9' }],
    ['slack_add_bookmark', { title: 'x', link: 'https://x.test', channel: '#secret' }, {}],
    ['slack_add_bookmark', { title: 'x', link: 'javascript:alert(1)' }, {}],
    ['slack_pin_message', { message: 'https://acme.slack.com/archives/C2/p1700000123000456' }, {}],
  ]) {
    const { out } = await run(name, input, { ...turn, approved: false });
    assert.equal(out.ok, false, `${name}: ${JSON.stringify(out)}`);
    assert.equal(out.approval, undefined, `${name} asked for approval`);
  }
});

// ── Each ────────────────────────────────────────────────────────────────────

test('slack_post_to_channel posts by name, says who for, and only where the person and the bot both are', async () => {
  const { out, ws } = await run('slack_post_to_channel', { channel: '#General', text: 'Release is Friday.' });
  assert.equal(out.channel_id, 'C1');
  assert.equal(out.link, `https://acme.slack.com/archives/C1/p${out.message_ts.replace('.', '')}`);
  assert.match(out.result, /^Posted in <#C1>: https:/, 'the link is in what the agent relays');
  assert.equal(ws.of('conversations.list').length, 0, "a name is looked up among the bot's channels, never the whole workspace");
  const [post] = ws.of('chat.postMessage');
  assert.equal(post.body.text, 'Release is Friday.');
  assert.deepEqual(post.body.blocks.at(-1), { type: 'context', elements: [{ type: 'mrkdwn', text: 'Posted for <@U2>' }] });

  const secret = await run('slack_post_to_channel', { channel: '#secret', text: 'hi' });
  assert.match(secret.out.result, /you and I are both in\. If you're in that one, add me to it first/);
  assert.equal(secret.ws.of('chat.postMessage').length, 0, 'nothing posted where the person is not a member');

  const random = await run('slack_post_to_channel', { channel: 'C3', text: 'hi' });
  assert.match(random.out.result, /Add me to it first/);

  const nowhere = await run('slack_post_to_channel', { channel: '#nope', text: 'hi' });
  assert.equal(nowhere.out.result, secret.out.result, "a private channel the person isn't in sounds like one that doesn't exist");
  const notIn = await run('slack_post_to_channel', { channel: '#random', text: 'hi' });
  assert.equal(notIn.out.result, secret.out.result);
  assert.equal(notIn.ws.of('chat.postMessage').length, 0);
  const hidden = await run('slack_post_to_channel', { channel: 'C99', text: 'hi' });
  assert.equal(hidden.out.result, secret.out.result, 'so does an ID Slack says it cannot find');
});

test('slack_post_to_channel and slack_message_person post once when the agent repeats the call', async () => {
  const ws = workspace();
  const text = 'Ship it & <celebrate>';
  const first = await run('slack_post_to_channel', { channel: '#general', text }, { ws });
  const again = await run('slack_post_to_channel', { channel: '#general', text }, { ws });
  assert.equal(ws.of('chat.postMessage').length, 1, 'posted once');
  assert.equal(again.out.ok, true);
  assert.equal(again.out.message_ts, first.out.message_ts, 'the repeat answers with the first post');
  assert.match(again.out.result, /^Already posted in <#C1>: https:.*didn't post it twice/);
  await run('slack_post_to_channel', { channel: '#general', text: 'Something else' }, { ws });
  assert.equal(ws.of('chat.postMessage').length, 2, 'different text is a new post');
  await run('slack_post_to_channel', { channel: '#general', text }, { ws, user: 'U3' });
  assert.equal(ws.of('chat.postMessage').length, 3, "the same text for someone else is that person's post");

  const dm = workspace();
  await run('slack_message_person', { person: '<@U3>', text: 'Standup moved.' }, { ws: dm });
  const dmAgain = await run('slack_message_person', { person: '<@U3>', text: 'Standup moved.' }, { ws: dm });
  assert.equal(dm.of('chat.postMessage').length, 1, 'messaged once');
  assert.match(dmAgain.out.result, /Already sent to Grace Hopper/);

  const blind = workspace({ fail: { 'conversations.history': { ok: false, error: 'missing_scope', needed: 'channels:history' } } });
  await run('slack_post_to_channel', { channel: '#general', text }, { ws: blind });
  assert.equal(blind.of('chat.postMessage').length, 1, 'a history it cannot read never stops the post');
});

test('slack_message_person finds them by mention, email or name, and asks when a name is ambiguous', async () => {
  const byName = await run('slack_message_person', { person: 'Grace Hopper', text: 'Standup moved.' });
  assert.equal(byName.out.person_id, 'U3');
  assert.deepEqual(byName.ws.of('conversations.open')[0].body, { users: 'U3' });
  const [post] = byName.ws.of('chat.postMessage');
  assert.equal(post.body.channel, 'D-U3');
  assert.match(JSON.stringify(post.body.blocks), /Sent for <@U2>/);

  const byEmail = await run('slack_message_person', { person: 'gh@example.com', text: 'x' });
  assert.equal(byEmail.out.person_id, 'U4');
  const byMention = await run('slack_message_person', { person: '<@U3|grace>', text: 'x' });
  assert.equal(byMention.out.person_id, 'U3');

  const ambiguous = await run('slack_message_person', { person: 'Grace H', text: 'x' });
  assert.match(ambiguous.out.result, /More than one person matches Grace H: Grace Hopper \(<@U3>\), Grace Hopkins \(<@U4>\), Mallory Smith \(<@U8>\)/);
  assert.equal(ambiguous.ws.of('chat.postMessage').length, 0);

  for (const user of ['U6', 'U7', 'UAPP']) {
    const outsider = await run('slack_message_person', { person: '<@U3>', text: 'x' }, { user });
    assert.match(outsider.out.result, /Only full members of this workspace/, `${user} is refused`);
    assert.equal(outsider.ws.of('chat.postMessage').length, 0);
  }

  const self = await run('slack_message_person', { person: '<@U2>', text: 'note to self' });
  assert.ok(!JSON.stringify(self.ws.of('chat.postMessage')[0].body.blocks).includes('Sent for'), 'no note on a message to yourself');
  assert.equal((await run('slack_message_person', { person: '<@U5>', text: 'x' })).out.ok, false, 'not to a deactivated account');
});

test('slack_read_channel reads this conversation, or the one open beside the assistant panel, oldest first', async () => {
  const { out, ws } = await run('slack_read_channel', {});
  assert.equal(out.channel_id, 'C1');
  assert.deepEqual(out.messages.split('\n'), [
    '2023-11-14 22:15 UTC Ada Lovelace: Is the release on track?',
    '2023-11-14 22:18 UTC Grace Hopper: Shipping Friday. [2 replies]',
  ]);
  assert.equal(ws.of('conversations.members').length, 0, 'the conversation they are in needs no check');

  const panel = await run('slack_read_channel', {}, { here: 'D9', viewing: 'C1' });
  assert.equal(panel.out.channel_id, 'C1');
  assert.ok(panel.ws.of('conversations.members').length > 0, 'a channel beside the panel is checked');

  const secret = await run('slack_read_channel', { channel: '#secret' }, { here: 'D9' });
  assert.match(secret.out.result, /you and I are both in\. If you're in that one, add me to it first/);
  assert.equal(secret.ws.of('conversations.history').length, 0, 'never read for someone who is not a member');
});

test('slack_read_channel reads another channel only in a direct message, where no one else sees it', async () => {
  // Grace is in #secret (private) and asks in #general: everyone in #general would see the summary.
  const shared = await run('slack_read_channel', { channel: '#secret' }, { user: 'U3', here: 'C1' });
  assert.match(shared.out.result, /Everyone here would see what I read/);
  assert.equal(shared.ws.of('conversations.history').length, 0);
  assert.equal(shared.ws.of('conversations.members').length, 0, 'refused before anything about the channel is checked');

  const alone = await run('slack_read_channel', { channel: '#secret' }, { user: 'U3', here: 'D9' });
  assert.equal(alone.out.channel_id, 'C2', 'in a direct message, any channel the person is in');
});

test('slack_find_person searches names, titles and email, and leaves out bots, deactivated people and emails', async () => {
  const alone = { here: 'D9' };
  const { out } = await run('slack_find_person', { query: 'admiral' }, alone);
  assert.equal(out.people, 'Grace Hopper (<@U3>), Admiral, time zone America/New_York');
  const byEmail = await run('slack_find_person', { query: 'gh@example.com' }, alone);
  assert.equal(byEmail.out.people, 'Grace Hopkins (<@U4>), Designer');
  assert.ok(!/@example\.com/.test(byEmail.out.people), 'an email is searched, never shown');
  const all = await run('slack_find_person', { query: 'o' }, alone);
  assert.ok(!/U5|UBOT|UAPP/.test(all.out.people));
  assert.match((await run('slack_find_person', { query: 'nobody' }, alone)).out.result, /No one matches nobody/);
});

test('in a channel a lookup shows a name and a mention, as a message would; titles and time zones are for a direct message', async () => {
  const { out } = await run('slack_find_person', { query: 'admiral' });
  assert.equal(out.people, 'Grace Hopper (<@U3>)');
  assert.match(out.result, /Found 1\. For their titles and time zones, ask me in a direct message\./);
  assert.doesNotMatch(JSON.stringify(out), /Admiral|America/);
});

test('a name someone chose for themselves never picks them over the people it could mean', async () => {
  // Mallory's display name is "grace hopper" and her handle is "hopkins".
  const real = await run('slack_message_person', { person: 'Grace Hopper', text: 'x' });
  assert.equal(real.out.person_id, 'U3', "a full name is one person's: the real Grace Hopper");
  const handle = await run('slack_message_person', { person: 'hopkins', text: 'x' }, { approved: false });
  assert.equal(handle.out.ok, false, 'never an approval request naming Mallory');
  assert.match(handle.out.result, /More than one person matches hopkins: Grace Hopkins \(<@U4>\), Mallory Smith \(<@U8>\)\. Ask which one\./);
  assert.equal(handle.ws.of('chat.postMessage').length, 0);
  // Asked for by her own name, she is who she is.
  const mallory = await run('slack_message_person', { person: 'Mallory Smith', text: 'x' }, { approved: false });
  assert.match(mallory.out.approval.text, /^To Mallory Smith \(<@U8>\), Contractor:/);
});

test('an input is cut to the most its kind can be before it is matched', async () => {
  const started = Date.now();
  const time = await run('slack_schedule_message', { text: 'x', post_at: `in ${' '.repeat(60_000)}x` });
  assert.match(time.out.result, /relative time/);
  await run('slack_add_bookmark', { title: 'x', link: 'https://x.test', emoji: ':'.repeat(60_000) }, { here: 'D9' });
  await run('slack_find_person', { query: `${'a.'.repeat(30_000)}@` });
  assert.ok(Date.now() - started < 500, 'none of them takes long to read');
});

test('guests, people from other organizations and other apps get no directory', async () => {
  for (const user of ['U6', 'U7', 'UAPP']) {
    const { out, ws } = await run('slack_find_person', { query: 'grace' }, { user });
    assert.match(out.result, /Only full members of this workspace/, `${user} is refused`);
    assert.equal(ws.of('users.list').length, 0);
  }
});

test("slack_schedule_message reads times in the person's zone and schedules into this thread by default", async () => {
  const { out, ws } = await run('slack_schedule_message', { text: 'Standup!', post_at: '2030-12-02T09:00' });
  assert.equal(out.scheduled_message_id, 'Q1');
  const [call] = ws.of('chat.scheduleMessage');
  assert.equal(call.body.post_at, Date.UTC(2030, 11, 2, 14, 0) / 1000, "09:00 in Toronto in December is 14:00 UTC: the zone is the person's own in Slack");
  assert.equal(call.body.channel, 'C1');
  assert.equal(call.body.thread_ts, THREAD_TS);

  const elsewhere = await run('slack_schedule_message', { text: 'x', post_at: '2030-12-02T09:00:00Z', channel: '#general' });
  const [top] = elsewhere.ws.of('chat.scheduleMessage');
  assert.equal(top.body.post_at, Date.UTC(2030, 11, 2, 9, 0) / 1000);
  assert.equal(top.body.thread_ts, undefined, 'a channel named means a new post, not a reply');

  assert.match(
    (await run('slack_schedule_message', { text: 'x', post_at: 'tomorrow' })).out.result,
    /relative time, like in 10 minutes, or as a date and time/,
  );
  const soon = await run('slack_schedule_message', { text: 'x', post_at: 'in 10 minutes' });
  const at = Number(soon.ws.of('chat.scheduleMessage')[0].body.post_at);
  assert.ok(Math.abs(at - (Math.floor(Date.now() / 1000) + 600)) <= 2, 'a relative time counts from now');
  assert.match((await run('slack_schedule_message', { text: 'x', post_at: '2001-01-01T09:00' })).out.result, /in the past/);
  assert.match(
    (await run('slack_schedule_message', { text: 'x', post_at: '2030-12-02T09:00', channel: '#secret' })).out.result,
    /you and I are both in\. If you're in that one, add me to it first/,
  );
});

test("slack_pin_message pins this thread's first message, or a linked one where the person is a member", async () => {
  const { ws } = await run('slack_pin_message', {});
  assert.deepEqual(ws.of('pins.add')[0].body, { channel: 'C1', timestamp: THREAD_TS });
  const linked = await run('slack_pin_message', { message: 'https://acme.slack.com/archives/C2/p1700000123000456' });
  assert.match(linked.out.result, /you and I are both in\. If you're in that one, add me to it first/);
  assert.equal(linked.ws.of('pins.add').length, 0);
  const theirs = await run('slack_pin_message', { message: 'https://acme.slack.com/archives/C2/p1700000123000456' }, { user: 'U3' });
  assert.deepEqual(theirs.ws.of('pins.add')[0].body, { channel: 'C2', timestamp: '1700000123.000456' });
});

test('slack_add_bookmark adds a link to this channel and refuses anything but a web link', async () => {
  const { ws } = await run('slack_add_bookmark', { title: 'Runbook', link: 'https://example.com/runbook', emoji: ':book:' });
  assert.deepEqual(ws.of('bookmarks.add')[0].body, { channel_id: 'C1', title: 'Runbook', type: 'link', link: 'https://example.com/runbook', emoji: ':book:' });
  assert.equal((await run('slack_add_bookmark', { title: 'x', link: 'javascript:alert(1)' })).out.ok, false);
});

test('slack_create_canvas writes markdown, lets the person edit it and this channel read it, and links to it', async () => {
  const { out, ws } = await run('slack_create_canvas', { title: 'Release plan', content: '# Plan\n- Friday' });
  assert.deepEqual(ws.of('canvases.create')[0].body, { title: 'Release plan', document_content: { type: 'markdown', markdown: '# Plan\n- Friday' } });
  assert.deepEqual(
    ws.of('canvases.access.set').map((c) => c.body),
    [
      { canvas_id: 'F0CANVAS', access_level: 'write', user_ids: ['U2'] },
      { canvas_id: 'F0CANVAS', access_level: 'read', channel_ids: ['C1'] },
    ],
  );
  assert.equal(out.link, 'https://acme.slack.com/docs/T1/F0CANVAS');
  assert.equal(out.result, 'Created the canvas Release plan: https://acme.slack.com/docs/T1/F0CANVAS', 'the link is in what the agent relays');
  const dm = await run('slack_create_canvas', { title: 't', content: 'c' }, { here: 'D9' });
  assert.equal(dm.ws.of('canvases.access.set').length, 1, 'a DM is not shared to');
});

test("slack_send_file uploads the text in Slack's two steps, into this thread, and the upload carries no token", async () => {
  const { ws } = await run('slack_send_file', { filename: 'report.csv', content: 'name\nhéllo', comment: 'Here it is' });
  assert.deepEqual(ws.of('files.getUploadURLExternal')[0].body, { filename: 'report.csv', length: 11 });
  assert.equal(ws.of('upload')[0].body, 'name\nhéllo');
  assert.deepEqual(Object.keys(ws.of('upload')[0].headers), ['content-type']);
  assert.deepEqual(ws.of('files.completeUploadExternal')[0].body, {
    files: [{ id: 'F0FILE', title: 'report.csv' }],
    channel_id: 'C1',
    thread_ts: THREAD_TS,
    initial_comment: 'Here it is',
  });
});

test("Slack's refusals come back as something to tell the person", async () => {
  const scope = await run(
    'slack_find_person',
    { query: 'grace' },
    { ws: workspace({ fail: { 'users.list': { ok: false, error: 'missing_scope', needed: 'users:read' } } }) },
  );
  assert.match(scope.out.result, /lacks the users:read permission/);
  const auth = await run(
    'slack_post_to_channel',
    { channel: 'C1', text: 'x' },
    { ws: workspace({ fail: { 'chat.postMessage': { ok: false, error: 'invalid_auth' } } }) },
  );
  assert.match(auth.out.result, /check SLACK_BOT_TOKEN/);
  assert.doesNotMatch(auth.out.result, /Voiceflow|secret/);
  // A failure that isn't Slack's answer (the network, say) is still an answer, not a throw.
  const ws = workspace();
  ws.apiCall = async () => {
    throw new Error('socket hang up');
  };
  const down = await run('slack_find_person', { query: 'grace' }, { ws });
  assert.deepEqual(down.out, { ok: false, result: 'Slack refused: request_failed.' });
});

test('times, read as the person would mean them', () => {
  assert.equal(unixTime('2030-07-01T09:00', 'America/Toronto'), Date.UTC(2030, 6, 1, 13, 0) / 1000, 'summer time');
  assert.equal(unixTime('2030-07-01T09:00+02:00', 'America/Toronto'), Date.UTC(2030, 6, 1, 7, 0) / 1000);
  assert.equal(unixTime('2030-07-01', ''), Date.UTC(2030, 6, 1, 9, 0) / 1000, 'a date alone means 09:00');
  assert.ok(Number.isNaN(unixTime('next week', 'UTC')));
  const now = Math.floor(Date.now() / 1000);
  for (const [said, seconds] of [
    ['in 10 minutes', 600],
    ['+15m', 900],
    ['in an hour', 3600],
    ['2 hours', 7200],
    ['in 1.5 hours', 5400],
    ['in 3 days', 259200],
    ['in a week', 604800],
    ['5 mins from now', 300],
  ]) {
    assert.ok(Math.abs(unixTime(said, 'America/Toronto') - (now + seconds)) <= 2, said);
  }
  assert.ok(Number.isNaN(unixTime('in 2 months', 'UTC')), 'months are not minutes');
});
