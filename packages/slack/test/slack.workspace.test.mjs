// Slack's workspace tools, each run as Voiceflow's sandbox runs it, against a
// small Slack workspace: what they ask Slack, and above all where they refuse,
// because the bot can reach more than the person it's acting for.

import assert from 'node:assert/strict';
import test from 'node:test';
import { runFunction } from '@voiceflow/channels-sdk/testing';
import { slackToolScopes, slackTools, workspaceTools } from '../dist/index.js';
import { unixTime, utf8Length } from '../dist/tools/workspace.js';

const TOKEN = 'xoxb-workspace-test';
const NOW = Math.floor(Date.now() / 1000);

/** A Slack workspace as a `fetch`: people, channels with members (the bot is UBOT), history, and every call recorded. */
function workspace({ fail = {} } = {}) {
  const users = [
    { id: 'U2', name: 'ada', real_name: 'Ada Lovelace', tz: 'America/Toronto', profile: { title: 'Engineer', email: 'ada@example.com', display_name: 'ada' } },
    { id: 'U3', name: 'grace', real_name: 'Grace Hopper', tz: 'America/New_York', profile: { title: 'Admiral', email: 'grace@example.com' } },
    { id: 'U4', name: 'ghopkins', real_name: 'Grace Hopkins', profile: { title: 'Designer', email: 'gh@example.com' } },
    { id: 'UBOT', name: 'voiceflow', real_name: 'Voiceflow', is_bot: true, profile: {} },
    { id: 'U5', name: 'gone', real_name: 'Gone Person', deleted: true, profile: {} },
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
  const fetch = async (url, init = {}) => {
    const href = String(url);
    const type = init.headers?.['content-type'] ?? '';
    if (href.startsWith('https://files.slack.com/upload/')) {
      calls.push({ method: 'upload', body: init.body });
      return new Response('OK - 6', { status: 200 });
    }
    const m = href.match(/^https:\/\/slack\.com\/api\/([\w.]+)$/);
    if (!m) throw new Error(`a function reached outside Slack: ${href}`);
    const body = type.startsWith('application/json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    const call = { method: m[1], body, authorization: init.headers?.authorization, json: type.startsWith('application/json') };
    calls.push(call);
    call.answer = answer(m[1], body);
    return new Response(JSON.stringify(call.answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls, of: (method) => calls.filter((c) => c.method === method) };
}

const tool = (name) => workspaceTools.find((t) => t.name === name);
/** The inputs Voiceflow fills from variables and the secret, as this package sets them for Ada in #general. */
const wired = {
  token: TOKEN,
  user_id: 'U2',
  current_channel: 'C1',
  current_thread: '1700000000.000100',
  viewing_channel: '',
  user_timezone: 'America/Toronto',
};
async function run(name, inputs, ws = workspace()) {
  const t = tool(name);
  const given = Object.fromEntries(Object.entries({ ...wired, ...inputs }).filter(([k]) => k in t.inputs));
  return { out: await runFunction(t.code, given, { fetch: ws.fetch }), ws };
}

// ── All of them ─────────────────────────────────────────────────────────────

test('identity and the token come from Voiceflow, never from the model', () => {
  for (const t of workspaceTools) {
    assert.equal(t.inputs.token?.from, 'slack_bot_token', `${t.name} reads the secret`);
    assert.equal(t.inputs.user_id?.from, 'slack_user_id', `${t.name} reads who is asking`);
    for (const [name, input] of Object.entries(t.inputs)) {
      if (['token', 'user_id', 'current_channel', 'current_thread', 'viewing_channel', 'user_timezone'].includes(name))
        assert.ok(input.from, `${t.name}.${name} is wired`);
    }
    assert.ok(t.requires?.length, `${t.name} names its scopes`);
  }
  const set = slackTools();
  assert.deepEqual(Object.keys(set.secrets), ['slack_bot_token']);
  const wiredFrom = new Set(
    set.tools.flatMap((t) =>
      Object.values(t.inputs)
        .map((i) => i.from)
        .filter(Boolean),
    ),
  );
  for (const name of wiredFrom) assert.ok(name in set.variables || name in set.secrets, `${name} is created by the install`);
  assert.deepEqual(slackTools({ workspace: false }).secrets, undefined);
  assert.ok(slackToolScopes().includes('canvases:write'));
});

test('every workspace tool refuses, without calling Slack, when no Slack person is asking', async () => {
  for (const t of workspaceTools) {
    for (const user_id of ['', '0', 'not-a-user']) {
      const { out, ws } = await run(t.name, {
        user_id,
        text: 'x',
        channel: '#general',
        person: 'grace',
        query: 'grace',
        post_at: '2030-01-01T09:00',
        title: 't',
        link: 'https://x.test',
        content: 'c',
        filename: 'a.txt',
      });
      assert.equal(out.outputVars.ok, false, `${t.name} with user_id "${user_id}"`);
      assert.equal(out.next.path, 'error');
      assert.equal(ws.calls.length, 0, `${t.name} called Slack`);
    }
  }
});

test('every workspace tool returns only primitive outputs, and calls Slack with the bot token', async () => {
  for (const t of workspaceTools) {
    const { out, ws } = await run(t.name, {
      text: 'x',
      channel: '#general',
      person: '<@U3>',
      query: 'grace',
      post_at: '2030-01-01T09:00',
      title: 't',
      link: 'https://x.test',
      content: 'c',
      filename: 'a.txt',
    });
    for (const [k, v] of Object.entries(out.outputVars)) assert.ok(['string', 'number', 'boolean'].includes(typeof v), `${t.name}.${k} is ${typeof v}`);
    assert.equal(out.outputVars.ok, true, `${t.name}: ${out.outputVars.result}`);
    for (const c of ws.calls.filter((c) => c.method !== 'upload')) assert.equal(c.authorization, `Bearer ${TOKEN}`);
  }
});

// ── Each ────────────────────────────────────────────────────────────────────

test('slack_post_to_channel posts by name, says who for, and only where the person and the bot both are', async () => {
  const { out, ws } = await run('slack_post_to_channel', { channel: '#General', text: 'Release is Friday.' });
  assert.equal(out.outputVars.channel_id, 'C1');
  assert.equal(out.outputVars.link, `https://acme.slack.com/archives/C1/p${out.outputVars.message_ts.replace('.', '')}`);
  assert.match(out.outputVars.result, /^Posted in <#C1>: https:/, 'the link is in what the agent relays');
  assert.equal(ws.of('conversations.list').length, 0, "a name is looked up among the bot's channels, never the whole workspace");
  const [post] = ws.of('chat.postMessage');
  assert.equal(post.body.text, 'Release is Friday.');
  assert.deepEqual(post.body.blocks.at(-1), { type: 'context', elements: [{ type: 'mrkdwn', text: 'Posted for <@U2>' }] });

  const secret = await run('slack_post_to_channel', { channel: '#secret', text: 'hi' });
  assert.match(secret.out.outputVars.result, /aren't a member/);
  assert.equal(secret.ws.of('chat.postMessage').length, 0, 'nothing posted where the person is not a member');

  const random = await run('slack_post_to_channel', { channel: 'C3', text: 'hi' });
  assert.match(random.out.outputVars.result, /Add me to it first/);

  const nowhere = await run('slack_post_to_channel', { channel: '#nope', text: 'hi' });
  assert.match(nowhere.out.outputVars.result, /I'm not in a channel named #nope/);
  const notIn = await run('slack_post_to_channel', { channel: '#random', text: 'hi' });
  assert.match(notIn.out.outputVars.result, /I'm not in a channel named #random\. If it exists, add me/);
  assert.equal(notIn.ws.of('chat.postMessage').length, 0);
});

test('slack_post_to_channel and slack_message_person post once when the agent repeats the call', async () => {
  const ws = workspace();
  const text = 'Ship it & <celebrate>';
  const first = await run('slack_post_to_channel', { channel: '#general', text }, ws);
  const again = await run('slack_post_to_channel', { channel: '#general', text }, ws);
  assert.equal(ws.of('chat.postMessage').length, 1, 'posted once');
  assert.equal(again.out.outputVars.ok, true);
  assert.equal(again.out.outputVars.message_ts, first.out.outputVars.message_ts, 'the repeat answers with the first post');
  assert.match(again.out.outputVars.result, /^Already posted in <#C1>: https:.*didn't post it twice/);
  await run('slack_post_to_channel', { channel: '#general', text: 'Something else' }, ws);
  assert.equal(ws.of('chat.postMessage').length, 2, 'different text is a new post');
  await run('slack_post_to_channel', { channel: '#general', text, user_id: 'U3' }, ws);
  assert.equal(ws.of('chat.postMessage').length, 3, "the same text for someone else is that person's post");

  const dm = workspace();
  await run('slack_message_person', { person: '<@U3>', text: 'Standup moved.' }, dm);
  const dmAgain = await run('slack_message_person', { person: '<@U3>', text: 'Standup moved.' }, dm);
  assert.equal(dm.of('chat.postMessage').length, 1, 'messaged once');
  assert.match(dmAgain.out.outputVars.result, /Already sent to Grace Hopper/);

  const blind = workspace({ fail: { 'conversations.history': { ok: false, error: 'missing_scope', needed: 'channels:history' } } });
  await run('slack_post_to_channel', { channel: '#general', text }, blind);
  assert.equal(blind.of('chat.postMessage').length, 1, 'a history it cannot read never stops the post');
});

test('slack_message_person finds them by mention, email or name, and asks when a name is ambiguous', async () => {
  const byName = await run('slack_message_person', { person: 'Grace Hopper', text: 'Standup moved.' });
  assert.equal(byName.out.outputVars.person_id, 'U3');
  assert.deepEqual(byName.ws.of('conversations.open')[0].body, { users: 'U3' });
  const [post] = byName.ws.of('chat.postMessage');
  assert.equal(post.body.channel, 'D-U3');
  assert.match(JSON.stringify(post.body.blocks), /Sent for <@U2>/);

  const byEmail = await run('slack_message_person', { person: 'gh@example.com', text: 'x' });
  assert.equal(byEmail.out.outputVars.person_id, 'U4');
  const byMention = await run('slack_message_person', { person: '<@U3|grace>', text: 'x' });
  assert.equal(byMention.out.outputVars.person_id, 'U3');

  const ambiguous = await run('slack_message_person', { person: 'Grace H', text: 'x' });
  assert.match(ambiguous.out.outputVars.result, /More than one person matches Grace H: Grace Hopper \(<@U3>\), Grace Hopkins \(<@U4>\)/);
  assert.equal(ambiguous.ws.of('chat.postMessage').length, 0);

  const self = await run('slack_message_person', { person: '<@U2>', text: 'note to self' });
  assert.ok(!JSON.stringify(self.ws.of('chat.postMessage')[0].body.blocks).includes('Sent for'), 'no note on a message to yourself');
  assert.equal((await run('slack_message_person', { person: '<@U5>', text: 'x' })).out.next.path, 'error', 'not to a deactivated account');
});

test('slack_read_channel reads this conversation, or the one open beside the assistant panel, oldest first', async () => {
  const { out, ws } = await run('slack_read_channel', {});
  assert.equal(out.outputVars.channel_id, 'C1');
  assert.deepEqual(out.outputVars.messages.split('\n'), [
    '2023-11-14 22:15 UTC Ada Lovelace: Is the release on track?',
    '2023-11-14 22:18 UTC Grace Hopper: Shipping Friday. [2 replies]',
  ]);
  assert.equal(ws.of('conversations.members').length, 0, 'the conversation they are in needs no check');

  const panel = await run('slack_read_channel', { current_channel: 'D9', viewing_channel: 'C1' });
  assert.equal(panel.out.outputVars.channel_id, 'C1');
  assert.ok(panel.ws.of('conversations.members').length > 0, 'a channel beside the panel is checked');

  const secret = await run('slack_read_channel', { channel: '#secret' });
  assert.match(secret.out.outputVars.result, /aren't a member/);
  assert.equal(secret.ws.of('conversations.history').length, 0, 'never read for someone who is not a member');
});

test('slack_find_person searches names, titles and email, and leaves out bots and deactivated people', async () => {
  const { out } = await run('slack_find_person', { query: 'admiral' });
  assert.equal(out.outputVars.people, 'Grace Hopper (<@U3>), Admiral, time zone America/New_York, grace@example.com');
  const all = await run('slack_find_person', { query: 'o' });
  assert.ok(!/U5|UBOT/.test(all.out.outputVars.people));
  assert.match((await run('slack_find_person', { query: 'nobody' })).out.outputVars.result, /No one matches nobody/);
});

test("slack_schedule_message reads times in the person's zone and schedules into this thread by default", async () => {
  const { out, ws } = await run('slack_schedule_message', { text: 'Standup!', post_at: '2030-12-02T09:00' });
  assert.equal(out.outputVars.scheduled_message_id, 'Q1');
  const [call] = ws.of('chat.scheduleMessage');
  assert.equal(call.body.post_at, Date.UTC(2030, 11, 2, 14, 0) / 1000, '09:00 in Toronto in December is 14:00 UTC');
  assert.equal(call.body.channel, 'C1');
  assert.equal(call.body.thread_ts, '1700000000.000100');

  const elsewhere = await run('slack_schedule_message', { text: 'x', post_at: '2030-12-02T09:00:00Z', channel: '#general' });
  const [top] = elsewhere.ws.of('chat.scheduleMessage');
  assert.equal(top.body.post_at, Date.UTC(2030, 11, 2, 9, 0) / 1000);
  assert.equal(top.body.thread_ts, undefined, 'a channel named means a new post, not a reply');

  assert.match(
    (await run('slack_schedule_message', { text: 'x', post_at: 'tomorrow' })).out.outputVars.result,
    /relative time, like in 10 minutes, or as a date and time/,
  );
  const soon = await run('slack_schedule_message', { text: 'x', post_at: 'in 10 minutes' });
  const at = Number(soon.ws.of('chat.scheduleMessage')[0].body.post_at);
  assert.ok(Math.abs(at - (Math.floor(Date.now() / 1000) + 600)) <= 2, 'a relative time counts from now');
  assert.match((await run('slack_schedule_message', { text: 'x', post_at: '2001-01-01T09:00' })).out.outputVars.result, /in the past/);
  assert.match((await run('slack_schedule_message', { text: 'x', post_at: '2030-12-02T09:00', channel: '#secret' })).out.outputVars.result, /aren't a member/);
});

test("slack_pin_message pins this thread's first message, or a linked one where the person is a member", async () => {
  const { ws } = await run('slack_pin_message', {});
  assert.deepEqual(ws.of('pins.add')[0].body, { channel: 'C1', timestamp: '1700000000.000100' });
  const linked = await run('slack_pin_message', { message: 'https://acme.slack.com/archives/C2/p1700000123000456' });
  assert.match(linked.out.outputVars.result, /aren't a member/);
  assert.equal(linked.ws.of('pins.add').length, 0);
});

test('slack_add_bookmark adds a link to this channel and refuses anything but a web link', async () => {
  const { ws } = await run('slack_add_bookmark', { title: 'Runbook', link: 'https://example.com/runbook', emoji: ':book:' });
  assert.deepEqual(ws.of('bookmarks.add')[0].body, { channel_id: 'C1', title: 'Runbook', type: 'link', link: 'https://example.com/runbook', emoji: ':book:' });
  assert.equal((await run('slack_add_bookmark', { title: 'x', link: 'javascript:alert(1)' })).out.next.path, 'error');
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
  assert.equal(out.outputVars.link, 'https://acme.slack.com/docs/T1/F0CANVAS');
  assert.equal(out.outputVars.result, 'Created the canvas Release plan: https://acme.slack.com/docs/T1/F0CANVAS', 'the link is in what the agent relays');
  const dm = await run('slack_create_canvas', { title: 't', content: 'c', current_channel: 'D9' });
  assert.equal(dm.ws.of('canvases.access.set').length, 1, 'a DM is not shared to');
});

test("slack_send_file uploads the text in Slack's two steps, into this thread", async () => {
  const { ws } = await run('slack_send_file', { filename: 'report.csv', content: 'name\nhéllo', comment: 'Here it is' });
  assert.deepEqual(ws.of('files.getUploadURLExternal')[0].body, { filename: 'report.csv', length: '11' });
  assert.equal(ws.of('upload')[0].body, 'name\nhéllo');
  assert.deepEqual(ws.of('files.completeUploadExternal')[0].body, {
    files: [{ id: 'F0FILE', title: 'report.csv' }],
    channel_id: 'C1',
    thread_ts: '1700000000.000100',
    initial_comment: 'Here it is',
  });
});

test("Slack's refusals come back as something to tell the person", async () => {
  const scope = await run(
    'slack_find_person',
    { query: 'grace' },
    workspace({ fail: { 'users.list': { ok: false, error: 'missing_scope', needed: 'users:read' } } }),
  );
  assert.match(scope.out.outputVars.result, /lacks the users:read permission/);
  const auth = await run(
    'slack_post_to_channel',
    { channel: 'C1', text: 'x' },
    workspace({ fail: { 'chat.postMessage': { ok: false, error: 'invalid_auth' } } }),
  );
  assert.match(auth.out.outputVars.result, /slack_bot_token secret/);
});

test('times and sizes, computed without Node or browser globals', () => {
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
  assert.equal(utf8Length('héllo 👋'), 11);
});
