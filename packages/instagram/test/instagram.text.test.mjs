// What only Instagram's package has to hold: text is sent as it is written, so it is as long as it is written.
// Instagram takes 1,000 bytes in a message and the adapter cuts a longer one short without a word, so a reply
// measured as Markdown, which counts none of the marks in a block of code, would lose its end.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelHarness } from '@voiceflow/channelkit/testing';
import { instagram } from '../dist/index.js';
import { start } from './stand-in.mjs';

const { setup } = channelHarness({ slug: 'instagram', channel: instagram, start, state: createMemoryState });
const say = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });

test('code that looks like Markdown arrives whole: every mark in it is counted', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `${i + 1} Use [the form](https://example.com/form) and **press send**.`);
  const t = await setup(() => [say(`Run this:\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``)]);
  await t.send(t.platform.message('show me'));
  const parts = (await t.platform.sent()).map((item) => item.text);
  assert.equal(parts.join('\n').replace(/\n+/g, '\n'), ['Run this:', ...lines].join('\n'), 'every line, as it was written');
  assert.ok(parts.length > 3, `in ${parts.length} messages`);
  assert.ok(
    parts.every((part) => Buffer.byteLength(part) <= 1000),
    "each within Instagram's 1,000 bytes",
  );
  assert.deepEqual(t.errors, []);
});
