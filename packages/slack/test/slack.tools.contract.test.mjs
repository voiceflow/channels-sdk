// Contract test for Slack's workspace tools end to end, through the real Chat
// SDK and Slack adapter: the agent's tool calls the server in the middle of a
// turn, as Voiceflow's function does, and the server acts in Slack with its
// own client. What leaves the conversation waits for a click Slack signed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels, PASS_VARIABLE, TOOL_CALL_HEADER } from '@voiceflow/channels-sdk';
import { fakeVoiceflow, waiter } from '@voiceflow/channels-sdk/testing';
import { slack as slackChannel } from '../dist/index.js';
import { BOT_TOKEN, SIGNING_SECRET, slackAction, slackEvent, startFakeSlack } from './helpers/fake-slack.mjs';

const ROOT = '1700000000.000100';
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });
const mention = (text) => ({
  type: 'app_mention',
  user: 'U2',
  team: 'T1',
  text: `<@UBOT> ${text}`,
  ts: ROOT,
  channel: 'C1',
  event_ts: ROOT,
  channel_type: 'channel',
});

/** A tool's call, as the agent's function sends it to the channel's own URL. */
function toolCall(pass, tool, input = {}) {
  return new Request('http://localhost/api/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TOOL_CALL_HEADER]: '1', ...(pass === undefined ? {} : { authorization: `Bearer ${pass}` }) },
    body: JSON.stringify({ tool, input }),
  });
}

/** `during(call)` runs inside each turn with a function that calls a tool through the Slack webhook route. */
async function setup(during, { extension = {}, ...options } = {}) {
  // Ada (U2) and the bot are both in C7; nobody has posted there lately.
  const slack = await startFakeSlack({
    answer: (method, body) =>
      method === 'conversations.members'
        ? { ok: true, members: body.channel === 'C7' ? ['U2', 'UBOT'] : ['UBOT'], response_metadata: { next_cursor: '' } }
        : method === 'conversations.history'
          ? { ok: true, messages: [] }
          : method === 'chat.getPermalink'
            ? { ok: true, permalink: `https://test.slack.com/archives/${body.channel}/p${String(body.message_ts).replace('.', '')}` }
            : undefined,
  });
  let channels;
  const vf = fakeVoiceflow(async (_action, turn) => {
    const pass = turn.variables[PASS_VARIABLE];
    const call = async (tool, input, options = {}) => {
      // `as: undefined` means no pass at all, so it isn't defaulted.
      const request = toolCall('as' in options ? options.as : pass, tool, input);
      const { route = 'webhook' } = options;
      const res = route === 'tools' ? await channels.tools(request) : await channels.webhook('slack', request);
      return { status: res.status, body: await res.json() };
    };
    await during?.(call, pass);
    return [say('On it.')];
  });
  channels = await createChannels({
    voiceflow: { apiKey: 'VF.TEST.key', projectID: 'proj1', environment: 'development', fetch: vf.fetch },
    channels: [slackChannel({ adapter: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, botUserId: 'UBOT', apiUrl: slack.apiUrl }, ...extension })],
    state: createMemoryState(),
    streaming: false,
    ...options,
  });
  const send = async (request) => {
    const w = waiter();
    const res = await channels.webhook('slack', request, w.options);
    await w.settle();
    return res;
  };
  return { slack, vf, channels, send };
}

/** A click on a button of the message `ts` in the thread, by `user`. */
const click = (ts, button, user) =>
  slackAction({
    type: 'block_actions',
    user: { id: user, name: 'person' },
    team: { id: 'T1' },
    api_app_id: 'A1',
    channel: { id: 'C1' },
    container: { type: 'message', channel_id: 'C1', message_ts: ts, thread_ts: ROOT },
    message: { ts, thread_ts: ROOT },
    trigger_id: 'trig',
    actions: [{ type: 'button', action_id: button.action_id, block_id: 'b', value: button.value, action_ts: '1' }],
  });

const buttonsOf = (post) => (post.body.blocks ?? []).flatMap((b) => b.elements ?? []).filter((e) => e.type === 'button');
const approvalPost = (slack) => slack.posts().find((p) => buttonsOf(p).some((b) => b.action_id === 'vfa:approve'));

test("the agent's tool call reaches the server mid-turn and acts in this conversation with the server's own Slack client", async (t) => {
  let answer;
  const { slack, send } = await setup(async (call) => {
    answer = await call('slack_pin_message', {});
  });
  t.after(slack.close);

  await send(slackEvent(mention('pin this')));
  assert.deepEqual(answer, { status: 200, body: { ok: true, result: 'Pinned in <#C1>.', outputs: {} } });
  // Where and what come from the turn Slack's signed event started, not from the call.
  assert.deepEqual(slack.of('pins.add')[0].body, { channel: 'C1', timestamp: ROOT });
  assert.equal(approvalPost(slack), undefined, 'in this conversation, nothing to approve');
});

test('a post in another channel waits for a click from the person who asked, which Slack signs', async (t) => {
  let answer;
  const { slack, vf, send } = await setup(async (call) => {
    answer = await call('slack_post_to_channel', { channel: 'C7', text: 'Release is Friday.' });
  });
  t.after(slack.close);
  const postsIn = (channel) => slack.posts().filter((p) => p.body.channel === channel);

  await send(slackEvent(mention('tell the team')));
  assert.equal(answer.body.ok, true);
  assert.match(answer.body.result, /asked the person to approve this first/);
  assert.equal(postsIn('C7').length, 0, 'nothing is posted yet');

  const card = approvalPost(slack);
  assert.ok(card, 'the request is posted in the thread');
  assert.equal(card.body.channel, 'C1');
  assert.equal(card.body.thread_ts, ROOT);
  assert.match(JSON.stringify(card.body.blocks), /Post this message\?/);
  assert.match(JSON.stringify(card.body.blocks), /Release is Friday\./);
  const approve = buttonsOf(card).find((b) => b.action_id === 'vfa:approve');
  const cardTs = card.answer.ts;

  // A click with a signature Slack didn't make.
  const forged = await send(
    slackAction(
      JSON.parse(
        await click(cardTs, approve, 'U2')
          .formData()
          .then((f) => f.get('payload')),
      ),
      { secret: 'not-the-signing-secret' },
    ),
  );
  assert.equal(forged.status, 401);
  // Someone else in the thread.
  await send(click(cardTs, approve, 'U3'));
  assert.equal(postsIn('C7').length, 0, 'neither of those posts it');

  await send(click(cardTs, approve, 'U2'));
  const [post] = postsIn('C7');
  assert.equal(post.body.text, 'Release is Friday.');
  assert.match(JSON.stringify(post.body.blocks), /Posted for <@U2>/);
  const update = slack.updates().findLast((u) => u.body.ts === cardTs);
  assert.ok(update, 'the request shows its outcome in place of the buttons');
  assert.match(JSON.stringify(update.body.blocks), /✓ Posted in <#C7>/);
  assert.equal(buttonsOf(update).length, 0);

  // A second click posts nothing more, and none of this was a turn for the agent.
  await send(click(cardTs, approve, 'U2'));
  assert.equal(postsIn('C7').length, 1);
  assert.equal(vf.interacts.length, 1);
});

test('requireApproval: false lets a tool act without asking; the membership check still holds', async (t) => {
  const answers = [];
  const { slack, send } = await setup(
    async (call) => {
      answers.push(await call('slack_post_to_channel', { channel: 'C7', text: 'No approval needed.' }));
      answers.push(await call('slack_post_to_channel', { channel: 'C8', text: 'Not a member.' }));
    },
    { requireApproval: { slack_post_to_channel: false } },
  );
  t.after(slack.close);
  await send(slackEvent(mention('post it')));
  assert.match(answers[0].body.result, /^Posted in <#C7>/);
  assert.equal(answers[1].body.ok, false);
  assert.match(answers[1].body.result, /you and I are both in/);
  assert.deepEqual(
    slack
      .posts()
      .map((p) => p.body.channel)
      .filter((c) => c !== 'C1'),
    ['C7'],
  );
  assert.equal(approvalPost(slack), undefined);
});

test("a tool call acts only with a pass this server made for a turn that's still running", async (t) => {
  const answers = {};
  let pass;
  const { slack, channels, send } = await setup(async (call, p) => {
    pass = p;
    answers.none = await call('slack_pin_message', {}, { as: undefined });
    answers.guess = await call('slack_pin_message', {}, { as: 'v1.e30.AAAA' });
    answers.unknown = await call('slack_delete_workspace', {});
    answers.ownRoute = await call('slack_pin_message', {}, { route: 'tools' });
  });
  t.after(slack.close);
  await send(slackEvent(mention('pin')));

  assert.equal(answers.none.status, 401);
  assert.equal(answers.guess.status, 401);
  assert.equal(answers.unknown.status, 404);
  assert.equal(answers.ownRoute.status, 200, 'channels.tools answers on a route of its own');
  assert.equal(slack.of('pins.add').length, 1, 'only the call with the pass pinned');

  // The turn is over: its pass is too.
  const late = await channels.webhook('slack', toolCall(pass, 'slack_pin_message', {}));
  assert.equal(late.status, 401);
  assert.equal(slack.of('pins.add').length, 1);

  // Without the tool-call mark it is just a request Slack didn't sign.
  const unmarked = toolCall(pass, 'slack_pin_message', {});
  unmarked.headers.delete(TOOL_CALL_HEADER);
  assert.equal((await channels.webhook('slack', unmarked)).status, 401);
});

test('with workspaceTools off, the server runs none of them', async (t) => {
  let pass;
  const { slack, vf, channels, send } = await setup(
    async (_call, p) => {
      pass = p;
    },
    { extension: { workspaceTools: false } },
  );
  t.after(slack.close);
  await send(slackEvent(mention('hello')));
  assert.equal(pass, undefined, 'no tools, so no pass');
  assert.equal(PASS_VARIABLE in vf.interacts[0].variables, false);
  assert.equal((await channels.tools(toolCall('v1.e30.AAAA', 'slack_pin_message', {}))).status, 401);
});

test('in a direct message with no thread, the request starts one, and its buttons still work', async (t) => {
  let answer;
  const { slack, send } = await setup(async (call) => {
    answer = await call('slack_post_to_channel', { channel: 'C7', text: 'From a DM.' });
  });
  t.after(slack.close);
  const ts = '1700000500.000100';
  await send(slackEvent({ type: 'message', user: 'U2', team: 'T1', text: 'post it', ts, channel: 'D1', event_ts: ts, channel_type: 'im' }));
  assert.match(answer.body.result, /asked the person to approve/);
  const card = approvalPost(slack);
  assert.equal(card.body.channel, 'D1');
  const approve = buttonsOf(card).find((b) => b.action_id === 'vfa:approve');
  const cardTs = card.answer.ts;
  // As Slack sends a click on a message that is in no thread: the message is the only place it names.
  const dmClick = (messageTs, user) =>
    slackAction({
      type: 'block_actions',
      user: { id: user, name: 'person' },
      team: { id: 'T1' },
      api_app_id: 'A1',
      channel: { id: 'D1' },
      container: { type: 'message', channel_id: 'D1', message_ts: messageTs },
      message: { ts: messageTs },
      trigger_id: 'trig',
      actions: [{ type: 'button', action_id: approve.action_id, block_id: 'b', value: approve.value, action_ts: '1' }],
    });
  const postsIn = (channel) => slack.posts().filter((p) => p.body.channel === channel);

  await send(dmClick(cardTs, 'U2'));
  assert.equal(postsIn('C7').length, 1);
  assert.equal(postsIn('C7')[0].body.text, 'From a DM.');
});

test('the request shows the whole message, quoted, in sections Slack takes', async (t) => {
  const text = `${'Thanks so much. '.repeat(250)}\nPS: one more thing.`;
  const { slack, send } = await setup(async (call) => {
    await call('slack_post_to_channel', { channel: 'C7', text });
  });
  t.after(slack.close);
  await send(slackEvent(mention('tell the team')));
  const card = approvalPost(slack);
  const sections = card.body.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
  assert.ok(sections.every((section) => section.length <= 3000));
  const shown = sections.join('\n');
  assert.ok(shown.includes('PS: one more thing.'), 'its end is there');
  assert.ok(shown.includes('<#C7>'), 'and where it goes');
});
