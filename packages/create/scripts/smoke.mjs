// The starter, end to end, the way someone meets it: the command makes an app,
// the app installs the packages as npm would deliver them (packed tarballs, not
// links into this repository), builds, and answers its channel. Once for each
// channel the starter has: Slack, Discord and Teams. It catches what the
// unit tests can't: a file missing from a package, an export that doesn't
// resolve, a generated app that doesn't compile.
//
//   npm run build && node packages/create/scripts/smoke.mjs [--keep] [slack|discord|teams]
//
// It installs from the npm registry (Next.js, React, Chat SDK), so it needs the
// network, and takes a minute or two. Nothing here is a real credential.
import { execFile, spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const keep = process.argv.includes('--keep');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const work = await mkdtemp(join(tmpdir(), 'vf-starter-smoke-'));
const step = (text) => console.log(`\n▸ ${text}`);
const SIGNING_SECRET = 'smoke-test-signing-secret';
const DISCORD_TOKEN = 'smoke-test-discord-token';
const discordKeys = generateKeyPairSync('ed25519');
let server;

/** What differs by channel: its package, what its server is given, and what its platform sends. */
const CHANNELS = {
  slack: {
    env: { SLACK_BOT_TOKEN: 'xoxb-smoke-test', SLACK_SIGNING_SECRET: SIGNING_SECRET },
    help: /voiceflow-channels connect slack \[--public-url/,
    check: checkSlack,
  },
  discord: {
    env: {
      DISCORD_BOT_TOKEN: DISCORD_TOKEN,
      DISCORD_PUBLIC_KEY: discordKeys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
      DISCORD_APPLICATION_ID: '111111111111111111',
      CRON_SECRET: 'smoke-test-cron-secret',
    },
    help: /voiceflow-channels connect discord \[--public-url/,
    check: checkDiscord,
  },
  teams: {
    env: {
      TEAMS_APP_ID: '11111111-1111-4111-8111-111111111111',
      TEAMS_APP_PASSWORD: 'smoke-test-teams-secret',
      TEAMS_APP_TENANT_ID: '22222222-2222-4222-8222-222222222222',
    },
    help: /voiceflow-channels connect teams --env-file <path> \[--public-url/,
    check: checkTeams,
  },
};

try {
  step('pack the packages, as a publish would');
  await run('npm', ['pack', '--pack-destination', work, '-w', 'packages/core', '-w', 'packages/slack', '-w', 'packages/discord', '-w', 'packages/teams'], {
    cwd: root,
  });
  const tarballs = (await readdir(work)).filter((f) => f.endsWith('.tgz'));
  const tarball = (name) => {
    const file = tarballs.find((f) => f.startsWith(`${name}-`));
    if (!file) throw new Error(`no tarball for ${name} among ${tarballs.join(', ')}`);
    return `file:${join(work, file)}`;
  };
  for (const channel of Object.keys(CHANNELS).filter((name) => !only.length || only.includes(name))) {
    await smoke(channel, {
      '@voiceflow/channels-sdk': tarball('voiceflow-channels-sdk'),
      [`@voiceflow/channels-${channel}`]: tarball(`voiceflow-channels-${channel}`),
    });
  }
  console.log('\n✓ the starter makes apps that install, build and answer their channels');
} finally {
  await stop();
  if (keep) console.log(`kept: ${work}`);
  else await rm(work, { recursive: true, force: true });
}

async function stop() {
  if (server && server.exitCode === null) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
    await new Promise((resolve) => server.once('close', resolve));
  }
  server = undefined;
}

async function smoke(channel, packed) {
  const { env: channelEnv, help: helpText, check } = CHANNELS[channel];
  step(`${channel}: run the starter`);
  const { stdout } = await run(
    process.execPath,
    [join(root, 'packages/create/dist/cli.js'), `smoke-${channel}`, '--channel', channel, '--skip-install', '--no-git', '--project', 'smoke-project'],
    {
      cwd: work,
    },
  );
  console.log(stdout.trim());
  const app = join(work, `smoke-${channel}`);

  step('point the app at the packed packages');
  const pkgPath = join(app, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  for (const name of Object.keys(packed)) {
    if (!pkg.dependencies[name]) throw new Error(`the app doesn't depend on ${name}`);
    pkg.dependencies[name] = packed[name];
  }
  // The channel's package asks for the core by version; this is that version.
  pkg.overrides = { '@voiceflow/channels-sdk': packed['@voiceflow/channels-sdk'] };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  step('npm install');
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: app, maxBuffer: 64 * 1024 * 1024 });

  step("the app's own connect command runs from the installed package");
  const help = await run('npm', ['run', '--silent', 'connect', '--', '--help'], { cwd: app });
  if (!helpText.test(help.stdout)) throw new Error(`connect --help printed:\n${help.stdout}`);
  // dev is the same package's command: its help runs without a tunnel or a server.
  const dev = await run('npx', ['--no-install', 'voiceflow-channels', 'dev', '--help'], { cwd: app });
  if (!/voiceflow-channels dev \[options\] -- <your server's command>/.test(dev.stdout)) throw new Error(`dev --help printed:\n${dev.stdout}`);

  step('typecheck and build');
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  await run('npm', ['run', 'build'], { cwd: app, env, maxBuffer: 64 * 1024 * 1024 });
  await run('npm', ['run', 'typecheck'], { cwd: app, env, maxBuffer: 64 * 1024 * 1024 });

  step(`start it, and send what ${channel} sends`);
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  server = spawn('npx', ['next', 'start', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: app,
    env: {
      ...env,
      VOICEFLOW_API_KEY: 'smoke-test-key',
      VOICEFLOW_PROJECT_ID: 'smoke-project',
      ...channelEnv,
    },
    stdio: 'pipe',
    detached: true,
  });
  let log = '';
  server.stdout.on('data', (chunk) => (log += chunk));
  server.stderr.on('data', (chunk) => (log += chunk));
  const url = `http://127.0.0.1:${port}/api/${channel}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (/Ready in|Local:/.test(log)) break;
    if (server.exitCode !== null) throw new Error(`the server stopped:\n${log}`);
    if (Date.now() > deadline) throw new Error(`the server didn't start in a minute:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  await check(url, () => log);
  await stop();
}

async function checkSlack(url, log) {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'smoke-challenge' });
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = (secret) => ({
    'content-type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`,
  });
  const genuine = await fetch(url, { method: 'POST', headers: signed(SIGNING_SECRET), body });
  const answer = await genuine.text();
  if (genuine.status !== 200 || !answer.includes('smoke-challenge'))
    throw new Error(`a signed Slack check got ${genuine.status}: ${answer.slice(0, 200)}\n${log()}`);
  const forged = await fetch(url, { method: 'POST', headers: signed('not-the-secret'), body });
  if (forged.status !== 401) throw new Error(`a forged Slack request got ${forged.status}, not 401`);
  // A tool's call with no pass, at the same address: refused by the tools' own check.
  const tool = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-voiceflow-tool-call': '1' },
    body: JSON.stringify({ tool: 'slack_pin_message', input: {} }),
  });
  if (tool.status !== 401) throw new Error(`a tool call without a pass got ${tool.status}, not 401`);
  console.log('signed check 200 · forged 401 · tool call without a pass 401');
}

async function checkDiscord(url, log) {
  // Discord signs what it sends with the application's key: the server has the public half.
  const signed = (payload, key = discordKeys.privateKey) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), key).toString('hex'),
        'x-signature-timestamp': timestamp,
      },
      body,
    };
  };
  const ping = { type: 1, id: '1', application_id: '111111111111111111', token: 't', version: 1 };
  const genuine = await fetch(url, signed(ping));
  const answer = await genuine.text();
  if (genuine.status !== 200 || !/"type":\s*1/.test(answer)) throw new Error(`Discord's signed check got ${genuine.status}: ${answer.slice(0, 200)}\n${log()}`);
  const forged = await fetch(url, signed(ping, generateKeyPairSync('ed25519').privateKey));
  if (forged.status !== 401) throw new Error(`a forged Discord request got ${forged.status}, not 401`);
  // What people write is passed on from Discord's standing connection, with the bot's token: taken only with the server's own.
  const event = (token) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-discord-gateway-token': token },
      body: JSON.stringify({ type: 'GATEWAY_CHANNELS_SDK_CHECK', timestamp: Date.now(), data: {} }),
    });
  const passed = await event(DISCORD_TOKEN);
  if (passed.status !== 200) throw new Error(`an event passed on with the bot's token got ${passed.status}\n${log()}`);
  const refused = await event('not-the-token');
  if (refused.status !== 401) throw new Error(`an event passed on with another token got ${refused.status}, not 401`);
  // The route that holds the connection for a deployment starts one only for the scheduler that knows its secret.
  const gateway = await fetch(`${url}/gateway`);
  if (gateway.status !== 401) throw new Error(`the gateway route without its secret got ${gateway.status}, not 401`);
  console.log('signed check 200 · forged 401 · event with the token 200 · with another 401 · gateway route without its secret 401');
}

async function checkTeams(url, log) {
  // Teams signs what it sends with a token of Microsoft's, which nothing here can make: so what's checked is
  // that the route is there, runs the adapter, and takes nothing that isn't Microsoft's.
  const send = (headers = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ type: 'message', text: 'hello', from: { id: '29:someone' }, conversation: { id: 'a:1' } }),
    });
  const bare = await send();
  if (bare.status !== 401) throw new Error(`a Teams request with no token got ${bare.status}, not 401\n${log()}`);
  const forged = await send({ authorization: 'Bearer not-a-token-of-microsofts' });
  if (forged.status !== 401) throw new Error(`a Teams request with a made-up token got ${forged.status}, not 401\n${log()}`);
  console.log('no token 401 · a made-up token 401');
}
