import assert from 'node:assert/strict';
import test from 'node:test';
import { voiceflowUserID, withoutBotMention } from '../dist/index.js';

test("the bot's own mention is removed, in every form the Chat SDK counts", () => {
  const adapter = { userName: 'bot', botUserId: 'UBOT' };
  assert.equal(withoutBotMention('@voiceflow where is my order?', adapter, 'voiceflow'), 'where is my order?');
  assert.equal(withoutBotMention('<@UBOT> hi', adapter), 'hi');
  assert.equal(withoutBotMention('hey @bot, hi', adapter), 'hey , hi');
  assert.equal(withoutBotMention('email me at me@voiceflow.com', adapter, 'voiceflow'), 'email me at me@voiceflow.com');
  assert.equal(withoutBotMention('@voiceflow-team ping', adapter, 'voiceflow'), '@voiceflow-team ping');
  assert.equal(withoutBotMention('@voiceflow', adapter, 'voiceflow'), '@voiceflow', 'a bare mention is kept rather than sent empty');
});

test('a thread ID is the Voiceflow user ID, hashed past 256 characters', () => {
  assert.equal(voiceflowUserID('slack:C1:1.1'), 'slack:C1:1.1');
  const long = voiceflowUserID('x'.repeat(300));
  assert.match(long, /^thread:[0-9a-f]{64}$/);
  assert.ok(long.length <= 256);
});
