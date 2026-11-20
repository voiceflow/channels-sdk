// Contract test for Slack's native features, through the real Chat SDK and
// Slack adapter: replies streamed into one live message, a progress card per
// tool call, link buttons, feedback buttons, and the agent's launch turn
// pinned as suggested prompts when someone opens the assistant thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels } from '../dist/index.js';
import { BOT_TOKEN, SIGNING_SECRET, fakeVoiceflow, slackAction, slackEvent, startFakeSlack, waiter } from './helpers/fakes.mjs';

async function setup(answer, { slack: slackOptions = {}, ...options } = {}) {
  const slack = await startFakeSlack();
  const vf = fakeVoiceflow(answer);
  const channels = await createChannels({
    voiceflow: { apiKey: 'VF.TEST.key', projectID: 'proj1', environment: 'development', fetch: vf.fetch },
    channels: [{ slug: 'slack', options: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, botUserId: 'UBOT', apiUrl: slack.apiUrl, ...slackOptions } }],
    state: createMemoryState(),
    errorMessage: 'ERROR',
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

const ROOT = '1700000000.000100';
// Real message events carry the workspace; Slack streams natively only to a known recipient.
const mention = (text, ts = ROOT) => ({ type: 'app_mention', user: 'U2', team: 'T1', text: `<@UBOT> ${text}`, ts, channel: 'C1', event_ts: ts, channel_type: 'channel' });
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });
const completion = (id, ...parts) => [
  { type: 'completion', payload: { state: 'start', messageID: id } },
  ...parts.map((content) => ({ type: 'completion', payload: { state: 'content', content, messageID: id } })),
  { type: 'completion', payload: { state: 'end', messageID: id } },
];
const said = (post) => post.body.markdown_text ?? post.body.text;
const click = (actionId, value) => slackAction({
  type: 'block_actions', user: { id: 'U2', name: 'person', team_id: 'T1' }, team: { id: 'T1' }, api_app_id: 'A1',
  channel: { id: 'C1' }, container: { type: 'message', channel_id: 'C1', message_ts: '1700000002.000100', thread_ts: ROOT },
  message: { ts: '1700000002.000100', thread_ts: ROOT }, trigger_id: 'trig',
  actions: [{ type: 'button', action_id: actionId, block_id: 'b', value, action_ts: '1' }],
});

test('a streamed answer is written into one live Slack message', async (t) => {
  const { slack, vf, send } = await setup(() => completion('a1', 'Your order ', 'ships ', 'tomorrow.'));
  t.after(slack.close);

  await send(slackEvent(mention('where is my order?')));
  assert.equal(vf.interacts[0].stream, true);
  assert.equal(vf.interacts[0].config.completionEvents, true);

  const [stream] = slack.streams();
  assert.ok(stream, 'a native Slack stream');
  assert.equal(stream.start.thread_ts, ROOT);
  assert.equal(stream.start.recipient_user_id, 'U2');
  assert.equal(stream.text, 'Your order ships tomorrow.');
  assert.ok(stream.stopped, 'the stream is closed when the turn ends');
  assert.equal(slack.posts().filter((p) => said(p)?.includes('ships')).length, 0, 'not posted a second time');
});

test('each tool call shows a progress card that completes', async (t) => {
  const { slack, send } = await setup(() => [
    { type: 'tool-call', payload: { callID: 'c1', state: 'start' } },
    { type: 'tool-call', payload: { callID: 'c1', state: 'end' } },
    ...completion('a1', 'Found it.'),
  ]);
  t.after(slack.close);

  await send(slackEvent(mention('look it up')));
  const [stream] = slack.streams();
  assert.deepEqual(
    stream.tasks.filter((task) => task.id === 'c1').map((task) => [task.title, task.status]),
    [['Working on it', 'in_progress'], ['Working on it', 'complete']],
  );
  assert.equal(stream.text, 'Found it.');
});

test('buttons after a streamed answer close the stream, then post below it', async (t) => {
  const { slack, send } = await setup(() => [
    ...completion('a1', 'Pick one:'),
    { type: 'choice', payload: { buttons: [{ name: 'Track order' }, { name: 'Returns' }] } },
  ]);
  t.after(slack.close);

  await send(slackEvent(mention('help')));
  const stop = slack.calls.findIndex((c) => c.method === 'chat.stopStream');
  const buttons = slack.calls.findIndex((c) => c.method === 'chat.postMessage' && c.body.blocks?.some((b) => b.type === 'actions'));
  assert.ok(stop !== -1 && buttons !== -1 && stop < buttons, 'stream stopped before the buttons were posted');
});

test('a URL button opens its link and still sends its Voiceflow request', async (t) => {
  const book = { type: 'path-book', payload: { label: 'Book a table', actions: [{ type: 'open_url', payload: { url: 'https://example.com/book' } }] } };
  const { slack, vf, send } = await setup((action) =>
    action.type === 'text' ? [{ type: 'choice', payload: { buttons: [{ name: 'Book a table', request: book }] } }] : [say(`picked ${action.type}`)],
    { streaming: false },
  );
  t.after(slack.close);

  await send(slackEvent(mention('book')));
  const button = slack.posts()[0].body.blocks.flatMap((b) => b.elements ?? []).find((e) => e.type === 'button');
  assert.equal(button.url, 'https://example.com/book');
  assert.match(button.action_id, /^vf:[a-z0-9]+:0$/);

  await send(click(button.action_id));
  assert.deepEqual(vf.interacts.at(-1).action, book);
});

test('feedback buttons close a streamed answer, and a rating reaches onFeedback without a turn', async (t) => {
  const ratings = [];
  const { slack, vf, send } = await setup(() => completion('a1', 'Done.'), {
    slack: { feedbackButtons: true },
    onFeedback: (f) => ratings.push({ positive: f.positive, value: f.value, user: f.user.userId }),
  });
  t.after(slack.close);

  await send(slackEvent(mention('do it')));
  const [stream] = slack.streams();
  const feedback = stream.blocks.flatMap((b) => b.elements ?? []).find((e) => e.type === 'feedback_buttons');
  assert.ok(feedback, 'Slack feedback buttons on the streamed reply');

  await send(click(feedback.action_id, 'positive'));
  assert.deepEqual(ratings, [{ positive: true, value: 'positive', user: 'U2' }]);
  assert.equal(vf.interacts.length, 1, 'a rating is not a turn');
});

test("opening the assistant thread runs the launch turn and pins its buttons as suggested prompts", async (t) => {
  const order = { type: 'path-order', payload: { label: 'Track order' } };
  const { slack, vf, send } = await setup((action) =>
    action.type === 'launch'
      ? [say('Hi! How can I help?'), { type: 'choice', payload: { buttons: [{ name: 'Track order', request: order }, { name: 'Returns' }] } }]
      : [say(`picked ${action.type}`)],
  );
  t.after(slack.close);

  const opened = '1700000100.000100';
  await send(slackEvent({
    type: 'assistant_thread_started', event_ts: opened,
    assistant_thread: { user_id: 'U2', channel_id: 'D1', thread_ts: opened, context: { team_id: 'T1' } },
  }));
  assert.deepEqual(vf.interacts[0].action, { type: 'launch' });
  assert.match(slack.streams()[0]?.text ?? '', /How can I help/);

  const pinned = slack.calls.find((c) => c.method === 'assistant.threads.setSuggestedPrompts');
  assert.ok(pinned, 'prompts pinned');
  assert.equal(pinned.body.channel_id, 'D1');
  assert.equal(pinned.body.thread_ts, opened);
  assert.deepEqual(pinned.body.prompts, [{ title: 'Track order', message: 'Track order' }, { title: 'Returns', message: 'Returns' }]);
  assert.equal(slack.posts().filter((p) => p.body.blocks?.some((b) => b.type === 'actions')).length, 0, 'not also posted as buttons');

  // Clicking a prompt sends its text, which picks the button and sends its request.
  await send(slackEvent({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', team: 'T1', text: 'Track order', ts: '1700000101.000100', thread_ts: opened, event_ts: '1700000101.000100' }));
  assert.deepEqual(vf.interacts.at(-1).action, order);
  assert.equal(vf.sessions.length, 1, 'the launch session carries on');
});
