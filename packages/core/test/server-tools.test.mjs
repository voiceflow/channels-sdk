// Server tools: a tool's call from Voiceflow acts only for the conversation
// and person its pass names, and only after that person's approval where the
// tool asks for it. The bot, its state and its threads are stand-ins; the
// tool's function runs as Voiceflow's sandbox runs it.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  askFirst,
  createVoiceflowAgent,
  isToolCall,
  MAX_APPROVAL_TEXT,
  mintPass,
  PASS_VARIABLE,
  passKey,
  quoted,
  readPass,
  serverToolDefinition,
  serverToolSet,
  TOOLS_URL_SECRET,
} from '../dist/index.js';
import { installTools, memoryRecordStore } from '../dist/install.js';
import { fakeVoiceflow, fakeVoiceflowApi, runFunction } from '../dist/testing.js';
import { fakeBot, fakeThread, partsOf, toolCall } from './helpers/fakes.mjs';

const API_KEY = 'VF.TEST.key-for-server-tools';
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });
const from = (userId, text, id = '1') => ({ id, text, author: { userId } });

/** A tool that records every run. `acts` is what it did: nothing until it's approved, when it asks first. */
function recorder({ asks = false, ...rest } = {}) {
  const runs = [];
  const acts = [];
  const tool = {
    name: 'note',
    description: 'Writes a note.',
    inputs: { text: 'The note.' },
    outputs: { note_id: "The note's ID." },
    ...rest,
    async run(input, turn) {
      runs.push({ input, thread: turn.thread.id, userId: turn.userId, approved: turn.approved });
      if (asks && !turn.approved) return askFirst('Write this note?', input.text);
      acts.push(input.text);
      return { ok: true, result: `Noted: ${input.text}`, note_id: `n${acts.length}` };
    },
  };
  return { tool, runs, acts };
}

/**
 * An agent with these tools, attached to a bot with one Slack thread and one
 * thread on a channel with no buttons. `during(pass, call)` runs inside each
 * turn, where Voiceflow's functions would call the server.
 */
function setup({ tools, during, threads = [], ...options } = {}) {
  const slack = fakeThread('slack:C1:1700000000.000100', 'slack');
  const plain = fakeThread('plain:room:1', 'plain');
  const bot = fakeBot([slack, plain, ...threads]);
  const errors = [];
  let agent;
  const vf = fakeVoiceflow(async (_action, call) => {
    await during?.(call.variables[PASS_VARIABLE], call);
    return [say('done')];
  });
  agent = createVoiceflowAgent({
    voiceflow: { apiKey: API_KEY, projectID: 'p1', fetch: vf.fetch },
    streaming: false,
    tools,
    onError: (error) => errors.push(error),
    ...options,
  });
  agent.attach(bot);
  const call = async (pass, tool, input) => {
    const res = await agent.tools(toolCall(pass, tool, input));
    return { status: res.status, body: await res.json() };
  };
  return { agent, bot, slack, plain, vf, errors, call };
}

// ── The pass ────────────────────────────────────────────────────────────────

test('a pass says which thread and person, and only the key that made it can', () => {
  const key = passKey('a-secret-only-the-server-holds');
  const claims = { thread: 'slack:C1:1.2', user: 'U2', turn: 't1', expires: Date.now() + 60_000 };
  const pass = mintPass(key, claims);
  assert.deepEqual(readPass(key, pass), claims);
  assert.doesNotMatch(pass, /a-secret-only/, "the secret isn't in the pass");

  assert.equal(readPass(passKey('another-secret'), pass), null, 'signed with another key');
  const [v, body, sig] = pass.split('.');
  const forged = Buffer.from(JSON.stringify({ t: 'slack:C2:9.9', u: 'U9', n: 't1', e: claims.expires })).toString('base64url');
  assert.equal(readPass(key, `${v}.${forged}.${sig}`), null, 'another thread and person under the same signature');
  assert.equal(readPass(key, `${v}.${body}.${sig.slice(0, -2)}AA`), null, 'a changed signature');
  assert.equal(readPass(key, `${v}.${body}`), null);
  assert.equal(readPass(key, ''), null);
  assert.equal(readPass(key, 'not a pass'), null);
  assert.equal(readPass(key, pass, claims.expires), null, 'expired');
  assert.throws(() => passKey(''), TypeError);
});

// ── A tool's call ───────────────────────────────────────────────────────────

test("a tool runs for the conversation and person the turn's pass names, with only the inputs it declares", async () => {
  const { tool, runs } = recorder();
  let answer;
  const s = setup({
    tools: [tool],
    during: async (pass) => {
      // The call names another thread and person, and an input the tool doesn't have: none of it counts.
      answer = await s.call(pass, 'note', { text: 'buy milk', thread: 'slack:C9:9.9', userId: 'U9', admin: true });
    },
  });
  await s.agent.reply(s.slack, from('U2', 'remember milk'));

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { ok: true, result: 'Noted: buy milk', outputs: { note_id: 'n1' } });
  assert.deepEqual(runs, [{ input: { text: 'buy milk' }, thread: 'slack:C1:1700000000.000100', userId: 'U2', approved: false }]);
});

test('a call without a pass the server made does nothing', async () => {
  const { tool, runs } = recorder();
  let pass;
  const s = setup({
    tools: [tool],
    during: async (p) => {
      pass = p;
    },
  });
  await s.agent.reply(s.slack, from('U2', 'hello'));

  for (const [why, bad] of [
    ['no pass', undefined],
    ['an empty pass', ''],
    ['an unset variable', '0'],
    ['a guess', 'v1.e30.AAAA'],
    [
      'signed with another key',
      mintPass(passKey('someone-elses-secret-0123456789abcdef'), { thread: s.slack.id, user: 'U2', turn: 'x', expires: Date.now() + 60_000 }),
    ],
    ["this server's own, expired", mintPass(passKey(API_KEY), { thread: s.slack.id, user: 'U2', turn: 'y', expires: Date.now() - 1 })],
    [
      "this server's own, for a thread this bot doesn't have",
      mintPass(passKey(API_KEY), { thread: 'teams:x:y', user: 'U2', turn: 'z', expires: Date.now() + 60_000 }),
    ],
  ]) {
    const answer = await s.call(bad, 'note', { text: 'x' });
    assert.equal(answer.status, 401, why);
    assert.equal(answer.body.ok, false, why);
  }
  // A real pass, once its turn has ended.
  assert.equal((await s.call(pass, 'note', { text: 'late' })).status, 401, 'after the turn');
  assert.equal(runs.length, 0, 'the tool never ran');

  const get = await s.agent.tools(new Request('https://app.example/api/tools', { headers: { authorization: `Bearer ${pass}` } }));
  assert.equal(get.status, 405);
});

test("a pass still works while its turn runs, and names a tool only from this bot's own", async () => {
  const { tool, runs } = recorder();
  const answers = [];
  const s = setup({
    tools: [tool],
    during: async (pass) => {
      answers.push(await s.call(pass, 'note', { text: 'one' }));
      answers.push(await s.call(pass, 'note', { text: 'two' }));
      answers.push(await s.call(pass, 'delete_everything', {}));
    },
  });
  await s.agent.reply(s.slack, from('U2', 'two notes'));
  assert.deepEqual(
    answers.map((a) => a.status),
    [200, 200, 404],
  );
  assert.equal(runs.length, 2);
  assert.match(answers[2].body.result, /no tool named delete_everything/);
});

test('the pass is set by the server on every turn, new each time, and nothing else can stand in for it', async () => {
  const { tool } = recorder();
  const s = setup({ tools: [tool], variables: () => ({ [PASS_VARIABLE]: 'mine', plan: 'pro' }) });
  await s.agent.reply(s.slack, from('U2', 'one', '1'));
  await s.agent.reply(s.slack, from('U2', 'two', '2'));
  const [first, second] = s.vf.interacts.map((c) => c.variables);
  assert.equal(first.plan, 'pro');
  assert.match(first[PASS_VARIABLE], /^v1\./);
  assert.notEqual(first[PASS_VARIABLE], second[PASS_VARIABLE]);
  const claims = readPass(passKey(API_KEY), second[PASS_VARIABLE]);
  assert.equal(claims.thread, s.slack.id);
  assert.equal(claims.user, 'U2');

  // With no server tools there is no pass to set.
  const none = setup({});
  await none.agent.reply(none.slack, from('U2', 'hi'));
  assert.equal(PASS_VARIABLE in none.vf.interacts[0].variables, false);
});

test('your own toolSecret signs the pass instead of the API key, and a short one is refused', async () => {
  const { tool, runs } = recorder();
  const secret = 'a-long-random-secret-of-my-own-0123456789';
  let pass;
  const s = setup({
    tools: [tool],
    toolSecret: secret,
    during: async (p) => {
      pass = p;
      assert.equal((await s.call(p, 'note', { text: 'x' })).status, 200);
    },
  });
  await s.agent.reply(s.slack, from('U2', 'hello'));
  assert.ok(readPass(passKey(secret), pass, 0));
  assert.equal(readPass(passKey(API_KEY), pass, 0), null);
  assert.equal(runs.length, 1);
  assert.throws(() => createVoiceflowAgent({ voiceflow: { apiKey: API_KEY, projectID: 'p1' }, toolSecret: 'short' }), /32 or more/);
});

test('a tool that throws is reported, and the agent hears only that it failed', async () => {
  let answer;
  const s = setup({
    tools: [
      {
        name: 'breaks',
        description: 'Breaks.',
        run() {
          throw new Error('database password is hunter2');
        },
      },
    ],
    during: async (pass) => {
      answer = await s.call(pass, 'breaks', {});
    },
  });
  await s.agent.reply(s.slack, from('U2', 'go'));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, false);
  assert.doesNotMatch(JSON.stringify(answer.body), /hunter2/);
  assert.match(s.errors[0].message, /hunter2/);
});

test("a channel's own tools are offered only in that channel's conversations", async () => {
  const { tool, runs } = recorder({ name: 'slack_only' });
  const answers = {};
  const s = setup({
    extensions: [{ slug: 'slack', tools: [tool] }],
    during: async (pass, call) => {
      if (pass) answers[call.action.payload] = await s.call(pass, 'slack_only', { text: 'x' });
    },
  });
  await s.agent.reply(s.slack, from('U2', 'in slack'));
  await s.agent.reply(s.plain, from('p1', 'elsewhere'));
  assert.equal(answers['in slack'].status, 200);
  assert.equal(runs.length, 1);
  // The other channel has no server tools, so its turns carry no pass at all.
  assert.equal(PASS_VARIABLE in s.vf.interacts[1].variables, false);
  assert.throws(() => setup({ tools: [tool], extensions: [{ slug: 'slack', tools: [tool] }] }), /named slack_only/);
});

// ── Approval ────────────────────────────────────────────────────────────────

test('a tool that asks first does nothing until the person who asked approves, and then acts once', async () => {
  const { tool, runs, acts } = recorder({ asks: true });
  let first;
  const s = setup({
    tools: [tool],
    during: async (pass) => {
      first = await s.call(pass, 'note', { text: 'ship it' });
      // The agent repeats a slow call: the person isn't asked twice.
      await s.call(pass, 'note', { text: 'ship it' });
    },
  });
  await s.agent.reply(s.slack, from('U2', 'note this'));

  assert.equal(first.body.ok, true);
  assert.match(first.body.result, /approve/i);
  assert.match(first.body.result, /hasn't happened yet/);
  assert.deepEqual(acts, [], 'nothing was done');
  const cards = s.slack.posts.filter((p) => p?.type === 'card');
  assert.equal(cards.length, 1, 'one request, though the call came twice');
  const card = partsOf(cards[0]);
  assert.match(card.text, /Write this note\?/);
  assert.match(card.text, /ship it/);
  assert.deepEqual(
    card.buttons.map((b) => [b.id, b.label]),
    [
      ['vfa:approve', 'Approve'],
      ['vfa:cancel', 'Cancel'],
    ],
  );
  const id = card.buttons[0].value;
  const click = (actionId, userId) => s.agent.choose({ actionId, value: id, thread: s.slack, threadId: s.slack.id, user: { userId }, messageId: 'm7' });

  // Someone else in the thread can't approve it.
  await click('vfa:approve', 'U3');
  assert.deepEqual(acts, []);
  assert.equal(s.slack.ephemerals.length, 1);
  assert.equal(s.slack.ephemerals[0].user.userId, 'U3');

  // A double click arrives as two requests at once: the first takes it.
  await Promise.all([click('vfa:approve', 'U2'), click('vfa:approve', 'U2')]);
  assert.deepEqual(acts, ['ship it']);
  assert.deepEqual(runs.at(-1), { input: { text: 'ship it' }, thread: s.slack.id, userId: 'U2', approved: true });
  assert.equal(s.slack.edits.length, 1, 'the buttons are replaced by the outcome');
  assert.equal(s.slack.edits[0].messageId, 'm7');
  assert.match(partsOf(s.slack.edits[0].message).text, /✓ Noted: ship it/);
  assert.equal(partsOf(s.slack.edits[0].message).buttons.length, 0);

  // A second click, or a replayed one, does nothing more.
  await click('vfa:approve', 'U2');
  assert.deepEqual(acts, ['ship it']);
  assert.equal(s.vf.interacts.length, 1, 'an approval is not a turn');
});

test('cancelling leaves it undone, and a click on nothing pending is answered as expired', async () => {
  const { tool, acts } = recorder({ asks: true });
  const s = setup({
    tools: [tool],
    during: async (pass) => void (await s.call(pass, 'note', { text: 'maybe' })),
  });
  await s.agent.reply(s.slack, from('U2', 'note this'));
  const id = partsOf(s.slack.posts.find((p) => p?.type === 'card')).buttons[1].value;
  const click = (actionId, value) => s.agent.choose({ actionId, value, thread: s.slack, threadId: s.slack.id, user: { userId: 'U2' }, messageId: 'm7' });

  await click('vfa:cancel', id);
  assert.deepEqual(acts, []);
  assert.match(partsOf(s.slack.edits[0].message).text, /Cancelled/);

  const postsBefore = s.slack.posts.length;
  await click('vfa:approve', id);
  await click('vfa:approve', 'made-up-id');
  assert.deepEqual(acts, [], 'a cancelled request, or one that never was, approves nothing');
  // Its buttons come off, and nothing is posted for everyone: a stale button isn't a way to make the bot talk.
  assert.equal(s.slack.posts.length, postsBefore);
  assert.equal(s.slack.edits.length, 3);
  for (const edit of s.slack.edits.slice(1)) {
    assert.match(partsOf(edit.message).text, /expired/);
    assert.equal(partsOf(edit.message).buttons.length, 0);
  }

  // A request made in one conversation can't be approved from another.
  const other = setup({ tools: [tool], during: async (pass) => void (await other.call(pass, 'note', { text: 'here' })) });
  await other.agent.reply(other.slack, from('U2', 'note this'));
  const otherId = partsOf(other.slack.posts.find((p) => p?.type === 'card')).buttons[0].value;
  await other.agent.choose({ actionId: 'vfa:approve', value: otherId, thread: other.plain, threadId: other.plain.id, user: { userId: 'U2' }, messageId: 'm1' });
  assert.deepEqual(acts, []);
  assert.equal(other.plain.posts.length, 0, 'and that conversation hears nothing of it');
});

test('a request left unanswered expires: approving it then does nothing, and its buttons come off', async () => {
  const { tool, acts } = recorder({ asks: true });
  const s = setup({ tools: [tool], approvalTimeoutMs: 30, during: async (pass) => void (await s.call(pass, 'note', { text: 'too late' })) });
  await s.agent.reply(s.slack, from('U2', 'note this'));
  const id = partsOf(s.slack.posts.find((p) => p?.type === 'card')).buttons[0].value;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await s.agent.choose({ actionId: 'vfa:approve', value: id, thread: s.slack, threadId: s.slack.id, user: { userId: 'U2' }, messageId: 'm7' });
  assert.deepEqual(acts, []);
  assert.match(partsOf(s.slack.edits[0].message).text, /expired/);
  assert.equal(partsOf(s.slack.edits[0].message).buttons.length, 0);

  // Given longer, the same request is still there to approve.
  const patient = recorder({ asks: true });
  const p = setup({ tools: [patient.tool], approvalTimeoutMs: 60_000, during: async (pass) => void (await p.call(pass, 'note', { text: 'in time' })) });
  await p.agent.reply(p.slack, from('U2', 'note this'));
  const later = partsOf(p.slack.posts.find((post) => post?.type === 'card')).buttons[0].value;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await p.agent.choose({ actionId: 'vfa:approve', value: later, thread: p.slack, threadId: p.slack.id, user: { userId: 'U2' }, messageId: 'm7' });
  assert.deepEqual(patient.acts, ['in time']);
  assert.throws(() => createVoiceflowAgent({ voiceflow: { apiKey: API_KEY, projectID: 'p1' }, approvalTimeoutMs: 0 }), /more than 0/);
});

test('requireApproval turns asking off, or on before the tool runs at all', async () => {
  const quiet = recorder({ asks: true });
  const off = setup({ tools: [quiet.tool], requireApproval: false, during: async (pass) => void (await off.call(pass, 'note', { text: 'go' })) });
  await off.agent.reply(off.slack, from('U2', 'go'));
  assert.deepEqual(quiet.acts, ['go']);
  assert.equal(quiet.runs[0].approved, true);
  assert.equal(off.slack.posts.filter((p) => p?.type === 'card').length, 0);

  const plain = recorder();
  let answer;
  const on = setup({
    tools: [plain.tool],
    requireApproval: { note: true },
    during: async (pass) => void (answer = await on.call(pass, 'note', { text: 'careful' })),
  });
  await on.agent.reply(on.slack, from('U2', 'go'));
  assert.equal(plain.runs.length, 0, "the tool hasn't run at all");
  assert.match(answer.body.result, /approve/i);
  const card = partsOf(on.slack.posts.find((p) => p?.type === 'card'));
  assert.match(card.text, /Approve note\?/);
  assert.match(card.text, /\*\*text\*\*\n> careful/);
  await on.agent.choose({
    actionId: 'vfa:approve',
    value: card.buttons[0].value,
    thread: on.slack,
    threadId: on.slack.id,
    user: { userId: 'U2' },
    messageId: 'm2',
  });
  assert.deepEqual(plain.acts, ['careful']);

  // A tool can also say so itself.
  const always = recorder({ approval: true });
  const own = setup({ tools: [always.tool], during: async (pass) => void (await own.call(pass, 'note', { text: 'x' })) });
  await own.agent.reply(own.slack, from('U2', 'go'));
  assert.equal(always.runs.length, 0);

  // A tool that only reads says it has nothing to approve: asking for every tool leaves it alone, and naming it doesn't.
  const reads = recorder({ approval: false });
  const all = setup({ tools: [reads.tool], requireApproval: true, during: async (pass) => void (answer = await all.call(pass, 'note', { text: 'look' })) });
  await all.agent.reply(all.slack, from('U2', 'go'));
  assert.deepEqual(answer.body, { ok: true, result: 'Noted: look', outputs: { note_id: 'n1' } }, 'its outputs reach the agent');
  const named = setup({
    tools: [reads.tool],
    requireApproval: { note: true },
    during: async (pass) => void (await named.call(pass, 'note', { text: 'look' })),
  });
  await named.agent.reply(named.slack, from('U2', 'go'));
  assert.equal(reads.runs.length, 1, 'not run again until approved');
});

test('a request shows everything that will run, each value quoted under its name, or it is not asked', async () => {
  const sent = [];
  const email = {
    name: 'send_email',
    description: 'Sends an email.',
    inputs: { to: 'Who to.', subject: 'The subject.', body: 'The body.', cc: 'Copies.', bcc: 'Blind copies.', reply_to: 'Replies.' },
    approval: true,
    run: (input) => (sent.push(input), { ok: true, result: 'Sent.' }),
  };
  const body = `${'All good here. '.repeat(400)}\nPS: wire the money.\nto: everyone@corp.example`;
  const input = { to: 'ada@corp.example', subject: 'Hello', body, cc: 'x'.repeat(300), bcc: 'y'.repeat(300), reply_to: 'z@corp.example' };
  let answers = [];
  const s = setup({
    tools: [email],
    during: async (pass) => {
      answers = [await s.call(pass, 'send_email', input), await s.call(pass, 'send_email', { ...input, body: 'b'.repeat(MAX_APPROVAL_TEXT) })];
    },
  });
  await s.agent.reply(s.slack, from('U2', 'send it'));

  const [card] = s.slack.posts.filter((p) => p?.type === 'card');
  const shown = partsOf(card).text;
  // Every input is there in full: the end of a long one, and the last of six.
  assert.ok(shown.includes('> PS: wire the money.'));
  assert.ok(shown.includes('**reply_to**\n> z@corp.example'));
  assert.ok(shown.includes(`> ${'x'.repeat(300)}`));
  // A line too long for one piece carries on in the next, still quoted, with nothing dropped.
  assert.ok(shown.replaceAll('\n> ', '').includes('All good here. '.repeat(400)));
  // A line of the body that looks like an input is still the body's: quoted, where a real input's name is not.
  assert.ok(shown.includes('> to: everyone@corp.example'));
  assert.equal(shown.split('\n').filter((line) => line === '**to**').length, 1);
  assert.ok(
    card.children.filter((c) => c.type === 'text').every((c) => c.content.length <= 3000),
    'in pieces a channel takes',
  );

  // Too long to show in full: not asked, not done, and nothing left waiting.
  assert.equal(answers[1].body.ok, false);
  assert.match(answers[1].body.result, /too long to show them in full/);
  assert.equal(s.slack.posts.filter((p) => p?.type === 'card').length, 1);
  assert.deepEqual(sent, []);

  await s.agent.choose({
    actionId: 'vfa:approve',
    value: partsOf(card).buttons[0].value,
    thread: s.slack,
    threadId: s.slack.id,
    user: { userId: 'U2' },
    messageId: 'm1',
  });
  assert.deepEqual(sent, [input], 'what runs is what was shown');
  assert.ok(partsOf(s.slack.edits[0].message).text.includes('> PS: wire the money.'), 'and the thread keeps what was approved');
  assert.equal(quoted('one\ntwo'), '> one\n> two');
});

test('what runs once approved is what the tool resolved the call to, in the conversation it was asked in', async () => {
  const runs = [];
  const tool = {
    name: 'post',
    description: 'Posts.',
    inputs: { channel: 'Where.', text: 'What.' },
    run(input, turn) {
      runs.push({ input, thread: turn.thread.id, approved: turn.approved });
      // The name is looked up once; the approval is for the ID it meant then.
      if (!turn.approved) return askFirst('Post this?', `In C123:\n\n${quoted(input.text)}`, { ...input, channel: 'C123', role: 'admin' });
      return { ok: true, result: `Posted in ${input.channel}.` };
    },
  };
  // A direct message with no thread: the request starts one, so the click's thread is not the call's.
  const dm = fakeThread('slack:D1:', 'slack');
  const clicked = fakeThread('slack:D1:1700000009.000100', 'slack');
  const elsewhere = fakeThread('slack:D2:1700000009.000100', 'slack');
  const s = setup({
    tools: [tool],
    threads: [dm, clicked, elsewhere],
    during: async (pass) => void (await s.call(pass, 'post', { channel: '#general', text: 'hi' })),
  });
  await s.agent.reply(dm, from('U2', 'post it'));
  const cardIndex = dm.posts.findIndex((p) => p?.type === 'card');
  const cardId = `m${cardIndex + 1}`;
  const id = partsOf(dm.posts[cardIndex]).buttons[0].value;
  const click = (thread, messageId) => s.agent.choose({ actionId: 'vfa:approve', value: id, thread, threadId: thread.id, user: { userId: 'U2' }, messageId });

  // From another conversation, or from another message in this one, it is not this request.
  await click(elsewhere, cardId);
  await click(clicked, 'm999');
  assert.equal(runs.length, 1);

  await click(clicked, cardId);
  assert.deepEqual(runs[1], { input: { channel: 'C123', text: 'hi' }, thread: 'slack:D1:', approved: true });
  assert.match(partsOf(clicked.edits.at(-1).message).text, /✓ Posted in C123\./);
});

test('a failure on the way is an answer, never a leak, and leaves nothing stuck', async () => {
  const { tool, acts } = recorder({ asks: true });
  const answers = [];
  const s = setup({
    tools: [tool, { name: 'nothing', description: 'Returns nothing.', run: () => undefined }],
    during: async (pass) => {
      // The request can't be posted, once.
      const post = s.slack.post;
      s.slack.post = async () => {
        throw new Error('channel_not_found');
      };
      answers.push(await s.call(pass, 'note', { text: 'x' }));
      s.slack.post = post;
      answers.push(await s.call(pass, 'note', { text: 'x' }));
      answers.push(await s.call(pass, 'nothing', {}));
      // The state adapter goes down.
      s.bot.state.get = async () => {
        throw new Error('connect ECONNREFUSED redis://user:hunter2@10.0.0.5:6379');
      };
      answers.push(await s.call(pass, 'note', { text: 'y' }));
    },
  });
  await s.agent.reply(s.slack, from('U2', 'go'));

  assert.match(answers[0].body.result, /couldn't post the request for approval/);
  assert.match(answers[1].body.result, /asked the person to approve/, 'asking again works');
  assert.equal(s.slack.posts.filter((p) => p?.type === 'card').length, 1);
  assert.deepEqual([answers[2].status, answers[2].body.ok], [200, false], 'a tool that returns nothing has failed');
  assert.equal(answers[3].status, 500);
  assert.doesNotMatch(JSON.stringify(answers), /hunter2|redis|ECONNREFUSED|channel_not_found/);
  assert.ok(
    s.errors.some((e) => /hunter2/.test(e.message)),
    'the server hears what went wrong',
  );
  assert.deepEqual(acts, []);
});

test('a message with no author is no one: its turn gets a pass that names nobody', async () => {
  const { tool, runs } = recorder();
  const s = setup({ tools: [tool], during: async (pass) => void (await s.call(pass, 'note', { text: 'x' })) });
  await s.agent.reply(s.slack, from('unknown', 'hello'));
  assert.equal(runs[0].userId, undefined);
});

test("with no one to ask, a tool that needs approval doesn't act", async () => {
  const { tool, acts } = recorder({ asks: true });
  let answer;
  const s = setup({ tools: [tool], during: async (pass) => void (answer = await s.call(pass, 'note', { text: 'x' })) });
  // A turn the channel named no person for.
  await s.agent.run(s.slack, { type: 'launch' });
  assert.equal(answer.body.ok, false);
  assert.match(answer.body.result, /who's asking/);
  assert.deepEqual(acts, []);
});

test('where a channel has no buttons, the person who asked approves in words', async () => {
  const { tool, acts } = recorder({ asks: true });
  const s = setup({
    tools: [tool],
    during: async (pass, call) => {
      if (call.action.payload === 'note this') await s.call(pass, 'note', { text: 'typed' });
    },
  });
  await s.agent.reply(s.plain, from('p1', 'note this'));
  const request = s.plain.posts.find((p) => typeof p?.markdown === 'string' && /Write this note\?/.test(p.markdown));
  assert.ok(request, 'the request is text');
  assert.match(request.markdown, /Reply \*\*approve\*\*/);

  // Someone else's "approve" is just a message to the agent.
  await s.agent.reply(s.plain, from('p9', 'approve', '2'));
  assert.deepEqual(acts, []);
  assert.equal(s.vf.interacts.length, 2);

  await s.agent.reply(s.plain, from('p1', ' Approve ', '3'));
  assert.deepEqual(acts, ['typed']);
  assert.equal(s.vf.interacts.length, 2, 'the approval was not sent to the agent');
  assert.match(String(s.plain.posts.at(-1)), /✓ Noted: typed/);

  // With nothing waiting, the word goes to the agent like any other.
  await s.agent.reply(s.plain, from('p1', 'approve', '4'));
  assert.equal(s.vf.interacts.length, 3);

  // Two people with a request each: each answers their own, in either order.
  const both = recorder({ asks: true });
  const two = setup({ tools: [both.tool], during: async (pass, call) => void (await two.call(pass, 'note', { text: call.action.payload })) });
  await two.agent.reply(two.plain, from('p1', 'first', '1'));
  await two.agent.reply(two.plain, from('p2', 'second', '2'));
  await two.agent.reply(two.plain, from('p1', 'approve', '3'));
  await two.agent.reply(two.plain, from('p2', 'approve', '4'));
  assert.deepEqual(both.acts, ['first', 'second']);
});

// ── The function on the agent ───────────────────────────────────────────────

test("a server tool's function sends the model's inputs with the pass, and nothing of its own", async () => {
  const def = serverToolDefinition(recorder().tool);
  assert.equal(def.kind, 'server');
  assert.deepEqual(Object.keys(def.inputs), ['text', TOOLS_URL_SECRET, PASS_VARIABLE]);
  assert.equal(def.inputs.text.from, undefined, 'the model fills the text');
  assert.equal(def.inputs[TOOLS_URL_SECRET].from, TOOLS_URL_SECRET);
  assert.equal(def.inputs[PASS_VARIABLE].from, PASS_VARIABLE, 'the pass comes from the variable, never the model');
  assert.deepEqual(Object.keys(def.outputs), ['ok', 'result', 'note_id']);
  assert.match(def.code, /tool: 'note'/);
  assert.doesNotMatch(def.code, /__CHANNELS_TOOL__/);

  const requests = [];
  const server =
    (answer, status = 200) =>
    async (url, init) => {
      requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
    };
  const wired = { [TOOLS_URL_SECRET]: 'https://app.example/api/slack', [PASS_VARIABLE]: 'v1.pass.sig' };

  const done = await runFunction(
    def.code,
    { ...wired, text: 'buy "milk"' },
    { fetch: server({ ok: true, result: 'Noted.', outputs: { note_id: 'n1', nested: { no: 1 }, ok: false } }) },
  );
  assert.deepEqual(done, { outputVars: { ok: true, result: 'Noted.', note_id: 'n1' }, next: { path: 'success' } });
  assert.equal(requests[0].url, 'https://app.example/api/slack');
  assert.equal(requests[0].headers.authorization, 'Bearer v1.pass.sig');
  assert.ok(isToolCall(new Request(requests[0].url, { method: 'POST', headers: requests[0].headers })), 'marked as a tool call');
  assert.deepEqual(requests[0].body, { tool: 'note', input: { text: 'buy "milk"' } }, 'the pass and the URL are not inputs');

  const refusedByServer = await runFunction(def.code, { ...wired, text: 'x' }, { fetch: server({ ok: false, result: 'Not here.' }, 401) });
  assert.deepEqual(refusedByServer, { outputVars: { ok: false, result: 'Not here.' }, next: { path: 'error' } });
  const broken = await runFunction(def.code, { ...wired, text: 'x' }, { fetch: server('<html>Bad gateway</html>', 502) });
  assert.match(broken.outputVars.result, /answered 502/);
  const unreachable = await runFunction(
    def.code,
    { ...wired, text: 'x' },
    {
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    },
  );
  assert.equal(unreachable.outputVars.ok, false);
  assert.equal(unreachable.next.path, 'error');

  // Outside a connected channel (Voiceflow's test chat, another way into the agent) there is no pass: nothing is sent.
  requests.length = 0;
  for (const pass of ['', 0, undefined]) {
    const out = await runFunction(def.code, { [TOOLS_URL_SECRET]: wired[TOOLS_URL_SECRET], [PASS_VARIABLE]: pass, text: 'x' }, { fetch: server({}) });
    assert.equal(out.outputVars.ok, false);
    assert.match(out.outputVars.result, /only works in a conversation on a connected channel/);
  }
  const noUrl = await runFunction(def.code, { [PASS_VARIABLE]: 'v1.pass.sig', text: 'x' }, { fetch: server({}) });
  assert.match(noUrl.outputVars.result, /isn't connected to a server/);
  assert.equal(requests.length, 0);
});

test("a server tool's name, inputs and outputs are checked before anything is installed", () => {
  const base = { description: 'x', run: () => ({ ok: true, result: '' }) };
  assert.throws(() => serverToolDefinition({ ...base, name: 'Post To Channel' }), /snake_case/);
  assert.throws(() => serverToolDefinition({ ...base, name: 'post', inputs: { [PASS_VARIABLE]: 'mine' } }), /can't be an input/);
  assert.throws(() => serverToolDefinition({ ...base, name: 'post', outputs: { result: 'mine' } }), /can't be an output/);
  assert.equal(serverToolDefinition({ ...base, name: 'post' }).version, 1);
  assert.equal(serverToolDefinition({ ...base, name: 'post', version: 3 }).version, 3);
});

test('installing server tools puts the pass variable and the tools URL on the agent, and no credential', async () => {
  const api = fakeVoiceflowApi({ project: { id: 'p1', name: 'Agent', workspaceID: 'w1' } });
  const set = serverToolSet('my-app', [recorder().tool]);
  const result = await installTools(set, {
    apiKey: 'k',
    fetch: api.fetch,
    projectID: 'p1',
    environment: 'development',
    record: memoryRecordStore(),
    secretValues: { [TOOLS_URL_SECRET]: 'https://app.example/api/tools' },
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    api.state.variables.map((v) => v.name),
    [PASS_VARIABLE],
  );
  assert.deepEqual(
    api.state.secrets.map((s) => [s.name, s.visibility]),
    [[TOOLS_URL_SECRET, 'restricted']],
  );
  assert.deepEqual([...new Set(api.state.secretValues.map((v) => v.value))], ['https://app.example/api/tools']);
  const [tool] = api.state.tools;
  const byName = Object.fromEntries(api.state.functionVariables.filter((v) => v.type === 'input').map((v) => [v.id, v.name]));
  const wiring = Object.fromEntries(Object.values(tool.inputVariables).map((i) => [byName[i.functionInputVariableID], i]));
  assert.equal(wiring.text.required, true, 'the model fills the text');
  assert.deepEqual([wiring[PASS_VARIABLE].defaultValue, wiring[PASS_VARIABLE].required], [`{${PASS_VARIABLE}}`, false]);
  assert.deepEqual([wiring[TOOLS_URL_SECRET].defaultValue, wiring[TOOLS_URL_SECRET].required], [`{${TOOLS_URL_SECRET}}`, false]);
});

test('an install says when a secret nothing reads any more is still on the project, and leaves it there', async () => {
  const api = fakeVoiceflowApi({ project: { id: 'p1', name: 'Agent', workspaceID: 'w1' } });
  api.state.secrets.push({ id: 'old', name: 'old_token', visibility: 'restricted', hasValue: true });
  const set = { ...serverToolSet('my-app', [recorder().tool]), retiredSecrets: { old_token: 'The tools held it before.', never_there: 'x' } };
  const options = { apiKey: 'k', fetch: api.fetch, projectID: 'p1', environment: 'development', record: memoryRecordStore() };
  const plan = await installTools(set, { ...options, dryRun: true });
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /old_token secret is still on Agent\. The tools held it before\. Delete it in Voiceflow/);
  await installTools(set, options);
  assert.ok(
    api.state.secrets.some((s) => s.name === 'old_token'),
    'still there',
  );
  assert.equal(api.writes().filter((c) => c.method === 'DELETE').length, 0);
});

test('a tool that called an API itself from Voiceflow, with a token, becomes a server tool on the next install: the token input goes', async () => {
  const api = fakeVoiceflowApi({ project: { id: 'p1', name: 'Agent', workspaceID: 'w1' } });
  const record = memoryRecordStore();
  const options = { apiKey: 'k', fetch: api.fetch, projectID: 'p1', environment: 'development', record };
  // As an earlier version installed it: the function holds the logic, and reads a token from a secret.
  const before = {
    channel: 'slack',
    variables: { slack_user_id: 'Who is asking.' },
    secrets: { slack_bot_token: 'The token.' },
    tools: [
      {
        name: 'note',
        kind: 'workspace',
        version: 1,
        description: 'Writes a note.',
        code: 'export default async function main(args) { return { outputVars: { ok: true }, next: { path: "success" } }; }\n',
        inputs: {
          text: { description: 'The note.' },
          token: { description: 'The token.', from: 'slack_bot_token' },
          user_id: { description: 'Who.', from: 'slack_user_id' },
        },
        outputs: { ok: 'Whether it worked.' },
      },
    ],
  };
  await installTools(before, { ...options, secretValues: { slack_bot_token: 'xoxb-old' } });

  const after = { ...serverToolSet('slack', [recorder({ version: 2 }).tool]), retiredSecrets: { slack_bot_token: 'The tools run on your server now.' } };
  const result = await installTools(after, { ...options, secretValues: { [TOOLS_URL_SECRET]: 'https://app.example/api/slack' } });
  assert.deepEqual(
    result.steps.filter((s) => s.kind === 'tool'),
    [{ kind: 'tool', name: 'note', action: 'update', from: 1, to: 2 }],
  );
  const [fn] = api.state.functions;
  assert.match(fn.code, /tool: 'note'/, 'the function is now the call to your server');
  const inputs = api.state.functionVariables.filter((v) => v.functionID === fn.id && v.type === 'input').map((v) => v.name);
  assert.deepEqual(inputs.sort(), [PASS_VARIABLE, TOOLS_URL_SECRET, 'text'].sort(), 'no token and no identity among its inputs');
  assert.doesNotMatch(JSON.stringify(api.state.tools[0].inputVariables), /slack_bot_token|slack_user_id/);
  assert.match(result.notes[0], /slack_bot_token secret is still on Agent/);
});
