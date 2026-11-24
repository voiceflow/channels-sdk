// Holding Discord's Gateway connection: what `forwardGateway` asks of the
// adapter's listener, when it ends, and what it does when the listener ends by
// itself. The listener here is a stand-in: the real one connects to Discord.
import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardGateway } from '../dist/index.js';

const TOKEN = 'gateway-token-never-printed.abc';
const WEBHOOK = 'http://127.0.0.1:3000/api/discord';

/** A listener that runs until it's aborted, or until `end` says so. */
function fakeAdapter({ end, status = 200 } = {}) {
  const starts = [];
  let logger;
  return {
    starts,
    log: () => logger,
    create: (config) => {
      logger = config.logger;
      return {
        startGatewayListener: async (options, durationMs, signal, webhookUrl) => {
          starts.push({ durationMs, webhookUrl, config });
          if (status !== 200) return new Response(`refused with ${TOKEN}`, { status });
          options.waitUntil(
            new Promise((resolve) => {
              signal.addEventListener('abort', resolve, { once: true });
              end?.(resolve, logger, starts.length);
            }),
          );
          return new Response('{"status":"listening"}', { status: 200 });
        },
      };
    },
  };
}

test('it holds the connection until told to stop, passing events to your server', async () => {
  const fake = fakeAdapter();
  const stop = new AbortController();
  const connected = [];
  const held = forwardGateway({
    webhookUrl: WEBHOOK,
    signal: stop.signal,
    adapter: { botToken: TOKEN, publicKey: 'k', applicationId: '1' },
    create: fake.create,
    onConnected: (bot) => connected.push(bot),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.starts[0].webhookUrl, WEBHOOK);
  assert.equal(fake.starts[0].config.botToken, TOKEN);
  assert.ok(fake.starts[0].durationMs > 24 * 3600 * 1000, 'the connection is held for a long time');
  // The adapter says it's connected through its logger: that's passed on.
  fake.log().child('discord').info('Discord Gateway connected', { username: 'support-bot', id: '1' });
  fake.log().info('Discord Gateway forwarding event', { type: 'MESSAGE_CREATE' });
  assert.deepEqual(connected, ['support-bot']);
  stop.abort();
  await held;
});

test("a connection that ends by itself is a failure, said with the adapter's reason and never the token", async () => {
  const fake = fakeAdapter({
    end: (resolve, logger) => {
      logger.error('Discord Gateway listener error', { error: `Error [TokenInvalid]: An invalid token was provided: ${TOKEN}` });
      resolve();
    },
  });
  const problems = [];
  await assert.rejects(
    forwardGateway({
      webhookUrl: WEBHOOK,
      signal: new AbortController().signal,
      adapter: { botToken: TOKEN },
      create: fake.create,
      onProblem: (p) => problems.push(p),
    }),
    (error) => {
      assert.match(error.message, /The connection to Discord's Gateway ended: Discord Gateway listener error: Error \[TokenInvalid\]/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
  assert.equal(problems.length, 1);
  assert.ok(!problems[0].includes(TOKEN) && problems[0].includes('[bot token]'));
  assert.equal(fake.starts.length, 1, 'it was started again after failing');
});

test("a listener that won't start is a failure", async () => {
  const fake = fakeAdapter({ status: 500 });
  await assert.rejects(
    forwardGateway({ webhookUrl: WEBHOOK, signal: new AbortController().signal, adapter: { botToken: TOKEN }, create: fake.create }),
    (error) => {
      assert.match(error.message, /Gateway listener didn't start: refused with \[bot token\]/);
      return true;
    },
  );
});

test('a connection held for as long as asked is renewed', async () => {
  const stop = new AbortController();
  const fake = fakeAdapter({
    // Each one ends after it has run its time; the third is stopped.
    end: (resolve, _logger, n) => (n < 3 ? setTimeout(resolve, 30) : stop.abort()),
  });
  await forwardGateway({ webhookUrl: WEBHOOK, signal: stop.signal, adapter: { botToken: TOKEN }, create: fake.create, holdMs: 25 });
  assert.equal(fake.starts.length, 3);
});

test('stopped before it starts, it starts nothing', async () => {
  const fake = fakeAdapter();
  const stop = new AbortController();
  stop.abort();
  await forwardGateway({ webhookUrl: WEBHOOK, signal: stop.signal, adapter: { botToken: TOKEN }, create: fake.create });
  assert.equal(fake.starts.length, 0);
});
