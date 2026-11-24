// A reply longer than a platform shows in one message goes as several: where
// the cuts fall, and that nothing is lost by them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { splitMarkdown } from '../dist/index.js';

const words = (text) => text.split(/\s+/).filter(Boolean);
const sentence = (n) => `Sentence number ${n} of a long answer about the returns policy.`;

test('text that fits comes back as it was, and so does any text when there is no limit worth the name', () => {
  assert.deepEqual(splitMarkdown('Short.\n\nAnd sweet.', 2000), ['Short.\n\nAnd sweet.']);
  const long = 'x'.repeat(5000);
  assert.deepEqual(splitMarkdown(long, 0), [long]);
  assert.deepEqual(splitMarkdown(long, 10), [long]);
});

test('a long reply is cut between paragraphs, with every word kept and no part over the limit', () => {
  const paragraphs = Array.from({ length: 12 }, (_, p) => Array.from({ length: 5 }, (_, s) => sentence(p * 5 + s + 1)).join(' '));
  const text = paragraphs.join('\n\n');
  const parts = splitMarkdown(text, 1000);
  assert.ok(parts.length > 1);
  assert.ok(
    parts.every((part) => part.length <= 1000),
    parts.map((p) => p.length).join(','),
  );
  // Each part is whole paragraphs: it ends where one ended, and none starts or ends with space.
  for (const part of parts) {
    assert.ok(
      paragraphs.some((p) => part.endsWith(p)),
      part.slice(-40),
    );
    assert.equal(part, part.trim());
  }
  assert.deepEqual(words(parts.join(' ')), words(text));
});

test('a heading is never left at the end of one message with what it heads in the next', () => {
  const body = (topic) => Array.from({ length: 4 }, (_, i) => `${topic} detail ${i + 1}, explained at some length for the reader.`).join(' ');
  const sections = ['Returns', '## Refunds', '**Exchanges**', 'What to do next:'].map((heading) => `${heading}\n\n${body(heading.replace(/\W/g, ''))}`);
  const text = sections.join('\n\n');
  // Limits that put a cut near each heading in turn.
  for (const max of [300, 320, 340, 360, 420, 480]) {
    const parts = splitMarkdown(text, max);
    assert.ok(parts.length > 1 && parts.every((part) => part.length <= max));
    for (const part of parts) assert.match(part.split('\n\n').at(-1), /[.!?]$/, `at ${max}, a part ends on the heading: ${JSON.stringify(part.slice(-40))}`);
    assert.deepEqual(words(parts.join(' ')), words(text));
  }
  // A heading whose own start is too early to cut at: the cut goes inside the text it heads, never at the line
  // break after it, and the heading stays with that text.
  const heading = 'Shipping and delivery, in short';
  const opening = body('Opening');
  const long = `${opening}\n\n${heading}\n\n${body('Shipping')}`;
  const max = 2 * (opening.length + 2 + Math.floor(heading.length / 2));
  const parts = splitMarkdown(long, max);
  assert.ok(parts.length > 1 && parts.every((part) => part.length <= max));
  assert.ok(!parts.some((part) => part.endsWith(heading)), JSON.stringify(parts.map((part) => part.slice(-34))));
  assert.match(parts[0], /in short\n\nShipping detail 1/);
  assert.deepEqual(words(parts.join(' ')), words(long));
});

test('with no paragraph to cut at, it cuts at a line, then a sentence, then a word', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `- item ${i + 1} on the list`).join('\n');
  for (const part of splitMarkdown(lines, 200)) assert.match(part, /^- item \d+[^\n]*(\n- item \d+ on the list)*$/);

  const run = Array.from({ length: 30 }, (_, i) => sentence(i + 1)).join(' ');
  const bySentence = splitMarkdown(run, 300);
  assert.ok(bySentence.length > 1);
  assert.ok(
    bySentence.every((part) => part.endsWith('policy.') && part.startsWith('Sentence')),
    bySentence[0],
  );

  const noStops = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const byWord = splitMarkdown(noStops, 120);
  assert.ok(byWord.every((part) => part.length <= 120 && /^word\d+( word\d+)*$/.test(part)));
  assert.deepEqual(words(byWord.join(' ')), words(noStops));
});

test('one unbroken run is cut where it must be, and never through a character', () => {
  const run = 'a'.repeat(250);
  const parts = splitMarkdown(run, 100);
  assert.ok(parts.every((part) => part.length <= 100));
  assert.equal(parts.join(''), run);
  const emoji = '😀'.repeat(120);
  for (const part of splitMarkdown(emoji, 101)) assert.ok(!/[\ud800-\udbff]$/.test(part), 'a part ends on half a character');
});

test('a code block cut in two is closed in one message and opened again in the next', () => {
  const code = Array.from({ length: 60 }, (_, i) => `  const value${i} = compute(${i});`).join('\n');
  const text = `Here is the script:\n\n\`\`\`js\n${code}\n\`\`\`\n\nRun it with node.`;
  const parts = splitMarkdown(text, 600);
  assert.ok(parts.length > 2);
  assert.ok(
    parts.every((part) => part.length <= 600),
    parts.map((p) => p.length).join(','),
  );
  // Every part's fences pair up, and a part that carries on the code says so in the code's own language.
  for (const part of parts) assert.equal((part.match(/^```/gm) ?? []).length % 2, 0, part);
  assert.ok(parts[1].startsWith('```js\n  const value'), parts[1].slice(0, 30));
  // The code's lines all arrive, indentation and all.
  const sent = parts.join('\n');
  for (let i = 0; i < 60; i++) assert.ok(sent.includes(`  const value${i} = compute(${i});`), `line ${i} was lost`);
  assert.ok(parts.at(-1).endsWith('Run it with node.'));
});

test('length is counted as the platform counts it', () => {
  // A platform that is sent every "@name" as "<@name>": two more characters for each.
  const measure = (text) => text.replace(/@(\w+)/g, '<@$1>').length;
  const text = Array.from({ length: 40 }, (_, i) => `ask @sam${i} about it.`).join(' ');
  const parts = splitMarkdown(text, 200, measure);
  assert.ok(
    parts.every((part) => measure(part) <= 200),
    parts.map(measure).join(','),
  );
  assert.ok(parts.some((part) => part.length < 200 && measure(part) > part.length));
  assert.deepEqual(words(parts.join(' ')), words(text));
});
