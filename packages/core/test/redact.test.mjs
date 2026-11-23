// Known secret values never reach what a command prints: they are taken out
// where an error is made, before it is cut to length, and from every line on its way out.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedactor, redact } from '../dist/index.js';
import { createVoiceflowApi, installTools, memoryRecordStore } from '../dist/install.js';
import { fakeVoiceflowApi } from '../dist/testing.js';

const KEY = 'VF.DM.6a1b2c3d4e5f.never-printed-key';
const VALUE = 'https://hooks.example.com/services/T0/B0/never-printed-value';

test('a known value is hidden however it is written, and nothing else is touched', () => {
  assert.equal(redact(`Invalid key ${KEY}.`, [KEY]), 'Invalid key [hidden].');
  assert.equal(
    redact(`authorization=${encodeURIComponent('a b&c=d/e+secret')}`, ['a b&c=d/e+secret']),
    'authorization=[hidden]',
    'as a URL or a form writes it',
  );
  assert.equal(redact(JSON.stringify({ value: 'line one\n"quoted" secret' }), ['line one\n"quoted" secret']), '{"value":"[hidden]"}', 'as JSON writes it');
  assert.equal(redact(`${KEY} and ${KEY}`, [KEY]), '[hidden] and [hidden]', 'every time it appears');
  // Every character a pattern would read as its own. Joined, so the text has no placeholder a template string would fill.
  const special = ['.*+?^', '$', '{}()|[]\\'].join('');
  assert.equal(redact(`a${special} value`, [special]), 'a[hidden] value', 'whatever characters it holds');
  // A value that holds another is hidden whole, not left with its ends showing.
  assert.equal(redact('token-abcdefgh-and-more', ['abcdefgh', 'token-abcdefgh-and-more']), '[hidden]');
  // Too short to be a secret, or not there at all: the text stays readable.
  assert.equal(redact('the key is in the env file', ['key', '', undefined, null]), 'the key is in the env file');
  assert.equal(redact('nothing to hide', []), 'nothing to hide');
});

test('a redactor hides a secret from the moment it is told of it', () => {
  const secrets = createRedactor(KEY, undefined);
  assert.equal(secrets.redact(`${KEY} xoxb-later-token`), '[hidden] xoxb-later-token');
  secrets.add('xoxb-later-token', null, 'short');
  assert.equal(secrets.redact(`${KEY} xoxb-later-token short`), '[hidden] [hidden] short');
});

test("Voiceflow's API repeating the key back never puts it in the error, even where the error is cut", async () => {
  // The key starts just before the 300th character: cut first, most of it would be left showing.
  for (const pad of [0, 280, 295]) {
    const said = `${'x'.repeat(pad)} Unauthorized: no key ${KEY} for this project.`;
    for (const body of [JSON.stringify({ message: said }), said]) {
      const api = createVoiceflowApi({ apiKey: KEY, fetch: async () => new Response(body, { status: 401 }) });
      await assert.rejects(api('GET', '/v1/stable/project/p1'), (error) => {
        assert.equal(error.code, 'voiceflow_http');
        assert.match(error.message, /answered 401/);
        for (let length = 8; length <= KEY.length; length++)
          assert.ok(!error.message.includes(KEY.slice(0, length)), `the key's first ${length} characters are in: ${error.message.slice(-80)}`);
        if (pad === 0) assert.match(error.message, /no key \[hidden\] for this project/, 'the rest of what it said is kept');
        return true;
      });
    }
  }
});

test("a secret's value never comes back in the error when writing it fails", async () => {
  const fake = fakeVoiceflowApi({ project: { id: 'p1', name: 'Agent', workspaceID: 'w1' } });
  const fetch = async (url, init = {}) => {
    // The API quotes the body it refused.
    if (String(url).includes('/secret/') && init.method === 'PUT')
      return new Response(JSON.stringify({ message: `${'x'.repeat(260)} invalid body ${init.body}` }), { status: 400 });
    return fake.fetch(url, init);
  };
  const set = { channel: 'demo', secrets: { demo_secret: 'A value.' }, tools: [] };
  await assert.rejects(
    installTools(set, { apiKey: KEY, fetch, projectID: 'p1', environment: 'development', record: memoryRecordStore(), secretValues: { demo_secret: VALUE } }),
    (error) => {
      assert.match(error.message, /answered 400/);
      for (let length = 8; length <= VALUE.length; length++)
        assert.ok(!error.message.includes(VALUE.slice(0, length)), `the value's first ${length} characters are in the error`);
      return true;
    },
  );
});
