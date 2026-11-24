// What only Notion's package has: the verification token can't be set before the server runs, because Notion
// sends it to the server as the webhook is saved. So a server with no token yet has to start, answer that one
// request, and take nothing else.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelHarness } from '@voiceflow/channelkit/testing';
import { notion } from '../dist/index.js';
import { start } from './stand-in.mjs';

const { setup } = channelHarness({ slug: 'notion', channel: notion, start, state: createMemoryState });
const post = (body) =>
  new Request('https://bot.example.com/api/notion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('before Notion has sent its token, the server starts, answers the handshake, and takes nothing else', async () => {
  const before = process.env.NOTION_VERIFICATION_TOKEN;
  delete process.env.NOTION_VERIFICATION_TOKEN;
  try {
    const t = await setup(undefined, { adapter: { verificationToken: undefined } });
    assert.equal((await t.send(post({ verification_token: 'made-up-token-from-notion' }))).status, 200, "Notion's one unsigned request is answered");
    // What `point` asks a server before an address is given out: any answer but "no route" and "failed".
    assert.equal((await t.send(post({}))).status, 401);
    assert.ok((await t.send(t.platform.message('hello'))).status >= 400, 'a comment is refused until the token is set');
    assert.equal(t.voiceflow.interacts.length, 0, 'and the agent is told nothing');
    assert.deepEqual(t.errors, []);
  } finally {
    if (before !== undefined) process.env.NOTION_VERIFICATION_TOKEN = before;
  }
});
