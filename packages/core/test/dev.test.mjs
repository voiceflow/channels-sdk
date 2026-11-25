// The tunnel and `voiceflow-channels dev`, against a machine of the test's own:
// no cloudflared is run, no server is started and nothing leaves this process.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkTunnelTool, dev, startTunnel, TUNNEL_DOCS, TUNNEL_INSTALL_BREW } from '../dist/dev.js';
import { NeedsYou } from '../dist/index.js';

const URL_ = 'https://quiet-river-test.trycloudflare.com';
const INSTEAD = 'Or give it your own address: --public-url https://<host>.';

/**
 * A machine a tunnel runs on.
 *   `tools`     which commands are installed
 *   `prints`    what cloudflared prints once started (default: its address)
 *   `exits`     the code cloudflared stops with, right away
 *   `unknown`   how many times the address fails to answer before it does
 *   `notInDns`  how many times a public resolver says the name isn't there yet
 *   `brew`      the code `brew install cloudflared` exits with; 0 installs it
 */
function machine({ tools = ['cloudflared'], prints = [`2026 INF |  ${URL_}  |`], exits, unknown = 0, notInDns = 0, brew = 0 } = {}) {
  const installed = new Set(tools);
  const events = [];
  let misses = unknown;
  let absent = notInDns;
  const host = {
    platform: 'linux',
    find: (name) => (installed.has(name) ? `/fake/${name}` : undefined),
    start: (command, args, on) => {
      events.push(`start ${[command, ...args].join(' ')}`);
      queueMicrotask(() => {
        for (const line of prints) on.line(line);
        if (exits !== undefined) on.exit(exits);
      });
      return {
        stop: async () => {
          events.push('stop tunnel');
        },
      };
    },
    run: async (command, args) => {
      events.push(`run ${[command, ...args].join(' ')}`);
      if (brew === 0) installed.add('cloudflared');
      return brew;
    },
    known: async (hostname) => {
      events.push(`dns ${hostname}`);
      return absent-- <= 0;
    },
    fetch: async (url) => {
      events.push(`probe ${url}`);
      if (misses-- > 0) throw new Error('getaddrinfo ENOTFOUND');
      return new Response('', { status: 502 });
    },
    wait: async (ms) => {
      events.push(`wait ${ms}`);
    },
  };
  const asked = [];
  const said = [];
  const options = (more = {}) => ({
    port: 3000,
    interactive: false,
    ask: async (question) => {
      asked.push(question);
      if (!('answer' in more)) throw new Error(`asked "${question}" with no answer to give`);
      return more.answer;
    },
    say: (line) => said.push(line),
    instead: INSTEAD,
    host,
    ...more,
  });
  return { host, options, events, asked, said };
}

// ── The tunnel ──────────────────────────────────────────────────────────────

test('a tunnel is cloudflared to the port, its address read from what it prints, and given only once it answers', async () => {
  const m = machine({ notInDns: 2, unknown: 1 });
  const tunnel = await startTunnel(m.options({ port: 4321 }));
  assert.equal(tunnel.url, URL_);
  const name = new URL(URL_).hostname;
  assert.deepEqual(m.events, [
    'start /fake/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4321',
    // A new name is asked of a public resolver until it exists: this machine's own would remember the miss.
    `dns ${name}`,
    'wait 500',
    `dns ${name}`,
    'wait 500',
    `dns ${name}`,
    // Only then is the address itself tried.
    `probe ${URL_}`,
    'wait 1000',
    `probe ${URL_}`,
  ]);
  await tunnel.close();
  assert.equal(m.events.at(-1), 'stop tunnel');
  assert.deepEqual(m.asked, []);
});

test('a tunnel that gives no address, stops, or never answers is an error that says why, and nothing is left running', async () => {
  const stopped = machine({ prints: ['ERR failed to request quick Tunnel: no route'], exits: 1 });
  await assert.rejects(
    startTunnel(stopped.options()),
    /cloudflared stopped before it gave an address \(exit 1\): ERR failed to request quick Tunnel: no route/,
  );
  assert.equal(stopped.events.at(-1), 'stop tunnel');

  const silent = machine({ prints: ['INF starting'] });
  await assert.rejects(startTunnel(silent.options({ timeoutMs: 20 })), /cloudflared gave no address in 0 seconds: INF starting/);
  assert.equal(silent.events.at(-1), 'stop tunnel');

  // No public resolver in reach: it stops asking, and tries the address anyway.
  const walled = machine({ notInDns: Number.POSITIVE_INFINITY });
  assert.equal((await startTunnel(walled.options({ timeoutMs: 0 }))).url, URL_);
  assert.equal(walled.events.at(-1), `probe ${URL_}`);

  const lost = machine({ unknown: Number.POSITIVE_INFINITY });
  await assert.rejects(startTunnel(lost.options({ timeoutMs: 0 })), (error) => {
    assert.match(error.message, new RegExp(`The tunnel's address \\(${URL_}\\) didn't start answering`));
    assert.ok(error.message.endsWith(INSTEAD), 'and the way to do without one');
    return !(error instanceof NeedsYou);
  });
  assert.equal(lost.events.at(-1), 'stop tunnel');
});

test('without cloudflared a script is told how to get it and how to do without, and nothing is run', async () => {
  const bare = machine({ tools: [] });
  await assert.rejects(startTunnel(bare.options()), (error) => {
    assert.ok(error instanceof NeedsYou);
    assert.equal(
      error.message,
      `A tunnel gives this machine a public address. It needs cloudflared, which isn't installed. Install it (${TUNNEL_DOCS}). Then run this again. ${INSTEAD}`,
    );
    return true;
  });
  assert.deepEqual(bare.events, []);

  // With Homebrew there, its command is given. A script still isn't installed for.
  const withBrew = machine({ tools: ['brew'] });
  await assert.rejects(startTunnel(withBrew.options()), (error) => error instanceof NeedsYou && error.message.includes(`\n\n  ${TUNNEL_INSTALL_BREW}\n\n`));
  assert.deepEqual(withBrew.events, []);
  assert.throws(() => checkTunnelTool({ instead: INSTEAD, host: withBrew.host }), NeedsYou);
  assert.doesNotThrow(() => checkTunnelTool({ instead: INSTEAD, host: machine().host }));
});

test('with Homebrew and a person there, cloudflared is installed on a yes: the command shown first', async () => {
  const yes = machine({ tools: ['brew'] });
  const tunnel = await startTunnel(yes.options({ interactive: true, answer: 'y' }));
  assert.equal(tunnel.url, URL_);
  assert.deepEqual(yes.asked, ['Run it now? [y/N] ']);
  assert.ok(yes.said.join('\n').includes(`  ${TUNNEL_INSTALL_BREW}`), 'shown before the question');
  assert.deepEqual(yes.events.slice(0, 2), [
    'run /fake/brew install cloudflared',
    'start /fake/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000',
  ]);

  const no = machine({ tools: ['brew'] });
  await assert.rejects(startTunnel(no.options({ interactive: true, answer: 'n' })), NeedsYou);
  assert.deepEqual(no.events, [], 'nothing was installed');

  const failed = machine({ tools: ['brew'], brew: 1 });
  await assert.rejects(
    startTunnel(failed.options({ interactive: true, answer: 'yes' })),
    (error) => !(error instanceof NeedsYou) && /cloudflared wasn't installed \(Homebrew exited 1\)/.test(error.message),
  );

  // No Homebrew: nothing to offer, so it says how and stops, without a question.
  const noBrew = machine({ tools: [] });
  await assert.rejects(startTunnel(noBrew.options({ interactive: true, answer: 'y' })), NeedsYou);
  assert.deepEqual(noBrew.asked, []);
});

// ── dev ─────────────────────────────────────────────────────────────────────

/**
 * An app folder and everything `dev` touches, each step recorded in order.
 *   `serverUp`   whether the server's port answers: 'after-start' (default), 'already', 'never'
 *   `serverExit` the code the server stops with, before it answers (a number) or never
 *   `point`      what a channel's point returns
 */
async function app({
  deps = { '@voiceflow/channels-sdk': '*', '@voiceflow/channels-slack': '*' },
  serverUp = 'after-start',
  serverExit,
  point = 0,
  tunnel = machine(),
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'vf-dev-'));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: deps }));
  const events = tunnel.events;
  const out = [];
  const err = [];
  let started = false;
  let stopServer = () => {};
  const stop = new AbortController();
  const io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd,
    env: {},
    interactive: false,
    tunnel: tunnel.host,
    serve: (command, args, env) => {
      events.push(`serve ${[command, ...args].join(' ')} PORT=${env.PORT}`);
      started = true;
      const exited = new Promise((resolve) => {
        stopServer = () => resolve(0);
        if (serverExit !== undefined) queueMicrotask(() => resolve(serverExit));
      });
      return {
        exited,
        stop: async () => {
          events.push('stop server');
          stopServer();
        },
      };
    },
    channel: async (name) => async (argv) => {
      events.push(`${name}: ${argv.join(' ')}`);
      const code = typeof point === 'function' ? point(name) : point;
      // Once every channel is pointed, the test's Ctrl-C.
      queueMicrotask(() => stop.abort());
      return code;
    },
    fetch: async (url, init) => {
      const local = String(url).startsWith('http://127.0.0.1:');
      if (!local) return tunnel.host.fetch(url, init);
      const up = serverUp === 'already' || (serverUp === 'after-start' && started && serverExit === undefined);
      if (String(url).includes('/api/')) events.push(`warm ${init?.method} ${url}`);
      if (!up) throw new Error('ECONNREFUSED');
      return new Response('ok');
    },
    wait: async () => {},
    signal: stop.signal,
  };
  return { io, events, out, err, stop };
}

test('dev opens a tunnel, starts the server, and points each channel at it once the server answers, in that order', async () => {
  const a = await app();
  const code = await dev(['--env-file', '.env.local', '--', 'next', 'dev'], a.io);
  assert.equal(code, 0, a.err.join('\n'));
  assert.deepEqual(a.events, [
    'start /fake/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000',
    `dns ${new URL(URL_).hostname}`,
    `probe ${URL_}`,
    'serve next dev PORT=3000',
    // The channel is told where the server is here, to check it before its platform is pointed at it.
    `slack: point --public-url ${URL_} --local-url http://127.0.0.1:3000 --env-file .env.local`,
    'stop server',
    'stop tunnel',
  ]);
  assert.match(a.out.join('\n'), new RegExp(`tunnel: ${URL_} → http://127\\.0\\.0\\.1:3000`));
  assert.match(a.out.join('\n'), new RegExp(`slack: pointed at ${URL_}\\. Stop with Ctrl-C\\.`));
});

test('dev takes the port, the channels and an address of your own from its options', async () => {
  const a = await app({ deps: { '@voiceflow/channels-sdk': '*' } });
  const code = await dev(
    ['--port', '8080', '--public-url', 'https://bot.example.com/', '--channel', 'slack', '--channel', 'whatsapp', '--', 'node', 'server.js'],
    a.io,
  );
  assert.equal(code, 0, a.err.join('\n'));
  assert.deepEqual(a.events, [
    'serve node server.js PORT=8080',
    'slack: point --public-url https://bot.example.com --local-url http://127.0.0.1:8080',
    'whatsapp: point --public-url https://bot.example.com --local-url http://127.0.0.1:8080',
    'stop server',
  ]);

  // Without a command, the server is the one already there.
  const there = await app({ serverUp: 'already' });
  assert.equal(await dev([], there.io), 0, there.err.join('\n'));
  assert.ok(!there.events.some((e) => e.startsWith('serve')));
  assert.ok(there.events.includes(`slack: point --public-url ${URL_} --local-url http://127.0.0.1:3000`));
  assert.equal(there.events.at(-1), 'stop tunnel');
});

test("a channel that can't be pointed stops dev with its exit code, and the server and tunnel with it", async () => {
  const waiting = await app({ point: 3 });
  assert.equal(await dev(['--', 'next', 'dev'], waiting.io), 3);
  assert.match(waiting.err.join('\n'), new RegExp(`slack wasn't pointed at ${URL_}, so dev is stopping\\.`));
  assert.deepEqual(waiting.events.slice(-2), ['stop server', 'stop tunnel']);

  // The second channel isn't tried once the first fails.
  const two = await app({ deps: { '@voiceflow/channels-slack': '*', '@voiceflow/channels-teams': '*' }, point: 1 });
  assert.equal(await dev(['--', 'next', 'dev'], two.io), 1);
  assert.ok(!two.events.some((e) => e.startsWith('teams:')));
});

test("dev says what's wrong with the server's port before it points anything at it", async () => {
  const stopped = await app({ serverExit: 7 });
  assert.equal(await dev(['--', 'next', 'dev'], stopped.io), 7);
  assert.match(stopped.err.join('\n'), /The server's command stopped before it answered on port 3000 \(exit 7\)\./);
  assert.ok(!stopped.events.some((e) => e.startsWith('slack:')));
  assert.equal(stopped.events.at(-1), 'stop tunnel');

  const taken = await app({ serverUp: 'already' });
  assert.equal(await dev(['--', 'next', 'dev'], taken.io), 1);
  assert.match(taken.err.join('\n'), /Something already answers on port 3000\./);
  assert.deepEqual(taken.events, [], 'no tunnel, no second server');

  const nothing = await app({ serverUp: 'never' });
  assert.equal(await dev([], nothing.io), 1);
  assert.match(nothing.err.join('\n'), /Nothing answers on port 3000\. Start your server there, or give dev its command/);
  assert.deepEqual(nothing.events, []);
});

test('dev with no channel, no cloudflared or a bad option says so, and starts nothing', async () => {
  const none = await app({ deps: { '@voiceflow/channels-sdk': '*', next: '16' } });
  assert.equal(await dev(['--', 'next', 'dev'], none.io), 2);
  assert.match(none.err.join('\n'), /No channel to point: this app depends on no @voiceflow\/channels-\* package/);
  assert.deepEqual(none.events, []);

  const bare = await app({ tunnel: machine({ tools: [] }) });
  assert.equal(await dev(['--', 'next', 'dev'], bare.io), 3, 'waiting on a person');
  assert.match(bare.err.join('\n'), /It needs cloudflared, which isn't installed\./);
  assert.match(bare.err.join('\n'), /Or start no tunnel, and give dev your own address: --public-url https:\/\/<host>\.$/);
  assert.ok(!bare.events.some((e) => e.startsWith('serve')));

  for (const [argv, said] of [
    [['next', 'dev'], /dev takes your server's command after "--": voiceflow-channels dev -- next dev/],
    [['--port', 'eighty', '--', 'next', 'dev'], /"eighty" isn't a port\./],
    [['--channel', '../etc', '--', 'next', 'dev'], /A channel's name is lowercase letters, digits and "-"/],
  ]) {
    const a = await app();
    assert.equal(await dev(argv, a.io), 2);
    assert.match(a.err.join('\n'), said);
    assert.deepEqual(a.events, []);
  }
  const help = await app();
  assert.equal(await dev(['--help'], help.io), 0);
  assert.match(help.out.join('\n'), /voiceflow-channels dev \[options\] -- <your server's command>/);
});

test("a server that stops on its own ends dev with the server's code", async () => {
  const a = await app({ point: 0 });
  // The test's Ctrl-C never comes: the server is what ends it.
  const never = new AbortController();
  a.io.signal = never.signal;
  let end;
  a.io.serve = (command, args, env) => {
    a.events.push(`serve ${[command, ...args].join(' ')} PORT=${env.PORT}`);
    const exited = new Promise((resolve) => {
      end = resolve;
    });
    return { exited, stop: async () => a.events.push('stop server') };
  };
  let up = false;
  const fetch = a.io.fetch;
  a.io.fetch = async (url, init) =>
    String(url).startsWith('http://127.0.0.1:') ? (up ? new Response('ok') : Promise.reject(new Error('ECONNREFUSED'))) : fetch(url, init);
  a.io.wait = async () => {
    up = true;
  };
  a.io.channel = async () => async () => {
    queueMicrotask(() => end(5));
    return 0;
  };
  assert.equal(await dev(['--', 'next', 'dev'], a.io), 5);
  assert.deepEqual(a.events.slice(-2), ['stop server', 'stop tunnel']);
});

test('a channel that was never connected is connected first, for a person who is there, and then started', async () => {
  /** A channel that isn't connected until its connect has run. */
  const channelOf = (a, { connect = 0 } = {}) => {
    let isConnected = false;
    return async (name) => ({
      connected: ({ envFile, env }) => {
        a.events.push(`${name} connected? (${envFile}, ${Object.keys(env).length} in env)`);
        return isConnected;
      },
      cli: async (argv) => {
        a.events.push(`${name}: ${argv.join(' ')}`);
        if (argv[0] === 'connect') {
          isConnected = connect === 0;
          return connect;
        }
        queueMicrotask(() => a.stop.abort());
        return 0;
      },
    });
  };
  const a = await app();
  a.io.interactive = true;
  a.io.channel = channelOf(a);
  assert.equal(await dev(['--env-file', '.env.local', '--', 'next', 'dev'], a.io), 0, a.err.join('\n'));
  // Connect comes before anything is started: the server then starts with what connect wrote.
  assert.deepEqual(a.events.slice(0, 3), [
    'slack connected? (.env.local, 0 in env)',
    'slack: connect --from-dev --env-file .env.local',
    'start /fake/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000',
  ]);
  assert.ok(a.events.includes(`slack: point --public-url ${URL_} --local-url http://127.0.0.1:3000 --env-file .env.local`));
  assert.match(a.out.join('\n'), /slack isn't connected yet, so that comes first\./);

  // A connect that waits on the person stops dev with its code, and nothing was started.
  const waits = await app();
  waits.io.interactive = true;
  waits.io.channel = channelOf(waits, { connect: 3 });
  assert.equal(await dev(['--env-file', '.env.local', '--', 'next', 'dev'], waits.io), 3);
  assert.deepEqual(waits.events, ['slack connected? (.env.local, 0 in env)', 'slack: connect --from-dev --env-file .env.local']);
  assert.match(waits.err.join('\n'), /slack wasn't connected, so dev is stopping\./);

  // With nobody there, connect is not run: point says what's missing, as before.
  const script = await app();
  script.io.channel = channelOf(script);
  await dev(['--env-file', '.env.local', '--', 'next', 'dev'], script.io);
  assert.ok(!script.events.some((e) => /connect/.test(e)), script.events.join('\n'));

  // A server that is running already was started without what connect writes: connect is not run for it.
  const running = await app({ serverUp: 'already' });
  running.io.interactive = true;
  running.io.channel = channelOf(running);
  await dev(['--env-file', '.env.local'], running.io);
  assert.ok(!running.events.some((e) => /connect/.test(e)), running.events.join('\n'));

  // A channel that is connected is asked, and left alone.
  const done = await app();
  done.io.interactive = true;
  done.io.channel = async (name) => ({
    connected: () => true,
    cli: async (argv) => {
      done.events.push(`${name}: ${argv.join(' ')}`);
      queueMicrotask(() => done.stop.abort());
      return 0;
    },
  });
  assert.equal(await dev(['--', 'next', 'dev'], done.io), 0);
  assert.ok(!done.events.some((e) => /connect/.test(e)));
});

test("dev holds a channel's standing connection open beside the server, and closes it first when it stops", async () => {
  const a = await app();
  const heard = [];
  a.io.channel = async (name) => ({
    cli: async (argv) => {
      a.events.push(`${name}: ${argv.join(' ')}`);
      return 0;
    },
    listen: ({ localUrl, envFile, signal }) =>
      new Promise((resolve) => {
        a.events.push(`${name} listens for ${localUrl} (${envFile})`);
        heard.push(signal);
        signal.addEventListener('abort', () => {
          a.events.push(`${name} stops listening`);
          resolve();
        });
        // Once it's listening, the test's Ctrl-C.
        queueMicrotask(() => a.stop.abort());
      }),
  });
  assert.equal(await dev(['--env-file', '.env.local', '--', 'next', 'dev'], a.io), 0, a.err.join('\n'));
  assert.deepEqual(a.events.slice(-5), [
    `slack: point --public-url ${URL_} --local-url http://127.0.0.1:3000 --env-file .env.local`,
    'slack listens for http://127.0.0.1:3000 (.env.local)',
    'slack stops listening',
    'stop server',
    'stop tunnel',
  ]);
  assert.equal(heard[0].aborted, true);

  // A connection that drops while dev runs stops dev: nothing would arrive, and saying nothing would hide it.
  const dropped = await app();
  const never = new AbortController();
  dropped.io.signal = never.signal;
  dropped.io.channel = async () => ({ cli: async () => 0, listen: async () => Promise.reject(new Error('Discord closed the connection: 4004')) });
  assert.equal(await dev(['--', 'next', 'dev'], dropped.io), 1);
  assert.match(dropped.err.join('\n'), /slack lost its connection, so dev is stopping: Discord closed the connection: 4004/);
  assert.deepEqual(dropped.events.slice(-2), ['stop server', 'stop tunnel']);
});
