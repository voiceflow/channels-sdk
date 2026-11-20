// Contract test for what slack() adds by default, through the real Chat SDK
// and Slack adapter: who and where reach the agent as variables, a working
// reaction, catching up on a thread, the assistant panel's titles and context,
// reactions as feedback, menus for long lists, slash commands and App Home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels } from '@voiceflow/channels-sdk';
import { fakeVoiceflow, waiter } from '@voiceflow/channels-sdk/testing';
import { slack as slackChannel, DEFAULT_HOME_TEXT } from '../dist/index.js';
import { BOT_TOKEN, SIGNING_SECRET, slackAction, slackCommand, slackEvent, startFakeSlack } from './helpers/fake-slack.mjs';

async function setup(answer, { extension = {}, fake = {}, ...options } = {}) {
  const slack = await startFakeSlack(fake);
  const vf = fakeVoiceflow(answer);
  const channels = await createChannels({
    voiceflow: { apiKey: 'VF.TEST.key', projectID: 'proj1', environment: 'development', fetch: vf.fetch },
    channels: [slackChannel({ adapter: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, botUserId: 'UBOT', apiUrl: slack.apiUrl }, ...extension })],
    state: createMemoryState(),
    errorMessage: 'ERROR',
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

const ROOT = '1700000000.000100';
const mention = (text, ts = ROOT, extra = {}) => ({ type: 'app_mention', user: 'U2', team: 'T1', text: `<@UBOT> ${text}`, ts, channel: 'C1', event_ts: ts, channel_type: 'channel', ...extra });
const threadReply = (text, ts) => ({ type: 'message', user: 'U2', team: 'T1', text, ts, thread_ts: ROOT, channel: 'C1', event_ts: ts, channel_type: 'channel' });
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });
const said = (post) => post.body.markdown_text ?? post.body.text;

test('who and where reach the agent as slack_* variables on every turn', async (t) => {
  const { slack, vf, send } = await setup(() => [say('Hi')]);
  t.after(slack.close);

  await send(slackEvent(mention('hello')));
  assert.deepEqual(vf.interacts[0].variables, {
    slack_user_id: 'U2',
    slack_user_name: 'A Person',
    slack_user_title: 'Head of Support',
    slack_user_timezone: 'America/Toronto',
    slack_user_email: 'person@example.com',
    slack_team_id: 'T1',
    slack_channel_id: 'C1',
    slack_channel_name: 'general',
    slack_channel_type: 'channel',
    slack_thread_ts: ROOT,
    slack_message_ts: ROOT,
    slack_viewing_channel_id: '',
  });
});

test('the agent\'s own variables win over the context, and context: false sets none', async (t) => {
  const { slack, vf, send } = await setup(() => [say('Hi')], { variables: () => ({ slack_user_name: 'Override', plan: 'pro' }) });
  t.after(slack.close);
  await send(slackEvent(mention('hello')));
  assert.equal(vf.interacts[0].variables.slack_user_name, 'Override');
  assert.equal(vf.interacts[0].variables.plan, 'pro');

  const off = await setup(() => [say('Hi')], { extension: { context: false } });
  t.after(off.slack.close);
  await off.send(slackEvent(mention('hello')));
  assert.deepEqual(off.vf.interacts[0].variables, {});
});

test('👀 shows on the person\'s message while the agent works, and comes off when it answers', async (t) => {
  const { slack, send } = await setup(() => [say('Done')]);
  t.after(slack.close);

  await send(slackEvent(mention('hello')));
  const methods = slack.calls.map((c) => c.method);
  const added = methods.indexOf('reactions.add');
  const posted = methods.indexOf('chat.postMessage');
  const removed = methods.indexOf('reactions.remove');
  assert.ok(added !== -1 && added < posted && posted < removed, `order: ${methods.join(', ')}`);
  assert.deepEqual(
    slack.of('reactions.add').map((c) => [c.body.name, c.body.timestamp, c.body.channel]),
    [['eyes', ROOT, 'C1']],
  );
  assert.deepEqual(slack.of('reactions.remove').map((c) => [c.body.name, c.body.timestamp]), [['eyes', ROOT]]);
});

test('a done reaction can be left, and the working one turned off', async (t) => {
  const { slack, send } = await setup(() => [say('Done')], { extension: { workingReaction: null, doneReaction: 'white_check_mark' } });
  t.after(slack.close);
  await send(slackEvent(mention('hello')));
  assert.deepEqual(slack.of('reactions.add').map((c) => c.body.name), []);

  const done = await setup(() => [say('Done')], { extension: { doneReaction: 'white_check_mark' } });
  t.after(done.slack.close);
  await done.send(slackEvent(mention('hello')));
  assert.deepEqual(done.slack.of('reactions.add').map((c) => c.body.name), ['eyes', 'white_check_mark']);
});

test('mentioned partway through a thread, the agent reads what came before', async (t) => {
  const later = '1700000000.000400';
  const { slack, vf, send } = await setup(() => [say('Got it')], {
    fake: {
      replies: () => [
        { type: 'message', user: 'U3', text: 'The checkout page is down for EU customers', ts: ROOT, thread_ts: ROOT },
        { type: 'message', user: 'U4', text: 'Since about 9am', ts: '1700000000.000200', thread_ts: ROOT },
        { type: 'message', user: 'UBOT', bot_id: 'BBOT', text: 'Earlier answer', ts: '1700000000.000300', thread_ts: ROOT },
        { type: 'message', user: 'U2', text: '<@UBOT> can you open an incident?', ts: later, thread_ts: ROOT },
      ],
    },
  });
  t.after(slack.close);

  await send(slackEvent({ ...mention('can you open an incident?', later), thread_ts: ROOT }));
  const payload = vf.interacts[0].action.payload;
  assert.match(payload, /^Earlier in this Slack thread:\n/);
  assert.match(payload, /: The checkout page is down for EU customers\n.*: Since about 9am\nAssistant: Earlier answer\n/);
  assert.match(payload, /\n\nThe message to answer:\ncan you open an incident\?$/);
  assert.equal((payload.match(/open an incident/g) ?? []).length, 1, 'the message itself is not repeated');

  // The conversation carries on from there: no second catch-up.
  await send(slackEvent(threadReply('thanks', '1700000000.000500')));
  assert.deepEqual(vf.interacts[1].action, { type: 'text', payload: 'thanks' });
});

test('a mention that starts its own thread reads nothing before it', async (t) => {
  const { slack, vf, send } = await setup(() => [say('Hi')], { fake: { replies: () => [{ user: 'U3', text: 'should not appear', ts: '1' }] } });
  t.after(slack.close);
  await send(slackEvent(mention('hello')));
  assert.deepEqual(vf.interacts[0].action, { type: 'text', payload: 'hello' });
  assert.equal(slack.of('conversations.replies').length, 0);
});

test('the assistant panel: no 👀, the thread is named after the first message, and the open channel reaches the agent', async (t) => {
  const { slack, vf, send } = await setup((action) => (action.type === 'launch' ? [say('Hi!')] : [say('Sure.')]));
  t.after(slack.close);

  const opened = '1700000100.000100';
  await send(slackEvent({
    type: 'assistant_thread_started', event_ts: opened,
    assistant_thread: { user_id: 'U2', channel_id: 'D1', thread_ts: opened, context: { channel_id: 'C9', team_id: 'T1' } },
  }));
  assert.deepEqual(vf.interacts[0].action, { type: 'launch' });
  assert.equal(vf.interacts[0].variables.slack_user_id, 'U2');
  assert.equal(vf.interacts[0].variables.slack_viewing_channel_id, 'C9');

  const ask = (text, ts) => slackEvent({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', team: 'T1', text, ts, thread_ts: opened, event_ts: ts });
  await send(ask('What changed in our refund policy this quarter for annual plans?', '1700000101.000100'));
  await send(ask('And for monthly?', '1700000102.000100'));

  const titles = slack.of('assistant.threads.setTitle');
  assert.equal(titles.length, 1, 'named once');
  assert.equal(titles[0].body.thread_ts, opened);
  assert.ok(titles[0].body.title.length <= 60);
  assert.equal(titles[0].body.title, 'What changed in our refund policy this quarter for annual…');
  assert.equal(slack.of('reactions.add').length, 0, 'the panel shows its own status');
  assert.equal(vf.interacts.at(-1).variables.slack_viewing_channel_id, 'C9');
});

test('a 👍 or 👎 on the agent\'s message is feedback; other reactions reach onReaction only', async (t) => {
  const ratings = [];
  const reactions = [];
  const { slack, vf, send } = await setup(() => [say('Hi')], {
    onFeedback: (f) => ratings.push([f.positive, f.value, f.via, f.messageId, f.user.userId]),
    extension: { onReaction: (e) => reactions.push([e.rawEmoji, e.added, e.user.userId]) },
  });
  t.after(slack.close);

  const reaction = (reaction, item_user, user = 'U2', type = 'reaction_added') => slackEvent({
    type, user, reaction, item_user, event_ts: '1700000200.000100',
    item: { type: 'message', channel: 'C1', ts: '1700000001.000100' },
  });
  await send(reaction('+1', 'UBOT'));
  await send(reaction('-1::skin-tone-3', 'UBOT'));
  await send(reaction('tada', 'UBOT'));
  await send(reaction('+1', 'U3'));
  await send(reaction('eyes', 'U2', 'UBOT'));
  await send(reaction('+1', 'UBOT', 'U2', 'reaction_removed'));

  assert.deepEqual(ratings, [
    [true, '+1', 'reaction', '1700000001.000100', 'U2'],
    [false, '-1', 'reaction', '1700000001.000100', 'U2'],
  ]);
  assert.deepEqual(reactions, [['+1', true, 'U2'], ['-1::skin-tone-3', true, 'U2'], ['tada', true, 'U2'], ['+1', true, 'U2'], ['+1', false, 'U2']], 'the bot\'s own reactions are not reported');
  assert.equal(vf.interacts.length, 0, 'a reaction is not a turn');
});

test('more than five choices become one menu, and picking an option sends its request', async (t) => {
  const labels = ['Billing', 'Shipping', 'Returns', 'Warranty', 'Accounts', 'Orders', 'Other'];
  const { slack, vf, send } = await setup((action) =>
    action.type === 'text' && action.payload === 'help'
      ? [{ type: 'choice', payload: { buttons: labels.map((name) => ({ name, request: { type: `path-${name.toLowerCase()}` } })) } }]
      : [say(`picked ${action.type}`)],
  );
  t.after(slack.close);

  await send(slackEvent(mention('help')));
  const post = slack.posts()[0];
  const select = post.body.blocks.flatMap((b) => b.elements ?? (b.accessory ? [b.accessory] : [])).find((e) => e.type === 'static_select');
  assert.ok(select, 'a Slack menu');
  assert.deepEqual(select.options.map((o) => o.text.text), labels);
  assert.ok(!post.body.blocks.some((b) => b.elements?.some((e) => e.type === 'button')), 'no buttons');

  await send(slackAction({
    type: 'block_actions', user: { id: 'U2', name: 'person', team_id: 'T1' }, team: { id: 'T1' }, api_app_id: 'A1',
    channel: { id: 'C1' }, container: { type: 'message', channel_id: 'C1', message_ts: post.answer.ts, thread_ts: ROOT },
    message: { ts: post.answer.ts, thread_ts: ROOT }, trigger_id: 'trig',
    actions: [{ type: 'static_select', action_id: select.action_id, block_id: 'b', selected_option: { text: { type: 'plain_text', text: 'Orders' }, value: select.options[5].value }, action_ts: '1' }],
  }));
  assert.deepEqual(vf.interacts.at(-1).action, { type: 'path-orders' });
  assert.match(JSON.stringify(slack.updates().at(-1).body.blocks), /✓ Orders/, 'the menu comes off, with the pick marked');
});

test('a slash command posts the question in the channel and answers in its thread', async (t) => {
  const { slack, vf, send } = await setup((action) => [say(`About ${action.payload}`)]);
  t.after(slack.close);

  const res = await send(slackCommand({ command: '/ask', text: 'our refund policy', user_id: 'U2', user_name: 'person', channel_id: 'C1', response_url: `${slack.apiUrl}response` }));
  assert.equal(res.status, 200);
  const [question, answer] = slack.posts();
  assert.equal(said(question), '<@U2> asked: our refund policy');
  assert.equal(question.body.thread_ts, undefined, 'the question starts a thread');
  assert.equal(answer.body.thread_ts, question.answer.ts, 'the answer is in its thread');
  assert.match(said(answer), /About our refund policy/);
  assert.equal(vf.interacts[0].variables.slack_user_id, 'U2');

  await send(slackCommand({ command: '/ask', text: '  ', user_id: 'U2', channel_id: 'C1', response_url: `${slack.apiUrl}response` }));
  const usage = slack.of('response').at(-1);
  assert.equal(usage.body.response_type, 'ephemeral');
  assert.match(usage.body.text, /\/ask what's our refund policy\?/);
  assert.equal(vf.interacts.length, 1, 'no turn without a question');
});

test('opening App Home shows how to reach the agent', async (t) => {
  const { slack, send } = await setup(() => []);
  t.after(slack.close);
  await send(slackEvent({ type: 'app_home_opened', user: 'U2', channel: 'D1', tab: 'home', event_ts: '1700000300.000100' }));
  const [publish] = slack.of('views.publish');
  assert.equal(publish.body.user_id, 'U2');
  assert.equal(publish.body.view.type, 'home');
  assert.equal(publish.body.view.blocks[0].text.text, DEFAULT_HOME_TEXT);

  await send(slackEvent({ type: 'app_home_opened', user: 'U2', channel: 'D1', tab: 'messages', event_ts: '1700000301.000100' }));
  assert.equal(slack.of('views.publish').length, 1, 'only the Home tab');
});
