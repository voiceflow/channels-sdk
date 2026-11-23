// The starter, end to end, the way someone meets it: the command makes an app,
// the app installs the packages as npm would deliver them (packed tarballs, not
// links into this repository), builds, and answers Slack. It catches what the
// unit tests can't: a file missing from a package, an export that doesn't
// resolve, a generated app that doesn't compile.
//
//   npm run build && node packages/create/scripts/smoke.mjs [--keep]
//
// It installs from the npm registry (Next.js, React, Chat SDK), so it needs the
// network, and takes a minute or two. Nothing here is a real credential.
import { execFile, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const keep = process.argv.includes('--keep');
const work = await mkdtemp(join(tmpdir(), 'vf-starter-smoke-'));
const step = (text) => console.log(`\n▸ ${text}`);
const SIGNING_SECRET = 'smoke-test-signing-secret';
let server;

try {
  step('pack the packages, as a publish would');
  await run('npm', ['pack', '--pack-destination', work, '-w', 'packages/core', '-w', 'packages/slack'], { cwd: root });
  const tarballs = (await readdir(work)).filter((f) => f.endsWith('.tgz'));
  const tarball = (name) => {
    const file = tarballs.find((f) => f.startsWith(`${name}-`));
    if (!file) throw new Error(`no tarball for ${name} among ${tarballs.join(', ')}`);
    return `file:${join(work, file)}`;
  };
  const packed = { '@voiceflow/channels-sdk': tarball('voiceflow-channels-sdk'), '@voiceflow/channels-slack': tarball('voiceflow-channels-slack') };

  step('run the starter');
  const { stdout } = await run(
    process.execPath,
    [join(root, 'packages/create/dist/cli.js'), 'smoke-app', '--skip-install', '--no-git', '--project', 'smoke-project'],
    {
      cwd: work,
    },
  );
  console.log(stdout.trim());
  const app = join(work, 'smoke-app');

  step('point the app at the packed packages');
  const pkgPath = join(app, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  for (const name of Object.keys(packed)) {
    if (!pkg.dependencies[name]) throw new Error(`the app doesn't depend on ${name}`);
    pkg.dependencies[name] = packed[name];
  }
  // The Slack package asks for the core by version; this is that version.
  pkg.overrides = { '@voiceflow/channels-sdk': packed['@voiceflow/channels-sdk'] };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  step('npm install');
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: app, maxBuffer: 64 * 1024 * 1024 });

  step("the app's own connect command runs from the installed package");
  const help = await run('npm', ['run', '--silent', 'connect', '--', '--help'], { cwd: app });
  if (!/voiceflow-channels connect slack --public-url/.test(help.stdout)) throw new Error(`connect --help printed:\n${help.stdout}`);

  step('typecheck and build');
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  await run('npm', ['run', 'build'], { cwd: app, env, maxBuffer: 64 * 1024 * 1024 });
  await run('npm', ['run', 'typecheck'], { cwd: app, env, maxBuffer: 64 * 1024 * 1024 });

  step('start it, and send what Slack sends');
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
      SLACK_BOT_TOKEN: 'xoxb-smoke-test',
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
    },
    stdio: 'pipe',
    detached: true,
  });
  let log = '';
  server.stdout.on('data', (chunk) => (log += chunk));
  server.stderr.on('data', (chunk) => (log += chunk));
  const url = `http://127.0.0.1:${port}/api/slack`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (/Ready in|Local:/.test(log)) break;
    if (server.exitCode !== null) throw new Error(`the server stopped:\n${log}`);
    if (Date.now() > deadline) throw new Error(`the server didn't start in a minute:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }

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
    throw new Error(`a signed Slack check got ${genuine.status}: ${answer.slice(0, 200)}\n${log}`);
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

  console.log('\n✓ the starter makes an app that installs, builds and answers Slack');
} finally {
  if (server && server.exitCode === null) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  if (keep) console.log(`kept: ${work}`);
  else await rm(work, { recursive: true, force: true });
}
