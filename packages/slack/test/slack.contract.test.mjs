// Contract test: the real Chat SDK and the real Slack adapter, loaded from the
// catalog, talking to a fake Slack Web API and a fake Voiceflow runtime.
// What makes Slack "supported": a real message is answered, a forged one is
// refused, a follow-up reaches the same Voiceflow session, buttons work, and
// a typed answer picks a choice.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels } from '@voiceflow/channels-sdk';
import { fakeVoiceflow, waiter } from '@voiceflow/channels-sdk/testing';
import { BOT_TOKEN, SIGNING_SECRET, slackAction, slackEvent, startFakeSlack } from './helpers/fake-slack.mjs';

async function setup(answer) {
  const slack = await startFakeSlack();
  const vf = fakeVoiceflow(answer);
  const channels = await createChannels({
    voiceflow: { apiKey: 'VF.TEST.key', projectID: 'proj1', environment: 'development', fetch: vf.fetch },
    channels: [{ slug: 'slack', options: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, botUserId: 'UBOT', apiUrl: slack.apiUrl } }],
    state: createMemoryState(),
    errorMessage: 'ERROR',
    // Replies posted whole. Streaming, and Slack's other native features, are in slack.native.contract.test.mjs.
    streaming: false,
  });
  const send = async (request) => {
    const w = waiter();
    const res = await channels.webhook('slack', request, w.options);
    await w.settle();
    return res;
  };
  return { slack, vf, channels, send };
}

const mention = (text, ts = '1700000000.000100') => ({
  type: 'app_mention',
  user: 'U2',
  text: `<@UBOT> ${text}`,
  ts,
  channel: 'C1',
  event_ts: ts,
  channel_type: 'channel',
});
const threadReply = (text, ts, thread_ts) => ({ type: 'message', user: 'U2', text, ts, thread_ts, channel: 'C1', event_ts: ts, channel_type: 'channel' });
// The Slack adapter posts markdown as `markdown_text`, and a card as blocks with a `text` fallback.
const said = (post) => post.body.markdown_text ?? post.body.text;
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });

test('a genuine mention is answered in its thread', async (t) => {
  const { slack, vf, send } = await setup((action) => [say(`You said: ${action.payload}`)]);
  t.after(slack.close);

  const res = await send(slackEvent(mention('hello')));
  assert.equal(res.status, 200);
  assert.equal(vf.interacts.length, 1);
  assert.deepEqual(vf.interacts[0].action, { type: 'text', payload: 'hello' });
  assert.equal(vf.sessions[0].userID, 'slack:C1:1700000000.000100');
  assert.equal(vf.sessions[0].authorization, 'Bearer VF.TEST.key');

  const [post] = slack.posts();
  assert.equal(post.body.channel, 'C1');
  assert.equal(post.body.thread_ts, '1700000000.000100');
  assert.match(said(post), /You said: hello/);
});

test('a forged signature is refused and reaches neither Voiceflow nor Slack', async (t) => {
  const { slack, vf, send } = await setup(() => [say('should not happen')]);
  t.after(slack.close);

  const res = await send(slackEvent(mention('hello'), { secret: 'not-the-signing-secret' }));
  assert.equal(res.status, 401);
  assert.equal(vf.interacts.length, 0);
  assert.equal(slack.posts().length, 0);
});

test('a follow-up in the thread reaches the same Voiceflow session', async (t) => {
  const { slack, vf, send } = await setup((action) => [say(`got ${action.payload}`)]);
  t.after(slack.close);

  await send(slackEvent(mention('first')));
  await send(slackEvent(threadReply('second', '1700000000.000200', '1700000000.000100')));

  assert.equal(vf.sessions.length, 1, 'one session for the whole thread');
  assert.deepEqual(
    vf.interacts.map((c) => [c.sessionKey, c.action.payload]),
    [
      ['sk-1', 'first'],
      ['sk-1', 'second'],
    ],
  );
  assert.match(said(slack.posts()[1]), /got second/);
  assert.equal(slack.posts()[1].body.thread_ts, '1700000000.000100');
});

test("buttons render as Block Kit and a click sends the button's Voiceflow request", async (t) => {
  const order = { type: 'path-order', payload: { label: 'Track order' } };
  const { slack, vf, send } = await setup((action) =>
    action.type === 'text'
      ? [say('What do you need?'), { type: 'choice', payload: { buttons: [{ name: 'Track order', request: order }, { name: 'Returns' }] } }]
      : [say(`picked ${action.type}`)],
  );
  t.after(slack.close);

  await send(slackEvent(mention('help')));
  const buttonsPost = slack.posts()[1];
  const elements = buttonsPost.body.blocks.flatMap((b) => b.elements ?? []);
  const track = elements.find((e) => e.type === 'button' && e.text?.text === 'Track order');
  assert.ok(track, 'a native Slack button');
  assert.match(track.action_id, /^vf:[a-z0-9]+:0$/);

  await send(
    slackAction({
      type: 'block_actions',
      user: { id: 'U2', name: 'person' },
      team: { id: 'T1' },
      api_app_id: 'A1',
      channel: { id: 'C1' },
      container: { type: 'message', channel_id: 'C1', message_ts: '1700000002.000100', thread_ts: '1700000000.000100' },
      message: { ts: '1700000002.000100', thread_ts: '1700000000.000100' },
      trigger_id: 'trig',
      actions: [{ type: 'button', action_id: track.action_id, block_id: 'b', value: track.value, action_ts: '1' }],
    }),
  );

  assert.deepEqual(vf.interacts.at(-1).action, order);
  assert.equal(vf.interacts.at(-1).sessionKey, 'sk-1');
  assert.match(said(slack.posts().at(-1)), /picked path-order/);
});

test('a click on a button from an earlier turn is answered as stale, not replayed', async (t) => {
  const { slack, vf, send } = await setup(() => [{ type: 'choice', payload: { buttons: [{ name: 'A' }] } }]);
  t.after(slack.close);

  await send(slackEvent(mention('one')));
  await send(
    slackAction({
      type: 'block_actions',
      user: { id: 'U2' },
      team: { id: 'T1' },
      channel: { id: 'C1' },
      container: { type: 'message', channel_id: 'C1', message_ts: '1700000001.000100', thread_ts: '1700000000.000100' },
      message: { ts: '1700000001.000100', thread_ts: '1700000000.000100' },
      trigger_id: 'trig',
      actions: [{ type: 'button', action_id: 'vf:oldnonce:0', block_id: 'b', value: '0', action_ts: '1' }],
    }),
  );
  assert.equal(vf.interacts.length, 1, 'no second turn');
  assert.match(said(slack.posts().at(-1)), /no longer available/);
});

test('a Voiceflow failure posts the error message instead of going silent', async (t) => {
  const { slack, send } = await setup(() => {
    throw new Error('runtime down');
  });
  t.after(slack.close);

  await send(slackEvent(mention('hello')));
  assert.match(said(slack.posts().at(-1)), /ERROR/);
});

test('a typed number in the thread picks the offered choice', async (t) => {
  const order = { type: 'path-order', payload: { label: 'Track order' } };
  const { slack, vf, send } = await setup((action) =>
    action.type === 'text' && action.payload === 'help'
      ? [{ type: 'choice', payload: { buttons: [{ name: 'Track order', request: order }, { name: 'Returns' }] } }]
      : [say(`picked ${action.type}`)],
  );
  t.after(slack.close);

  await send(slackEvent(mention('help')));
  await send(slackEvent(threadReply('1', '1700000000.000300', '1700000000.000100')));
  assert.deepEqual(vf.interacts.at(-1).action, order);
  assert.match(said(slack.posts().at(-1)), /picked path-order/);
});
