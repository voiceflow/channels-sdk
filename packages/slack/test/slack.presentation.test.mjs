// Slack's presentation tools: each function, run as Voiceflow's sandbox runs it,
// and each trace it returns, shown in Slack through the real Chat SDK and Slack
// adapter.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels } from '@voiceflow/channelkit';
import { fakeVoiceflow, runFunction, waiter } from '@voiceflow/channelkit/testing';
import { answersText, PRESENTATION_TRACES, presentationTools, slack as slackChannel, slackTools } from '../dist/index.js';
import { BOT_TOKEN, SIGNING_SECRET, slackAction, slackEvent, startFakeSlack } from './helpers/fake-slack.mjs';

const tool = (name) => presentationTools.find((t) => t.name === name);
const run = (name, inputs) => runFunction(tool(name).code, inputs);

// ── The functions ───────────────────────────────────────────────────────────

test('every presentation tool returns only primitive outputs, whatever the model gives it', async () => {
  for (const t of presentationTools) {
    for (const inputs of [
      {},
      Object.fromEntries(Object.keys(t.inputs).map((k) => [k, ''])),
      Object.fromEntries(Object.keys(t.inputs).map((k) => [k, 'nonsense {'])),
    ]) {
      const out = await run(t.name, inputs);
      for (const [k, v] of Object.entries(out.outputVars ?? {})) assert.ok(['string', 'number', 'boolean'].includes(typeof v), `${t.name}.${k} is ${typeof v}`);
      assert.ok(['success', 'error'].includes(out.next?.path), `${t.name} takes a declared path`);
    }
  }
  assert.deepEqual(
    presentationTools.map((t) => t.name),
    [...PRESENTATION_TRACES],
  );
  assert.ok(
    presentationTools.every((t) => !Object.values(t.inputs).some((i) => i.from)),
    'presentation tools read nothing but what the model gives',
  );
});

test('slack_react takes an emoji name, with or without colons', async () => {
  assert.deepEqual((await run('slack_react', { emoji: ':Tada:' })).trace, [{ type: 'slack_react', payload: { emoji: 'tada' } }]);
  assert.deepEqual((await run('slack_react', { emoji: '+1::skin-tone-3' })).trace, [{ type: 'slack_react', payload: { emoji: '+1::skin-tone-3' } }]);
  const bad = await run('slack_react', { emoji: 'a party!' });
  assert.equal(bad.next.path, 'error');
  assert.equal(bad.trace, undefined);
});

test("slack_show_table takes objects, headers and rows, or CSV, and keeps to Slack's limits", async () => {
  const objects = await run('slack_show_table', {
    title: 'Orders',
    data: JSON.stringify([
      { id: 1, total: 9.5 },
      { id: 2, note: 'gift' },
    ]),
  });
  assert.deepEqual(objects.trace[0].payload, {
    title: 'Orders',
    headers: ['id', 'total', 'note'],
    rows: [
      ['1', '9.5', ''],
      ['2', '', 'gift'],
    ],
  });

  const shaped = await run('slack_show_table', { data: { headers: ['a', 'b'], rows: [[1, null]] } });
  assert.deepEqual(shaped.trace[0].payload.rows, [['1', '']]);

  const csv = await run('slack_show_table', { data: 'name,quote\nAda,"Hello, ""world"""\nGrace,Hi' });
  assert.deepEqual(csv.trace[0].payload, {
    title: '',
    headers: ['name', 'quote'],
    rows: [
      ['Ada', 'Hello, "world"'],
      ['Grace', 'Hi'],
    ],
  });

  const big = await run('slack_show_table', { data: JSON.stringify(Array.from({ length: 150 }, (_, i) => ({ n: i }))) });
  assert.equal(big.trace[0].payload.rows.length, 100);
  assert.match(big.outputVars.result, /only the first 100 of 150 rows fit/);

  const broken = await run('slack_show_table', { data: '[{"a": 1' });
  assert.equal(broken.next.path, 'error');
  assert.match(broken.outputVars.result, /isn't valid JSON/);
});

test("slack_show_chart takes rows, series or pie values, and keeps to Slack's limits", async () => {
  const rows = await run('slack_show_chart', {
    title: 'Revenue',
    chart_type: 'bar',
    data: '[{"month":"Jan","revenue":120,"cost":"$80"},{"month":"Feb","revenue":140,"cost":90}]',
    y_label: 'USD',
  });
  assert.deepEqual(rows.trace[0].payload, {
    title: 'Revenue',
    chart: {
      type: 'bar',
      categories: ['Jan', 'Feb'],
      series: [
        {
          name: 'revenue',
          data: [
            { label: 'Jan', value: 120 },
            { label: 'Feb', value: 140 },
          ],
        },
        {
          name: 'cost',
          data: [
            { label: 'Jan', value: 80 },
            { label: 'Feb', value: 90 },
          ],
        },
      ],
      yLabel: 'USD',
    },
  });
  const pie = await run('slack_show_chart', { title: 'Plans', chart_type: 'pie', data: { 'A very long plan name indeed': 3, Free: 0, Pro: 5 } });
  assert.deepEqual(pie.trace[0].payload.chart, {
    type: 'pie',
    segments: [
      { label: 'A very long plan na…', value: 3 },
      { label: 'Pro', value: 5 },
    ],
  });
  assert.equal((await run('slack_show_chart', { chart_type: 'radar', data: '{}' })).next.path, 'error');
  assert.equal((await run('slack_show_chart', { chart_type: 'line', data: '{"categories":["a"],"series":[{"name":"x","data":["n/a"]}]}' })).next.path, 'error');
});

test('slack_reply_privately needs text', async () => {
  assert.deepEqual((await run('slack_reply_privately', { text: ' Your code is 1234 ' })).trace, [
    { type: 'slack_reply_privately', payload: { text: 'Your code is 1234' } },
  ]);
  assert.equal((await run('slack_reply_privately', { text: '  ' })).next.path, 'error');
});

test('slack_ask_form shapes the fields for a Slack dialog and refuses what Slack would', async () => {
  const out = await run('slack_ask_form', {
    title: 'Time off request for next quarter',
    intro: 'Book your leave.',
    fields: JSON.stringify([
      { label: 'Start date', type: 'date' },
      { name: 'Days', type: 'number' },
      { label: 'Kind', type: 'radio', options: ['Vacation', 'Sick'] },
      { label: 'Notes', type: 'long_text', optional: true },
      { label: 'Odd', type: 'spreadsheet' },
    ]),
  });
  assert.deepEqual(out.trace[0].payload, {
    title: 'Time off request for ne…',
    intro: 'Book your leave.',
    fields: [
      { name: 'start_date', label: 'Start date', type: 'date', optional: false },
      { name: 'days', label: 'Days', type: 'number', optional: false },
      { name: 'kind', label: 'Kind', type: 'radio', optional: false, options: ['Vacation', 'Sick'] },
      { name: 'notes', label: 'Notes', type: 'long_text', optional: true },
      { name: 'odd', label: 'Odd', type: 'text', optional: false },
    ],
  });
  assert.match((await run('slack_ask_form', { fields: '[{"label":"Pick","type":"select"}]' })).outputVars.result, /Pick needs options/);
  assert.match((await run('slack_ask_form', { fields: '[{"label":"A"},{"label":"a"}]' })).outputVars.result, /Two fields are named a/);
  assert.match(
    (await run('slack_ask_form', { fields: JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ label: `F${i}` }))) })).outputVars.result,
    /at most 20/,
  );
});

test('the default install carries the presentation tools and the context variables they sit beside', () => {
  const set = slackTools();
  assert.equal(set.channel, 'slack');
  assert.ok(PRESENTATION_TRACES.every((n) => set.tools.some((t) => t.name === n)));
  assert.ok('slack_user_id' in set.variables);
});

// ── In Slack ────────────────────────────────────────────────────────────────

async function setup(answer, { extension = {}, fake = {} } = {}) {
  const slack = await startFakeSlack(fake);
  const vf = fakeVoiceflow(answer);
  const channels = await createChannels({
    voiceflow: { apiKey: 'VF.TEST.key', projectID: 'proj1', environment: 'development', fetch: vf.fetch },
    channels: [slackChannel({ adapter: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, botUserId: 'UBOT', apiUrl: slack.apiUrl }, ...extension })],
    state: createMemoryState(),
    errorMessage: 'ERROR',
    streaming: false,
  });
  const send = async (request) => {
    const w = waiter();
    const res = await channels.webhook('slack', request, w.options);
    await w.settle();
    return res;
  };
  return { slack, vf, send };
}

const ROOT = '1700000000.000100';
const mention = (text, extra = {}) => ({
  type: 'app_mention',
  user: 'U2',
  team: 'T1',
  text: `<@UBOT> ${text}`,
  ts: ROOT,
  channel: 'C1',
  event_ts: ROOT,
  channel_type: 'channel',
  ...extra,
});
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });
const said = (post) => post.body.markdown_text ?? post.body.text;
/** What the function would have returned, as the runtime passes it on. */
const traceOf = async (name, inputs) => (await run(name, inputs)).trace[0];

test("slack_react reacts to the person's message, and an 👀 the agent chose stays on", async (t) => {
  const tada = await traceOf('slack_react', { emoji: 'tada' });
  const { slack, send } = await setup(() => [say('Congrats!'), tada]);
  t.after(slack.close);
  await send(slackEvent(mention('we shipped')));
  const reactions = slack.calls.filter((c) => c.method.startsWith('reactions.')).map((c) => `${c.method} ${c.body.name} ${c.body.timestamp}`);
  assert.deepEqual(reactions, [`reactions.add eyes ${ROOT}`, `reactions.add tada ${ROOT}`, `reactions.remove eyes ${ROOT}`]);

  const eyes = await traceOf('slack_react', { emoji: 'eyes' });
  const kept = await setup(() => [eyes, say('Looking into it.')]);
  t.after(kept.slack.close);
  await kept.send(slackEvent(mention('can you check?')));
  assert.equal(kept.slack.of('reactions.remove').length, 0, "the agent's own 👀 is not taken off");
});

test('slack_show_table posts a native table below the words before it', async (t) => {
  const table = await traceOf('slack_show_table', { title: 'Orders', data: '[{"id":"A1","total":"$20"},{"id":"A2","total":"$35"}]' });
  const { slack, send } = await setup(() => [say('Here are your orders.'), table]);
  t.after(slack.close);
  await send(slackEvent(mention('my orders')));
  const [words, posted] = slack.posts();
  assert.equal(said(words), 'Here are your orders.');
  const block = posted.body.blocks.find((b) => b.type === 'data_table');
  assert.ok(block, 'a native data table');
  assert.equal(block.caption, 'Orders');
  assert.deepEqual(
    block.rows.map((r) => r.map((c) => c.text)),
    [
      ['id', 'total'],
      ['A1', '$20'],
      ['A2', '$35'],
    ],
  );
});

test('slack_show_chart posts a native chart', async (t) => {
  const chart = await traceOf('slack_show_chart', {
    title: 'Tickets',
    chart_type: 'line',
    data: '{"categories":["Mon","Tue"],"series":[{"name":"Open","data":[4,7]}]}',
  });
  const { slack, send } = await setup(() => [chart]);
  t.after(slack.close);
  await send(slackEvent(mention('ticket trend')));
  const [posted] = slack.posts();
  const block = posted.body.blocks.find((b) => b.type === 'data_visualization');
  assert.ok(block, 'a native chart, not its text form');
  assert.match(JSON.stringify(block), /Tickets/);
});

test('slack_reply_privately sends an ephemeral message in a channel, and a normal one in a DM', async (t) => {
  const secret = await traceOf('slack_reply_privately', { text: 'Your reset code is 1234.' });
  const { slack, send } = await setup(() => [say('I sent it to you privately.'), secret]);
  t.after(slack.close);
  await send(slackEvent(mention('my reset code')));
  const [ephemeral] = slack.of('chat.postEphemeral');
  assert.equal(ephemeral.body.user, 'U2');
  assert.equal(ephemeral.body.channel, 'C1');
  assert.equal(ephemeral.body.thread_ts, ROOT);
  assert.match(ephemeral.body.text ?? JSON.stringify(ephemeral.body.blocks), /1234/);
  assert.ok(!slack.posts().some((p) => /1234/.test(JSON.stringify(p.body))), 'never posted where others can see it');

  const dm = await setup(() => [secret]);
  t.after(dm.slack.close);
  await dm.send(slackEvent({ type: 'message', user: 'U2', team: 'T1', text: 'my reset code', ts: ROOT, channel: 'D1', event_ts: ROOT, channel_type: 'im' }));
  assert.equal(dm.slack.of('chat.postEphemeral').length, 0);
  assert.match(said(dm.slack.posts()[0]), /1234/);
});

test("slack_ask_form: a button opens a Slack dialog, and its answers are the person's next message", async (t) => {
  const form = await traceOf('slack_ask_form', {
    title: 'Time off',
    intro: 'Book your leave.',
    fields:
      '[{"label":"Start date","type":"date"},{"label":"Days","type":"number"},{"label":"Kind","type":"select","options":["Vacation","Sick"]},{"label":"Notes","type":"long_text","optional":true}]',
  });
  const { slack, vf, send } = await setup((action) =>
    action.type === 'text' && /^Filled in/.test(action.payload) ? [say('Booked.')] : [say('Fill this in:'), form],
  );
  t.after(slack.close);
  await send(slackEvent(mention('book time off')));

  const card = slack.posts().at(-1);
  const button = card.body.blocks.flatMap((b) => b.elements ?? []).find((e) => e.type === 'button');
  assert.equal(button.text.text, 'Open form');
  const click = (user) =>
    send(
      slackAction({
        type: 'block_actions',
        user: { id: user, name: user, team_id: 'T1' },
        team: { id: 'T1' },
        api_app_id: 'A1',
        channel: { id: 'C1' },
        container: { type: 'message', channel_id: 'C1', message_ts: card.answer.ts, thread_ts: ROOT },
        message: { ts: card.answer.ts, thread_ts: ROOT },
        trigger_id: `trig-${user}`,
        actions: [{ type: 'button', action_id: button.action_id, block_id: 'b', value: button.value, action_ts: '1' }],
      }),
    );

  // Only the person it was for can open it.
  await click('U9');
  assert.equal(slack.of('views.open').length, 0);
  assert.match(slack.of('chat.postEphemeral').at(-1).body.text, /This form is for <@U2>/);

  await click('U2');
  const { view } = slack.of('views.open')[0].body;
  assert.equal(view.title.text, 'Time off');
  assert.deepEqual(
    view.blocks.map((b) => [b.label?.text, b.element?.type, Boolean(b.optional)]),
    [
      ['Start date', 'datepicker', false],
      ['Days', 'number_input', false],
      ['Kind', 'static_select', false],
      ['Notes', 'plain_text_input', true],
    ],
  );

  const answer = {
    start_date: { type: 'datepicker', selected_date: '2026-12-01' },
    days: { type: 'number_input', value: '3' },
    kind: { type: 'static_select', selected_option: { value: 'Vacation' } },
    notes: { type: 'plain_text_input', value: null },
  };
  const values = Object.fromEntries(view.blocks.map((b) => [b.block_id, { [b.element.action_id]: answer[b.element.action_id] }]));
  const res = await send(
    slackAction({
      type: 'view_submission',
      user: { id: 'U2', name: 'person', team_id: 'T1' },
      team: { id: 'T1' },
      api_app_id: 'A1',
      trigger_id: 'trig2',
      view: { id: 'V1', callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values } },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(vf.interacts.at(-1).action.payload, 'Filled in the form "Time off":\nStart date: 2026-12-01\nDays: 3\nKind: Vacation\nNotes: (left empty)');
  assert.equal(said(slack.posts().at(-1)), 'Booked.');
  assert.match(JSON.stringify(slack.updates().at(-1).body.blocks), /✓ Sent by <@U2>/, 'the button comes off');

  // A sent form can't be sent again.
  await click('U2');
  assert.equal(slack.of('views.open').length, 1);
  assert.match(slack.of('chat.postEphemeral').at(-1).body.text, /already been sent/);
});

test('answersText reads as the person would write it', () => {
  assert.equal(answersText({ title: 'T', fields: [{ name: 'a', label: 'A', type: 'text' }] }, { a: ' x ' }), 'Filled in the form "T":\nA: x');
});
