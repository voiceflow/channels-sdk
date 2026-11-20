import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../dist/index.js';

const text = (message, extra = {}) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm', ...extra } });

test('text and spoken replies become text; markup in speech is dropped', () => {
  const t = translate([text('Hello **there**'), { type: 'speak', payload: { message: '<speak>Hi <break/>you<audio src="x.mp3"></audio></speak>', type: 'message' } }]);
  assert.deepEqual(t.replies.map((r) => r.markdown), ['Hello **there**', 'Hi you']);
  assert.equal(t.ended, false);
});

test('a streamed completion becomes one text reply with its sources', () => {
  const t = translate([
    { type: 'completion', payload: { state: 'start', messageID: 'c1' } },
    { type: 'completion', payload: { state: 'content', content: 'Part one, ', messageID: 'c1' } },
    { type: 'completion', payload: { state: 'content', content: 'part two.', messageID: 'c1' } },
    { type: 'completion', payload: { state: 'end', messageID: 'c1', sourceUrls: [{ url: 'https://example.com/a', name: 'A' }] } },
  ]);
  assert.equal(t.replies.length, 1);
  assert.equal(t.replies[0].markdown, 'Part one, part two.');
  assert.deepEqual(t.replies[0].sources, [{ url: 'https://example.com/a', name: 'A' }]);
});

test('buttons keep their Voiceflow request; a button without one sends its label', () => {
  const t = translate([{ type: 'choice', payload: { buttons: [
    { name: 'Track order', request: { type: 'path-abc', payload: { label: 'Track order' } } },
    { name: 'Talk to someone' },
  ] } }]);
  assert.deepEqual(t.replies[0].choices, [
    { label: 'Track order', action: { type: 'path-abc', payload: { label: 'Track order' } } },
    { label: 'Talk to someone', action: { type: 'text', payload: 'Talk to someone' } },
  ]);
});

test('cards, carousels and images keep their parts', () => {
  const card = { title: 'Plan A', description: { text: 'The basic plan' }, imageUrl: 'https://example.com/a.png', buttons: [{ name: 'Pick A', request: { type: 'a' } }] };
  const t = translate([
    { type: 'cardV2', payload: card },
    { type: 'carousel', payload: { layout: 'Carousel', cards: [card, { ...card, title: 'Plan B', imageUrl: null, description: { text: '' } }] } },
    { type: 'visual', payload: { visualType: 'image', image: 'https://example.com/b.png' } },
  ]);
  assert.equal(t.replies[0].type, 'card');
  assert.deepEqual(t.replies[0].card, { title: 'Plan A', description: 'The basic plan', imageUrl: 'https://example.com/a.png', choices: [{ label: 'Pick A', action: { type: 'a' } }] });
  assert.equal(t.replies[1].cards.length, 2);
  assert.equal(t.replies[1].cards[1].imageUrl, undefined);
  assert.equal(t.replies[1].cards[1].description, undefined);
  assert.deepEqual(t.replies[2], { type: 'image', url: 'https://example.com/b.png' });
});

test('an end trace ends the conversation', () => {
  assert.equal(translate([text('Bye'), { type: 'end' }]).ended, true);
});

test('internal traces are silent; unknown ones are reported, never thrown', () => {
  const t = translate([
    { type: 'debug', payload: {} }, { type: 'knowledgeBase', payload: { chunks: [] } }, { type: 'tool-call', payload: {} },
    { type: 'brand-new-trace', payload: { anything: true } }, { type: 'channel-action', payload: {} }, null, { payload: {} },
    text('   '),
  ]);
  assert.deepEqual(t.replies, []);
  assert.deepEqual(t.skipped, ['brand-new-trace', 'channel-action', 'unknown', 'unknown']);
});

test('a URL button keeps its link from its open_url action, and its request', () => {
  const request = { type: 'path-1', payload: { label: 'Book', actions: [{ type: 'open_url', payload: { url: 'https://example.com/b' } }] } };
  const { replies } = translate([{ type: 'choice', payload: { buttons: [{ name: 'Book', request }, { name: 'Bad', request: { type: 'p', payload: { actions: [{ type: 'open_url', payload: { url: 'javascript:alert(1)' } }] } } }] } }]);
  assert.deepEqual(replies[0].choices.map((c) => [c.label, c.url, c.action.type]), [['Book', 'https://example.com/b', 'path-1'], ['Bad', undefined, 'p']]);
});

test('a trace type the channel shows natively is kept in its place, not skipped', () => {
  const traces = [
    { type: 'text', payload: { message: 'Before' } },
    { type: 'slack.react', payload: { emoji: 'tada' } },
    { type: 'mystery', payload: {} },
    { type: 'text', payload: { message: 'After' } },
  ];
  const plain = translate(traces);
  assert.deepEqual(plain.skipped, ['slack.react', 'mystery']);
  const kept = translate(traces, { custom: (type) => type === 'slack.react' });
  assert.deepEqual(kept.replies.map((r) => r.type), ['text', 'trace', 'text']);
  assert.deepEqual(kept.replies[1].trace, traces[1]);
  assert.deepEqual(kept.skipped, ['mystery']);
});
