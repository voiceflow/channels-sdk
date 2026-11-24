// What only Telegram's package has: it gives Telegram the server's address
// itself (no page of Telegram's takes one), with a secret connect makes, and
// takes it back. Run against the stand-in for Telegram's Bot API, with the
// real adapter checking what comes back.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelHarness, fakeVoiceflowApi } from '@voiceflow/channels-sdk/testing';
import { cli } from '../dist/connect/index.js';
import { telegram } from '../dist/index.js';
import { start } from './stand-in.mjs';

const { setup } = channelHarness({ slug: 'telegram', channel: telegram, start, state: createMemoryState });
const VF_KEY = 'VF.DM.telegram-point';

/** An app's env file with the bot's token in it, and the command run against the stand-in and a fake Voiceflow. */
async function app(t, { token } = {}) {
  const harness = await setup();
  const { platform } = harness;
  const dir = await mkdtemp(join(tmpdir(), 'telegram-point-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env.local');
  await writeFile(envFile, `TELEGRAM_BOT_TOKEN=${token ?? platform.adapter.botToken}\nTELEGRAM_API_BASE_URL=${platform.adapter.apiUrl}\n`);
  const api = fakeVoiceflowApi({ project: { id: 'proj1', name: 'Acme Support', workspaceID: 'ws1' }, apiKey: VF_KEY });
  // Voiceflow's API is the fake; Telegram is the stand-in on this machine.
  const fetch = (input, init) => (String(input).startsWith('http://127.0.0.1') ? globalThis.fetch(input, init) : api.fetch(input, init));
  const run = async (argv, { env = {} } = {}) => {
    const said = [];
    const code = await cli([...argv, '--env-file', envFile], {
      out: (line) => said.push(line),
      err: (line) => said.push(line),
      env: { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: 'proj1', VOICEFLOW_ENVIRONMENT: 'development', ...env },
      fetch,
      interactive: false,
    });
    return { code, said: said.join('\n') };
  };
  const saved = async () =>
    Object.fromEntries(
      (await readFile(envFile, 'utf8'))
        .split('\n')
        .flatMap((line) => (line.includes('=') ? [[line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]] : [])),
    );
  return { ...harness, run, saved, envFile };
}

test('connect gives Telegram the address with a secret it made, and the server takes what Telegram then sends', async (t) => {
  const a = await app(t);
  const { code, said } = await a.run(['connect', '--yes', '--public-url', 'https://bot.example.com']);
  assert.equal(code, 0, said);
  const secret = (await a.saved()).TELEGRAM_WEBHOOK_SECRET_TOKEN;
  assert.match(secret, /^[0-9a-f]{64}$/, 'a secret was made and saved');
  const webhook = a.platform.webhook();
  assert.equal(webhook.url, 'https://bot.example.com/api/telegram');
  assert.equal(webhook.secret_token, secret, 'Telegram was given the same secret');
  for (const kind of ['message', 'callback_query']) assert.ok(webhook.allowed_updates.includes(kind), `Telegram is asked to send ${kind}`);
  assert.match(said, /\+ Telegram sends your bot's messages to https:\/\/bot\.example\.com\/api\/telegram/);
  assert.ok(!said.includes(secret) && !said.includes(a.platform.adapter.botToken), 'neither the secret nor the token is printed');

  // A server with that env file: what Telegram sends with the secret is taken, and anything else is refused.
  const server = await setup(undefined, { adapter: { secretToken: secret } });
  assert.equal((await server.send(a.platform.viaWebhook('hello'))).status, 200);
  assert.equal(server.voiceflow.interacts.length, 1, 'the message reached the agent');
  assert.ok((await server.send(server.platform.message('hello'))).status >= 400, "another secret isn't Telegram's");
  assert.equal(server.voiceflow.interacts.length, 1);
});

test('point gives Telegram another address and keeps the secret; before connect it says to connect', async (t) => {
  const a = await app(t);
  const early = await a.run(['point', '--public-url', 'https://one.example.com']);
  assert.equal(early.code, 3, early.said);
  assert.match(early.said, /isn't connected here yet: run `voiceflow-channels connect telegram --env-file /);
  assert.equal(a.platform.webhook(), undefined, 'and Telegram was told nothing');

  assert.equal((await a.run(['connect', '--yes'])).code, 0);
  assert.equal(a.platform.webhook(), undefined, 'connect with no address gives Telegram none');
  const { TELEGRAM_WEBHOOK_SECRET_TOKEN: secret } = await a.saved();
  for (const host of ['one', 'two']) {
    const { code, said } = await a.run(['point', '--public-url', `https://${host}.example.com`]);
    assert.equal(code, 0, said);
    assert.deepEqual([a.platform.webhook().url, a.platform.webhook().secret_token], [`https://${host}.example.com/api/telegram`, secret]);
  }
  assert.equal((await a.saved()).TELEGRAM_WEBHOOK_SECRET_TOKEN, secret, 'the secret is never made twice');
});

test('disconnect has Telegram stop sending', async (t) => {
  const a = await app(t);
  assert.equal((await a.run(['connect', '--yes', '--public-url', 'https://bot.example.com'])).code, 0);
  assert.ok(a.platform.webhook());
  const { code, said } = await a.run(['disconnect']);
  assert.equal(code, 0, said);
  assert.equal(a.platform.webhook(), undefined);
  assert.match(said, /Telegram no longer sends your bot's messages to your server/);
});

test("a token Telegram doesn't know is the person's to fix, and is never printed", async (t) => {
  const token = '999:not-a-bot-telegram-knows';
  const a = await app(t, { token });
  const { code, said } = await a.run(['connect', '--yes', '--public-url', 'https://bot.example.com']);
  assert.equal(code, 3, said);
  assert.match(said, /Telegram doesn't know this bot token\. Copy it again from BotFather/);
  assert.ok(!said.includes(token) && !said.includes('not-a-bot'));
});

test("when Telegram can't be reached, the failure names no address: the address holds the token", async (t) => {
  const a = await app(t);
  await writeFile(
    a.envFile,
    `TELEGRAM_BOT_TOKEN=${a.platform.adapter.botToken}\nTELEGRAM_API_BASE_URL=http://127.0.0.1:9\nTELEGRAM_WEBHOOK_SECRET_TOKEN=abc\n`,
  );
  const { code, said } = await a.run(['point', '--public-url', 'https://bot.example.com']);
  assert.equal(code, 1, said);
  assert.match(said, /Telegram couldn't be reached \(setWebhook\)\. Nothing was changed\./);
  assert.ok(!said.includes(a.platform.adapter.botToken) && !said.includes('/bot'));
});
