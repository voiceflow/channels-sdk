import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, menuId, parseActionId, render, retired, matchTypedChoice } from '../dist/index.js';

const none = { buttons: false, cards: false, imagesInCards: false, typingIndicator: false };
const rich = { buttons: true, cards: true, imagesInCards: true, typingIndicator: true };
const CAPS = { ...rich, linkButtons: true, streaming: false, editMessages: true };
const choices = [{ label: 'Yes', action: { type: 'yes' } }, { label: 'No', action: { type: 'no' } }];

test('without buttons, choices become a numbered list numbered across the turn', () => {
  const r = render([
    { type: 'choices', choices },
    { type: 'card', card: { title: 'Plan', description: 'Details', imageUrl: 'https://example.com/p.png', choices: [{ label: 'Pick', action: { type: 'pick' } }] } },
  ], none);
  assert.deepEqual(r.posts, [{ markdown: '1. Yes\n2. No' }, { markdown: '**Plan**\nDetails\nhttps://example.com/p.png\n3. Pick' }]);
  assert.equal(r.choices.length, 3);
});

test('with buttons and cards, replies become Chat SDK cards with numbered action IDs', () => {
  const r = render([{ type: 'choices', choices }], rich);
  const { card, fallbackText } = r.posts[0];
  assert.equal(card.type, 'card');
  assert.equal(fallbackText, 'Yes · No');
  const actions = card.children.find((c) => c.type === 'actions');
  assert.deepEqual(actions.children.map((b) => [b.id, b.label, b.value]), [[`vf:${r.nonce}:0`, 'Yes', '0'], [`vf:${r.nonce}:1`, 'No', '1']]);
});

test('a card with buttons on a channel with cards but no buttons goes as text', () => {
  const r = render([{ type: 'card', card: { title: 'Plan', choices } }], { ...none, cards: true });
  assert.deepEqual(r.posts, [{ markdown: '**Plan**\n1. Yes\n2. No' }]);
});

test('sources show only when asked', () => {
  const reply = { type: 'text', markdown: 'Answer', sources: [{ url: 'https://example.com/a', name: 'A' }] };
  assert.deepEqual(render([reply], none).posts, [{ markdown: 'Answer' }]);
  assert.deepEqual(render([reply], none, { sources: 'links' }).posts, [{ markdown: 'Answer\n\nSources: [A](https://example.com/a)' }]);
});

test('a typed number or label picks a choice', () => {
  assert.equal(matchTypedChoice('2', choices).label, 'No');
  assert.equal(matchTypedChoice(' 1. ', choices).label, 'Yes');
  assert.equal(matchTypedChoice('no', choices).label, 'No');
  assert.equal(matchTypedChoice('3', choices), null);
  assert.equal(matchTypedChoice('maybe later', choices), null);
});

test('a URL choice is a link button where the channel has them, and a markdown link where it has not', () => {
  const link = [{ label: 'Book', action: { type: 'b' }, url: 'https://example.com/b' }, { label: 'Later', action: { type: 'l' } }];
  const withLinks = render([{ type: 'choices', choices: link }], { ...rich, linkButtons: true });
  const actions = withLinks.posts[0].card.children.find((c) => c.type === 'actions');
  assert.deepEqual(actions.children.map((b) => [b.type, b.id, b.url]), [['link-button', `vf:${withLinks.nonce}:0`, 'https://example.com/b'], ['button', `vf:${withLinks.nonce}:1`, undefined]]);

  // Buttons but no link buttons: the link would be lost on a plain button, so the group goes as text.
  const withoutLinks = render([{ type: 'choices', choices: link }], { ...rich, linkButtons: false });
  assert.deepEqual(withoutLinks.posts, [{ markdown: '1. [Book](https://example.com/b)\n2. Later' }]);
});

test('a rich post keeps its text form, numbered as shown, and what its buttons showed', () => {
  const r = createRenderer(rich);
  const [card] = r.render({ type: 'card', card: { title: 'Plan', description: 'Details', choices: [{ label: 'Pick', action: { type: 'pick' } }] } });
  const [list] = r.render({ type: 'choices', choices });
  const [text] = r.render({ type: 'text', markdown: 'Hi', sources: [] });
  assert.deepEqual(r.textOf(card), { markdown: '**Plan**\nDetails\n1. Pick' });
  assert.deepEqual(r.textOf(list), { markdown: '2. Yes\n3. No' });
  assert.deepEqual(r.buttonsOf(card), { kind: 'card', card: { title: 'Plan', description: 'Details', choices: [{ label: 'Pick', action: { type: 'pick' } }] }, first: 0 });
  assert.deepEqual(r.buttonsOf(list), { kind: 'choices', choices, first: 1 });
  assert.equal(r.textOf(text), null);
  assert.equal(r.buttonsOf(text), null);
  assert.equal(r.choices.length, 3, 'nothing numbered twice');
});

test('a retired message has no buttons, and a pick from it shows as a check mark', () => {
  const shown = { kind: 'choices', choices, first: 2 };
  const json = (post) => JSON.stringify(post);
  assert.match(json(retired(shown, 3, rich)), /✓ No/);
  assert.doesNotMatch(json(retired(shown, 3, rich)), /"type":"actions"/);
  assert.match(json(retired(shown, 0, rich)), /Yes · No/, 'a pick from another message marks nothing here');
  const card = retired({ kind: 'card', card: { title: 'Plan', description: 'Details', imageUrl: 'https://example.com/p.png', choices }, first: 0 }, null, rich);
  assert.match(json(card), /Plan/);
  assert.match(json(card), /Details/);
  assert.match(json(card), /p\.png/);
  assert.doesNotMatch(json(card), /"type":"actions"|✓/);
});

test('a long list is one menu where the channel has menus, and buttons where it does not', () => {
  const choices = Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i + 1}`, action: { type: `p${i}` } }));
  const withMenus = { ...CAPS, selectMenus: true };
  const r = createRenderer(withMenus);
  const [post] = r.render({ type: 'choices', choices });
  const actions = post.card.children[0];
  assert.equal(actions.children.length, 1);
  assert.equal(actions.children[0].type, 'select');
  assert.equal(actions.children[0].id, menuId(r.nonce));
  assert.deepEqual(actions.children[0].options.map((o) => o.value), ['0', '1', '2', '3', '4', '5', '6']);
  assert.deepEqual(parseActionId(menuId(r.nonce), '5'), { nonce: r.nonce, index: 5 });
  assert.equal(parseActionId(menuId(r.nonce), 'x'), null);
  assert.deepEqual(r.buttonsOf(post), { kind: 'choices', choices, first: 0 });

  // Five or fewer stay buttons; so does a list with a link, which a menu can't open.
  const five = createRenderer(withMenus).render({ type: 'choices', choices: choices.slice(0, 5) })[0];
  assert.ok(five.card.children[0].children.every((c) => c.type === 'button'));
  const linked = [...choices.slice(0, 6), { label: 'Docs', action: { type: 'd' }, url: 'https://example.com' }];
  assert.ok(createRenderer(withMenus).render({ type: 'choices', choices: linked })[0].card.children[0].children.every((c) => c.type !== 'select'));
  // Without menus, a long list keeps its buttons.
  assert.ok(createRenderer({ ...CAPS, selectMenus: false }).render({ type: 'choices', choices })[0].card.children[0].children.every((c) => c.type === 'button'));
});
