// `npm create voiceflow-channels@latest my-bot`: a new app for a Voiceflow
// agent in Slack or Discord, ready for `connect`. It writes a small Next.js app
// (the channel's example app, which CI builds), a package.json with the versions
// that app is tested with, an env file, and the steps that come next.
//
// It writes only inside the folder you name, runs only your package manager's
// install and `git init`, and asks for no secret: the app's `connect` command
// asks for your Voiceflow API key, unseen, or you put it in .env.local yourself.
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discord } from './discord.js';
import { type ChannelStarter, PACKAGE_MANAGERS, type PackageManager } from './shared.js';
import { slack } from './slack.js';

export { PACKAGE_MANAGERS } from './shared.js';

/** What the command reads, writes and runs, for a test or a program that calls it: by default the console, this process and its folder. */
export interface CreateIO {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The folder a relative name is made in. */
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Whether a person is there to answer a question. */
  interactive?: boolean;
  /** Asks a question and returns the answer. */
  ask?: (question: string) => Promise<string>;
  /** Runs a command in a folder and returns its exit code. */
  run?: (command: string, args: string[], cwd: string) => Promise<number>;
}

export const CHANNELS = ['slack', 'discord'] as const;
const STARTERS: Record<(typeof CHANNELS)[number], ChannelStarter> = { slack, discord };

const DEFAULT_NAME = 'my-bot';
const TEMPLATES = new URL('../template/', import.meta.url);

const USAGE = `Usage:
  npm create voiceflow-channels@latest [name] [options]

Makes a new app for a Voiceflow agent in Slack or Discord: a Next.js server
with the route the channel calls, its env file, and a connect script that sets
the channel up.

Options:
  [name]                  the app's folder, and its name (default: ${DEFAULT_NAME})
  --channel <channel>     the channel to start with: slack (the default) or discord
  --project <id>          your Voiceflow project's ID, written to .env.local
  --environment <alias>   the Voiceflow environment the bot talks to (default: development)
  --pm <manager>          the package manager to install with: npm, pnpm, yarn or bun
                          (default: the one that ran this)
  -y, --yes               ask nothing and take the defaults
  -f, --force             write into a folder that isn't empty (nothing is deleted)
  -s, --skip-install      don't install the dependencies
  --no-git                don't start a git repository
  -q, --quiet             print only errors and what to do next
  -h, --help              show this`;

function defaultRun(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((done) => {
    // A package manager is a .cmd file on Windows, which needs a shell to run.
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

function defaultAsk(question: string): Promise<string> {
  return new Promise((answer) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (text) => {
      rl.close();
      answer(text.trim());
    });
  });
}

/** The package manager that ran this (`npm create`, `pnpm create`, …), from the agent string each one sets. */
export function packageManagerOf(userAgent: string | undefined): PackageManager {
  const name = (userAgent ?? '').split('/')[0];
  return (PACKAGE_MANAGERS as readonly string[]).includes(name ?? '') ? (name as PackageManager) : 'npm';
}

/** Why a name can't be a package's, or nothing when it can. */
function nameProblem(name: string): string | undefined {
  if (name.length > 214) return 'it is longer than 214 characters';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return 'a name is lowercase letters, digits, "-", "_" and ".", and starts with a letter or digit';
  return undefined;
}

async function isEmpty(dir: string): Promise<boolean> {
  try {
    // A folder that holds only a git repository, as one just cloned does, is still empty of files.
    return (await readdir(dir)).every((entry) => entry === '.git');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const GITIGNORE = `node_modules/
.next/
next-env.d.ts
*.tsbuildinfo
*.log

# Secrets. .env.example is the list of what goes in them.
.env
.env.*
!.env.example
`;

/** `KEY=value` set in an env file's text, on the key's own line. */
function setEnv(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, 'm');
  return line.test(text) ? text.replace(line, () => `${key}=${value}`) : `${text.replace(/\n*$/, '\n')}${key}=${value}\n`;
}

/** Runs the command. Returns its exit code: 0 when the app is made, 2 for a mistake in what was asked, 1 when a step failed. */
export async function create(argv: string[], io: CreateIO = {}): Promise<number> {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  const env = io.env ?? process.env;
  const run = io.run ?? defaultRun;

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: o, positionals } = parsed;
  if (o.help) {
    out(USAGE);
    return 0;
  }
  const say = o.quiet ? () => {} : out;
  if (positionals.length > 1) {
    err(`One name at a time: got ${positionals.join(', ')}.`);
    return 2;
  }
  if (!(CHANNELS as readonly string[]).includes(o.channel)) {
    err(
      `There's no starter for "${o.channel}" yet: there is one for ${CHANNELS.join(' and ')}. Any other Chat SDK adapter works with the core by hand: https://github.com/voiceflow/channels-sdk/blob/main/docs/how-it-works.md#any-chat-sdk-adapter`,
    );
    return 2;
  }
  if (o.pm !== undefined && !(PACKAGE_MANAGERS as readonly string[]).includes(o.pm)) {
    err(`--pm is one of ${PACKAGE_MANAGERS.join(', ')}, not "${o.pm}".`);
    return 2;
  }
  for (const [flag, value] of [
    ['--project', o.project],
    ['--environment', o.environment],
  ] as const) {
    // These go into an env file and a README: one word, nothing that could start a new line or a command.
    if (value !== undefined && !/^[\w.-]{1,128}$/.test(value)) {
      err(`${flag} is letters, digits, "-", "_" and ".", not "${value}".`);
      return 2;
    }
  }

  // A person is asked for a name; a script or a coding agent gets the default.
  const interactive = (io.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)) && !o.yes;
  let given = positionals[0];
  if (!given && interactive) given = await (io.ask ?? defaultAsk)(`What should the app be called? (${DEFAULT_NAME}) `);
  const target = resolve(io.cwd ?? process.cwd(), given || DEFAULT_NAME);
  const name = basename(target);
  const problem = nameProblem(name);
  if (problem) {
    const suggestion = name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '');
    err(`"${name}" can't be the app's name: ${problem}.${suggestion && !nameProblem(suggestion) ? ` Try ${suggestion}.` : ''}`);
    return 2;
  }
  if (!o.force && !(await isEmpty(target))) {
    err(`${relative(io.cwd ?? process.cwd(), target) || '.'} isn't empty. Name another folder, or pass --force to write into it (nothing in it is deleted).`);
    return 2;
  }

  const pm = (o.pm as PackageManager | undefined) ?? packageManagerOf(env.npm_config_user_agent);
  const environment = o.environment ?? 'development';
  const starter = STARTERS[o.channel as (typeof CHANNELS)[number]];
  const TEMPLATE = new URL(`${o.channel}/`, TEMPLATES);
  const app = JSON.parse(await readFile(new URL('app.json', TEMPLATE), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  const own = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  // This project's packages at the version this starter shipped with; everything else at the version the app was tested with, or a later compatible one.
  const versioned = (deps: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(deps).map(([dep, version]) => [dep, dep.startsWith('@voiceflow/channels-') ? `^${own.version}` : `^${version.replace(/^[\^~]/, '')}`]),
    );

  await mkdir(target, { recursive: true });
  // The app itself: its routes, its page, and its settings. Everything in the template but the two files read here.
  for (const entry of await readdir(TEMPLATE)) {
    if (entry === 'app.json' || entry === 'env.example') continue;
    await cp(fileURLToPath(new URL(entry, TEMPLATE)), join(target, entry), { recursive: true, force: true });
  }
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    description: `A Voiceflow agent in ${starter.label}, served by a Next.js route.`,
    engines: { node: '>=22' },
    scripts: app.scripts,
    dependencies: versioned(app.dependencies),
    devDependencies: versioned(app.devDependencies),
  };
  await writeFile(join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(join(target, '.gitignore'), GITIGNORE);
  await writeFile(join(target, 'README.md'), starter.readme(name, pm, environment));
  // For a coding agent asked to set the app up. Ones that are already there are yours, and are left as they are.
  const forAgents: [file: string, text: string][] = [
    ['AGENTS.md', starter.agentsMd(name, pm, environment)],
    // Claude Code reads CLAUDE.md: this sends it to the same notes.
    ['CLAUDE.md', '@AGENTS.md\n'],
  ];
  for (const [file, text] of forAgents) {
    if (!(await exists(join(target, file)))) await writeFile(join(target, file), text);
  }

  let envExample = await readFile(new URL('env.example', TEMPLATE), 'utf8');
  envExample = setEnv(envExample, 'VOICEFLOW_ENVIRONMENT', environment);
  await writeFile(join(target, '.env.example'), envExample);
  // Your own copy, readable only by you. One that's already there is yours, and is left as it is.
  const envLocal = join(target, '.env.local');
  if (!(await exists(envLocal))) {
    await writeFile(envLocal, o.project ? setEnv(envExample, 'VOICEFLOW_PROJECT_ID', o.project) : envExample, { mode: 0o600 });
    await chmod(envLocal, 0o600);
  }
  say(`Created ${name}: a Voiceflow agent in ${starter.label}, on Next.js.`);

  if (!o['no-git']) {
    // A repository of its own, unless it's inside one already. Git being missing is no reason to stop.
    const inside = (await run('git', ['rev-parse', '--is-inside-work-tree'], target).catch(() => 1)) === 0;
    if (!inside) await run('git', ['init', '--quiet'], target).catch(() => 1);
  }
  let installed = !o['skip-install'];
  if (installed) {
    say(`Installing with ${pm}…`);
    const code = await run(pm, ['install'], target).catch(() => 127);
    if (code !== 0) {
      err(`${pm} install didn't finish (exit ${code}). The app is in ${name}: run ${pm} install there yourself.`);
      installed = false;
    }
  }

  const where = relative(io.cwd ?? process.cwd(), target) || '.';
  out(
    [
      '',
      'Next:',
      ...(where === '.' ? [] : [`  cd ${where}`]),
      ...(installed ? [] : [`  ${pm} install`]),
      ...starter.next(pm, environment, Boolean(o.project)),
      '',
      'README.md has each step in full. AGENTS.md has them for a coding agent: ask yours to set this up.',
    ].join('\n'),
  );
  // The app was made either way; a failed install is the one thing left to do, and the exit code says so.
  return !o['skip-install'] && !installed ? 1 : 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      channel: { type: 'string', default: 'slack' },
      project: { type: 'string' },
      environment: { type: 'string' },
      pm: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', short: 'f', default: false },
      'skip-install': { type: 'boolean', short: 's', default: false },
      'no-git': { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
}
