// `npm create voiceflow-channels@latest my-bot`: a new app for a Voiceflow
// agent in Slack, ready for `connect`. It writes a small Next.js app (the one
// in examples/nextjs-slack, which CI builds), a package.json with the versions
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

export const CHANNELS = ['slack'] as const;
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const DEFAULT_NAME = 'my-bot';
const TEMPLATE = new URL('../template/', import.meta.url);

const USAGE = `Usage:
  npm create voiceflow-channels@latest [name] [options]

Makes a new app for a Voiceflow agent in Slack: a Next.js server with the
route Slack calls, its env file, and a connect script that makes the Slack app.

Options:
  [name]                  the app's folder, and its name (default: ${DEFAULT_NAME})
  --channel <channel>     the channel to start with (default and only one so far: slack)
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

/** How each package manager runs a script with arguments: only npm needs the `--`. */
function runScript(pm: PackageManager, script: string, args: string): string {
  if (pm === 'npm') return `npm run ${script} -- ${args}`;
  return pm === 'bun' ? `bun run ${script} ${args}` : `${pm} ${script} ${args}`;
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

function readme(name: string, pm: PackageManager, environment: string): string {
  const connect = runScript(pm, 'connect', '--public-url https://<your tunnel>');
  return `# ${name}

A Voiceflow agent in Slack, served by one Next.js route:
[\`app/api/slack/route.ts\`](app/api/slack/route.ts). Mentions, direct messages,
the assistant panel, buttons, forms and \`/ask\` all arrive there, and so do the
calls the agent's Slack tools make.

Made with [\`create-voiceflow-channels\`](https://github.com/voiceflow/channels-sdk).

## Run it

You need Node.js 22 or later, a Voiceflow agent with an API key, a Slack
workspace where you can create apps, and a tunnel such as
[ngrok](https://ngrok.com). Connect signs you in to Slack through the
[Slack CLI](https://tools.slack.dev/slack-cli), and offers to install it
when you don't have it.

1. Start a tunnel to port 3000, and keep it running:

   \`\`\`bash
   ngrok http 3000
   \`\`\`

2. Make the Slack app, with the tunnel's URL. Run this before the server, so
   that connect can answer Slack's check of the URL itself:

   \`\`\`bash
   ${connect}
   \`\`\`

   It signs you in to Slack (it runs \`slack login\` for you, and offers to
   install the Slack CLI first when you don't have it). It reads your agent's
   details from \`.env.local\` and asks for what isn't there: your Voiceflow
   API key, in a hidden prompt, and your project's ID. It shows its plan and
   asks before it changes anything. Then it makes and
   installs the app, installs Slack's tools on the agent, and fills in
   \`.env.local\`: the app's \`SLACK_BOT_TOKEN\` and \`SLACK_SIGNING_SECRET\`,
   and what it asked you for. The bot token stays on this server: it never
   goes to Voiceflow.

   The bot runs the published version of the agent's \`${environment}\`
   environment, so connect then shows what that environment's draft holds and
   asks whether to publish it. The whole draft goes live, not only these
   tools: say no to publish it in Voiceflow yourself. The new app's bot then
   messages you in Slack.

3. Start the server:

   \`\`\`bash
   ${pm} run dev
   \`\`\`

Mention the app in a channel, send it a direct message, or open it from
Slack's assistant panel.

## Deploy it

- Set the same environment variables on your host, with \`REDIS_URL\` pointing at
  a Redis database: conversations live in memory without it, and end when the
  server restarts or a request reaches another instance.
- Run connect again with your deployment's URL as \`--public-url\`. It reuses
  the app it made and points it at the new address.

## Learn more

- [Voiceflow Channels](https://github.com/voiceflow/channels-sdk): every Slack
  option, the tools, and tools of your own.
- [Voiceflow's documentation](https://www.voiceflow.com/docs), for building the
  agent itself.
`;
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
      `There's no starter for "${o.channel}" yet: Slack is the one channel with its own package so far. Any other Chat SDK adapter works with the core by hand: https://github.com/voiceflow/channels-sdk/blob/main/docs/how-it-works.md#any-chat-sdk-adapter`,
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
  // The app itself: its route, its page, and its Next.js and TypeScript settings.
  for (const entry of ['app', 'next.config.ts', 'tsconfig.json']) {
    await cp(fileURLToPath(new URL(entry, TEMPLATE)), join(target, entry), { recursive: true, force: true });
  }
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    description: 'A Voiceflow agent in Slack, served by a Next.js route.',
    engines: { node: '>=22' },
    scripts: app.scripts,
    dependencies: versioned(app.dependencies),
    devDependencies: versioned(app.devDependencies),
  };
  await writeFile(join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(join(target, '.gitignore'), GITIGNORE);
  await writeFile(join(target, 'README.md'), readme(name, pm, environment));

  let envExample = await readFile(new URL('env.example', TEMPLATE), 'utf8');
  envExample = setEnv(envExample, 'VOICEFLOW_ENVIRONMENT', environment);
  await writeFile(join(target, '.env.example'), envExample);
  // Your own copy, readable only by you. One that's already there is yours, and is left as it is.
  const envLocal = join(target, '.env.local');
  if (!(await exists(envLocal))) {
    await writeFile(envLocal, o.project ? setEnv(envExample, 'VOICEFLOW_PROJECT_ID', o.project) : envExample, { mode: 0o600 });
    await chmod(envLocal, 0o600);
  }
  say(`Created ${name}: a Voiceflow agent in Slack, on Next.js.`);

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
      '  1. Start a tunnel to port 3000 (ngrok http 3000).',
      '  2. Make the Slack app:',
      `       ${runScript(pm, 'connect', '--public-url https://<your tunnel>')}`,
      `     It signs you in to Slack, asks for your Voiceflow API key${o.project ? '' : ' and project ID'}, and saves ${o.project ? 'it' : 'them'} in .env.local.`,
      `     Then it asks whether to publish the ${environment} environment, and the bot messages you in Slack.`,
      `  3. ${pm} run dev`,
      '',
      'README.md has each step in full.',
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
