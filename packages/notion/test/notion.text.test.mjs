// What only Notion's package has: a comment has no lists, and the adapter
// takes a list's marks off, so a list is written in marks a comment keeps.
import assert from 'node:assert/strict';
import test from 'node:test';
import { text } from '../dist/platform.js';

test('a list is written in marks a Notion comment keeps', () => {
  assert.equal(text('Pick one:\n\n1. Track order\n2. Talk to someone'), 'Pick one:\n\n(1) Track order\n(2) Talk to someone');
  assert.equal(text('- apples\n* pears\n+ plums'), '• apples\n• pears\n• plums');
  assert.equal(text('1. One\n   - inside\n10. Ten'), '(1) One\n   • inside\n(10) Ten', 'whatever its number, and under another item');
});

test('nothing else is touched', () => {
  const kept = 'It costs 1.5 dollars - not 2.\n\n**Bold** and [a link](https://example.com).\n\n3.14 is pi';
  assert.equal(text(kept), kept, 'a number or a dash inside a line is no list');
  const code = 'Run:\n\n```\n1. not a list\n- nor this\n```\n\n1. But this is';
  assert.equal(text(code), 'Run:\n\n```\n1. not a list\n- nor this\n```\n\n(1) But this is', 'and code is left as written');
  assert.equal(
    text('````\n```\n1. still code\n```\n````\n- after'),
    '````\n```\n1. still code\n```\n````\n• after',
    'a shorter fence inside a longer one closes nothing',
  );
});
