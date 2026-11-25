// What only WhatsApp's package has: WhatsApp shows three buttons on a message,
// and the adapter drops any more without a word. So a longer list of choices
// goes as a numbered list, and every one of them can be taken.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelHarness } from '@voiceflow/channels-sdk/testing';
import { whatsapp } from '../dist/index.js';
import { start } from './stand-in.mjs';

const { setup } = channelHarness({ slug: 'whatsapp', channel: whatsapp, start, state: createMemoryState });
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });
const offer = (labels) => ({
  type: 'choice',
  payload: { buttons: labels.map((name, i) => ({ name, request: { type: `path-${i + 1}`, payload: { label: name } } })) },
});

test('three choices are buttons, and four are a numbered list with none dropped', async () => {
  const four = ['Track order', 'Return an item', 'Change address', 'Talk to someone'];
  const t = await setup((action) =>
    action.type.startsWith('path-')
      ? [say(`Picked ${action.payload.label}.`)]
      : [say('What do you need?'), offer(action.payload === 'four' ? four : four.slice(0, 3))],
  );

  await t.send(t.platform.message('three'));
  const three = await t.platform.sent();
  assert.deepEqual(three.find((item) => item.buttons.length)?.buttons, four.slice(0, 3), 'three fit, so three are buttons');

  await t.send(t.platform.message('four'));
  const sent = await t.platform.sent();
  assert.equal(
    sent.find((item) => item.buttons.length),
    undefined,
    'four are sent as no buttons',
  );
  const words = sent.map((item) => item.text).join('\n');
  for (const [i, label] of four.entries()) assert.match(words, new RegExp(`${i + 1}\\.\\s*${label}`), `${label} is there, numbered ${i + 1}`);

  await t.send(t.platform.message('4'));
  assert.deepEqual(
    t.said().at(-1),
    { type: 'path-4', payload: { label: 'Talk to someone' } },
    'and the fourth, the one a button would have lost, can be taken',
  );
  assert.deepEqual(t.errors, []);
});
