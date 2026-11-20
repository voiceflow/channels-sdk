import assert from 'node:assert/strict';
import test from 'node:test';
import { listStateAdapters } from '@chat-adapter/catalog';
import { ChannelsError, capabilities, credentialVars, listChannels, loadAdapter, platformEntry, secretName, secretVars } from '../dist/index.js';

test('every platform in the catalog has what the loader needs', () => {
  const list = listChannels();
  assert.ok(list.length > 10);
  for (const entry of list) {
    assert.equal(entry.type, 'platform');
    assert.ok(entry.packageName, `${entry.slug} names a package`);
    assert.ok(entry.factoryExport, `${entry.slug} names a factory`);
  }
});

test('an unknown slug and a state adapter are refused with codes', () => {
  assert.throws(
    () => platformEntry('not-a-platform'),
    (e) => e instanceof ChannelsError && e.code === 'unknown_channel',
  );
  const [state] = listStateAdapters();
  assert.throws(
    () => platformEntry(state.slug),
    (e) => e instanceof ChannelsError && e.code === 'not_a_platform',
  );
});

test('capabilities come from the catalog: only a full "yes" counts', () => {
  const slack = capabilities('slack');
  assert.equal(slack.buttons, true);
  assert.equal(slack.cards, true);
  assert.equal(slack.editMessages, true);
  // WhatsApp has buttons but can't edit a sent message, so its old buttons stay (and go stale).
  assert.equal(capabilities('whatsapp').buttons, true);
  assert.equal(capabilities('whatsapp').editMessages, false);
  // Every capability is a boolean for every listed platform.
  for (const { slug } of listChannels()) {
    for (const v of Object.values(capabilities(slug))) assert.equal(typeof v, 'boolean', slug);
  }
});

test('credentials and secret names follow the catalog with one rule', () => {
  const keys = credentialVars('slack').map((v) => v.key);
  assert.ok(keys.includes('SLACK_BOT_TOKEN'));
  assert.ok(secretVars('slack').includes('SLACK_SIGNING_SECRET'));
  assert.equal(secretName('SLACK_BOT_TOKEN'), 'slack_bot_token');
  for (const { slug } of listChannels()) {
    for (const key of secretVars(slug)) assert.match(secretName(key), /^[a-z0-9_]+$/, `${slug} ${key}`);
  }
});

test('the loader builds an adapter from the catalog with its own options', async () => {
  const adapter = await loadAdapter('slack', { options: { botToken: 'xoxb-test', signingSecret: 'test', botUserId: 'UBOT' } });
  assert.equal(adapter.name, 'slack');
});

test('the loader names the package to install when it is missing', async () => {
  const importer = async () => {
    throw new Error('Cannot find package');
  };
  await assert.rejects(
    loadAdapter('whatsapp', { importer }),
    (e) => e.code === 'adapter_not_installed' && /npm install @chat-adapter\/whatsapp/.test(e.message),
  );
});

test("the loader uses the adapter module it's given, importing nothing by name", async () => {
  // A bundler (Next.js, say) can't follow import(name); a bundled server passes the module instead.
  const importer = async () => {
    throw new Error('Cannot find module as expression is too dynamic');
  };
  const module = { createSlackAdapter: (options) => ({ name: 'slack', options }) };
  const adapter = await loadAdapter('slack', { module, importer, options: { botToken: 'xoxb-test' } });
  assert.deepEqual(adapter, { name: 'slack', options: { botToken: 'xoxb-test' } });
});

test('the loader says how to pass the module when a bundler stops it', async () => {
  const importer = async () => {
    throw new Error('Cannot find module as expression is too dynamic');
  };
  await assert.rejects(
    loadAdapter('slack', { importer }),
    (e) => e.code === 'adapter_not_installed' && e.message.includes("{ slug: 'slack', module: await import('@chat-adapter/slack') }"),
  );
});

test('the loader says when a package lacks the catalog factory', async () => {
  const importer = async () => ({});
  await assert.rejects(loadAdapter('slack', { importer }), (e) => e.code === 'adapter_factory_missing');
});
