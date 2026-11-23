// The starter, run as `npm create voiceflow-channels` runs it, into a temporary
// folder: what it writes, what it refuses, and what it runs. Nothing is
// installed and no git repository is made: the commands it would run are recorded.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { create, packageManagerOf } from '../dist/index.js';

const EXAMPLE = new URL('../../../examples/nextjs-slack/', import.meta.url);
const read = (dir, path) => readFile(join(dir, path), 'utf8');

/** Runs the starter in a new folder. `codes` are the exit codes of the commands it runs, by command name. */
async function start(argv, { codes = {}, env = {}, interactive = false, ask, files = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'vf-create-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  const out = [];
  const err = [];
  const ran = [];
  const code = await create(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    cwd,
    env,
    interactive,
    ask,
    run: async (command, args, where) => {
      ran.push({ command, args, where });
      // Not inside a repository, unless a test says so.
      return codes[`${command} ${args[0]}`] ?? (command === 'git' && args[0] === 'rev-parse' ? 128 : 0);
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n'), ran, cwd, app: join(cwd, argv.find((a) => !a.startsWith('-')) ?? 'my-bot') };
}
/** Every file under a folder, as paths from it. */
async function tree(dir, prefix = '') {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(...(await tree(join(dir, entry.name), `${prefix}${entry.name}/`)));
    else paths.push(`${prefix}${entry.name}`);
  }
  return paths.sort();
}

test('one command makes the app: its route, its env files, and nothing else', async () => {
  const { code, out, err, app } = await start(['my-bot']);
  assert.equal(code, 0, err);
  assert.deepEqual(await tree(app), [
    '.env.example',
    '.env.local',
    '.gitignore',
    'README.md',
    'app/api/slack/route.ts',
    'app/layout.tsx',
    'app/page.tsx',
    'next.config.ts',
    'package.json',
    'tsconfig.json',
  ]);
  assert.match(out, /Created my-bot: a Voiceflow agent in Slack/);
  assert.match(out, /cd my-bot/);
  assert.match(out, /npm run connect -- --public-url https:\/\/<your tunnel>/);
  assert.match(out, /It asks for your Voiceflow API key and project ID, and saves them in \.env\.local\./);
  assert.doesNotMatch(out, /--project|--environment/, 'the env file says which agent: nothing to repeat on the command line');
  assert.match(await read(app, 'README.md'), /^# my-bot\n/);
});

test('the app it writes is the example app, which CI builds, with the versions that app is tested with', async () => {
  const { app } = await start(['my-bot']);
  // One copy of the app: a change to the example is a change to what the starter makes.
  for (const path of ['app/api/slack/route.ts', 'app/layout.tsx', 'app/page.tsx', 'next.config.ts', 'tsconfig.json']) {
    assert.equal(await read(app, path), await readFile(new URL(path, EXAMPLE), 'utf8'), path);
  }
  const example = JSON.parse(await readFile(new URL('package.json', EXAMPLE), 'utf8'));
  const own = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await read(app, 'package.json'));
  assert.equal(pkg.name, 'my-bot');
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.scripts, example.scripts);
  assert.equal(pkg.scripts.connect, 'voiceflow-channels connect slack --env-file .env.local', "connect runs the app's own copy of the command");
  assert.deepEqual(Object.keys(pkg.dependencies), Object.keys(example.dependencies));
  assert.deepEqual(Object.keys(pkg.devDependencies), Object.keys(example.devDependencies));
  for (const [dep, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const tested = { ...example.dependencies, ...example.devDependencies }[dep];
    // This project's packages come at the starter's own version: they are released together.
    assert.equal(version, dep.startsWith('@voiceflow/channels-') ? `^${own.version}` : `^${tested}`, dep);
    assert.match(version, /^\^\d+\.\d+\.\d+/, `${dep} is a version on npm, not a link into a repository`);
  }
});

test('the env files list what the server needs, hold no secret, and yours is readable only by you', async () => {
  const { app, out } = await start(['my-bot', '--project', '64f0c0ffee', '--environment', 'production']);
  const example = await read(app, '.env.example');
  const local = await read(app, '.env.local');
  for (const key of ['VOICEFLOW_API_KEY', 'VOICEFLOW_PROJECT_ID', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'REDIS_URL']) {
    assert.match(example, new RegExp(`^${key}=$`, 'm'), `${key} is listed, empty`);
  }
  assert.match(example, /^VOICEFLOW_ENVIRONMENT=production$/m);
  assert.match(local, /^VOICEFLOW_PROJECT_ID=64f0c0ffee$/m);
  assert.match(local, /^VOICEFLOW_API_KEY=$/m, 'the key is yours to add: the starter never asks for one');
  assert.equal((await stat(join(app, '.env.local'))).mode & 0o777, 0o600);
  // Git never sees it.
  const ignored = await read(app, '.gitignore');
  assert.match(ignored, /^\.env\.\*$/m);
  assert.match(ignored, /^!\.env\.example$/m);
  assert.match(out, /It asks for your Voiceflow API key, and saves it in \.env\.local\./, 'the project is in the env file already');
  assert.match(out, /Publish the production environment in Voiceflow/);
  assert.match(await read(app, 'README.md'), /Publish the agent's `production` environment/);
});

test("it installs with the package manager that ran it, and starts a repository unless it's inside one", async () => {
  const npm = await start(['my-bot']);
  assert.deepEqual(
    npm.ran.map((r) => [r.command, ...r.args]),
    [
      ['git', 'rev-parse', '--is-inside-work-tree'],
      ['git', 'init', '--quiet'],
      ['npm', 'install'],
    ],
  );
  assert.ok(
    npm.ran.every((r) => r.where === npm.app),
    'every command runs in the new app',
  );

  const pnpm = await start(['my-bot'], { env: { npm_config_user_agent: 'pnpm/10.4.0 npm/? node/v24.1.0 darwin arm64' } });
  assert.deepEqual(pnpm.ran.at(-1).args.concat(pnpm.ran.at(-1).command), ['install', 'pnpm']);
  assert.match(pnpm.out, /pnpm connect --public-url https:/);
  assert.match(pnpm.out, /pnpm run dev/);
  const bun = await start(['my-bot', '--pm', 'bun'], { env: { npm_config_user_agent: 'npm/11.0.0' } });
  assert.equal(bun.ran.at(-1).command, 'bun', '--pm says otherwise');
  assert.match(bun.out, /bun run connect --public-url https:/);
  assert.equal(packageManagerOf('yarn/4.6.0 npm/? node/v22.11.0'), 'yarn');
  assert.equal(packageManagerOf(undefined), 'npm');
  assert.equal(packageManagerOf('deno/2.0'), 'npm');

  const inside = await start(['my-bot'], { codes: { 'git rev-parse': 0 } });
  assert.ok(!inside.ran.some((r) => r.args[0] === 'init'), 'no repository inside a repository');

  const bare = await start(['my-bot', '--skip-install', '--no-git']);
  assert.deepEqual(bare.ran, []);
  assert.match(bare.out, /^ {2}npm install$/m, 'installing is the first thing left to do');
});

test('a failed install leaves the app in place and says what to run', async () => {
  const { code, err, out, app } = await start(['my-bot'], { codes: { 'npm install': 1 } });
  assert.equal(code, 1);
  assert.match(err, /npm install didn't finish \(exit 1\)\. The app is in my-bot: run npm install there yourself\./);
  assert.match(out, /^ {2}npm install$/m);
  assert.ok((await tree(app)).includes('package.json'));
});

test("it writes only into an empty folder unless told to, and never deletes what's there", async () => {
  const full = await start(['my-bot'], { files: { 'my-bot/notes.txt': 'mine', 'my-bot/.env.local': 'VOICEFLOW_API_KEY=already-here\n' } });
  assert.equal(full.code, 2);
  assert.match(full.err, /my-bot isn't empty\. Name another folder, or pass --force/);
  assert.deepEqual(await tree(full.app), ['.env.local', 'notes.txt'], 'nothing was written');
  assert.deepEqual(full.ran, []);

  const forced = await start(['my-bot', '--force'], { files: { 'my-bot/notes.txt': 'mine', 'my-bot/.env.local': 'VOICEFLOW_API_KEY=already-here\n' } });
  assert.equal(forced.code, 0);
  assert.equal(await read(forced.app, 'notes.txt'), 'mine');
  assert.equal(await read(forced.app, '.env.local'), 'VOICEFLOW_API_KEY=already-here\n', "an env file that's already there is yours");
  assert.ok((await tree(forced.app)).includes('app/api/slack/route.ts'));

  // A folder holding only a fresh git repository counts as empty.
  const cloned = await start(['my-bot'], { files: { 'my-bot/.git/HEAD': 'ref: refs/heads/main\n' } });
  assert.equal(cloned.code, 0);
});

test('a name that can be a package, or the default: a person is asked, a script never is', async () => {
  const asked = [];
  const person = await start([], {
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      return 'support-bot';
    },
  });
  assert.deepEqual(asked, ['What should the app be called? (my-bot) ']);
  assert.match(person.out, /Created support-bot/);

  const script = await start([], {
    ask: async () => {
      throw new Error('a script was asked a question');
    },
  });
  assert.match(script.out, /Created my-bot/);
  const yes = await start(['--yes'], {
    interactive: true,
    ask: async () => {
      throw new Error('--yes asked a question');
    },
  });
  assert.match(yes.out, /Created my-bot/);

  const nested = await start(['apps/support-bot']);
  assert.equal(JSON.parse(await read(join(nested.cwd, 'apps/support-bot'), 'package.json')).name, 'support-bot');
  assert.match(nested.out, /cd apps\/support-bot/);

  const spaced = await start(['My Bot']);
  assert.equal(spaced.code, 2);
  assert.match(spaced.err, /"My Bot" can't be the app's name: .*Try my-bot\./);
  assert.deepEqual(await readdir(spaced.cwd), [], 'and nothing was made');
});

test('a mistake in the command is an answer and an exit code, with nothing written', async () => {
  for (const [argv, said] of [
    [['my-bot', '--channel', 'teams'], /There's no starter for "teams" yet/],
    [['my-bot', '--pm', 'pip'], /--pm is one of npm, pnpm, yarn, bun, not "pip"/],
    [['my-bot', '--project', 'abc\nSLACK_BOT_TOKEN=x'], /--project is letters, digits/],
    [['my-bot', '--environment', '$(rm -rf ~)'], /--environment is letters, digits/],
    [['my-bot', 'another'], /One name at a time/],
    [['my-bot', '--no-such-flag'], /no-such-flag/],
  ]) {
    const { code, err, cwd, ran } = await start(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, said);
    assert.deepEqual(await readdir(cwd), [], `${argv.join(' ')} wrote something`);
    assert.deepEqual(ran, []);
  }
  const help = await start(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /^Usage:\n {2}npm create voiceflow-channels@latest \[name\]/);
  assert.deepEqual(await readdir(help.cwd), []);
});

test('--quiet prints only what to do next', async () => {
  const { out } = await start(['my-bot', '--quiet']);
  assert.doesNotMatch(out, /Created|Installing/);
  assert.match(out, /Next:/);
});
