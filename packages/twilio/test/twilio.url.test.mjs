// What only Twilio's package has. Twilio signs a request over the address it
// was given, and behind a tunnel or a proxy the server is asked at another.
// The channel puts the public address back together from what the proxy says,
// so a message that is Twilio's is taken there, and nothing else is.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelHarness } from '@voiceflow/channelkit/testing';
import { twilio } from '../dist/index.js';
import { publicUrl } from '../dist/platform.js';
import { start } from './stand-in.mjs';

const { setup } = channelHarness({ slug: 'twilio', channel: twilio, start, state: createMemoryState });
const request = (url, headers = {}) => new Request(url, { method: 'POST', headers });

test('the public address is put back together from what a proxy says of the request', () => {
  const local = 'http://localhost:3000/api/twilio?x=1';
  assert.equal(
    publicUrl(request(local, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'bot.example.com' }), undefined),
    'https://bot.example.com/api/twilio?x=1',
  );
  assert.equal(
    publicUrl(request(local, { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'bot.example.com, inner' }), undefined),
    'https://bot.example.com/api/twilio?x=1',
    'the first of each, as the outermost proxy wrote it',
  );
  assert.equal(
    publicUrl(request(local, { 'x-forwarded-proto': 'https', host: 'tunnel.example.com' }), undefined),
    'https://tunnel.example.com/api/twilio?x=1',
    'a tunnel that passes the host on as the host',
  );
  assert.equal(
    publicUrl(request(local, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'bot.example.com:8443' }), undefined),
    'https://bot.example.com:8443/api/twilio?x=1',
    'a port the proxy names is kept',
  );
  assert.equal(
    publicUrl(request('https://bot.example.com/api/twilio'), undefined),
    'https://bot.example.com/api/twilio',
    'and a request that came straight in is left as it is',
  );
  assert.equal(publicUrl(request(local, { 'x-forwarded-proto': 'ftp' }), undefined), local, "a scheme that isn't http or https is not taken");
  assert.equal(
    publicUrl(request(local, { 'x-forwarded-host': 'bot.example.com' }), 'https://fixed.example.com/api/twilio'),
    'https://fixed.example.com/api/twilio',
    'TWILIO_WEBHOOK_URL wins',
  );
});

test("behind a tunnel, Twilio's message is taken with no address configured, and a forged one is still refused", async () => {
  // The channel's own default, with no webhookUrl of the test's.
  const t = await setup(undefined, { adapter: { webhookUrl: undefined } });
  const tunnel = new URL(t.platform.url);
  const via = { 'x-forwarded-proto': 'https', 'x-forwarded-host': tunnel.host };
  const taken = await t.send(t.platform.proxied('hello', `http://localhost:3000${tunnel.pathname}`, via));
  assert.ok(taken.status < 300, `taken with ${taken.status}`);
  assert.equal(t.voiceflow.interacts.length, 1, 'and the agent was asked');

  const elsewhere = await t.send(
    t.platform.proxied('hello', `http://localhost:3000${tunnel.pathname}`, { ...via, 'x-forwarded-host': 'someone-else.example.com' }),
  );
  assert.ok(elsewhere.status >= 400, 'signed for one address, and passed on as another: refused');
  const bare = await t.send(t.platform.proxied('hello', `http://localhost:3000${tunnel.pathname}`, {}));
  assert.ok(bare.status >= 400, 'with nothing said of where it was sent: refused');
  assert.ok((await t.send(t.platform.forged('hello'))).status >= 400);
  assert.equal(t.voiceflow.interacts.length, 1, 'none of them reached the agent');
});

test("an address of the caller's own is the one a request is checked against", async () => {
  const t = await setup(undefined, { adapter: { webhookUrl: 'https://another.example.com/api/twilio' } });
  assert.ok((await t.send(t.platform.message('hello'))).status >= 400, 'signed for the address the channel would work out, and not the one given: refused');
  assert.equal(t.voiceflow.interacts.length, 0);
});
