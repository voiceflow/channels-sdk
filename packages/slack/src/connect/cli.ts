// The command line for `connect slack` and `disconnect slack`:
//
//   npx voiceflow-channels connect slack --public-url https://<host> --env-file .env.local
//
// Secrets never reach the screen or the command line: the Voiceflow API key is
// read from a file (--key-file), VOICEFLOW_API_KEY, your server's env file
// (--env-file) or a hidden prompt; the Slack login is the Slack CLI's; the
// app's credentials go only to that env file, written readable by you alone,
// and never to Voiceflow.
// Every line this prints, an error's included, is first cleaned of the secrets
// it holds: a server that repeats one back in an error can't put it on screen.
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { basename, dirname, join } from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { parseArgs } from 'node:util';
import { createRedactor } from '@voiceflow/channels-sdk';
import { type ConnectResult, connectSlack, disconnectSlack, type SlackCliLogin, slackCliLogin, slackManifest } from './index.js';

const USAGE = `Usage:
  voiceflow-channels connect slack --public-url <https://host> [--env-file <path>] [options]
  voiceflow-channels disconnect slack [--env-file <path>] [--remove-tools] [--yes]
  voiceflow-channels connect slack --print-manifest --public-url <https://host>

Connect makes a Slack app for your Voiceflow agent (or adds what's missing to
one you have), installs it in your workspace, and installs Slack's tools on the
agent. The tools run on your server, so the app's bot token never goes to
Voiceflow. It shows the plan and asks before changing anything. It never
publishes the agent.

Your Voiceflow API key, project and environment come from the flags below,
then VOICEFLOW_API_KEY, VOICEFLOW_PROJECT_ID and VOICEFLOW_ENVIRONMENT in the
environment, then the same names in --env-file. What's still missing is asked
for, the key in a hidden prompt.

Options:
  --project <id>          the Voiceflow project (agent)
  --environment <alias>   the environment to install the tools into: its draft is
                          changed and compiled, nothing is published
  --workspace <id>        stop, changing nothing, unless the project is in this
                          Voiceflow workspace
  --public-url <url>      your server's public address; Slack sends to <url>/api/slack
  --request-url <url>     or the whole webhook URL, if it isn't <url>/api/slack
  --tools-url <url>       where the agent's Slack tools call your server
                          (default: the webhook URL, which answers them too)
  --team <id>             the Slack workspace (from \`slack login\`); default: the only one
  --app <id>              use this app, adding what's missing, instead of making one
  --name <name>           a new app's name (default: the agent's name in Voiceflow)
  --icon <url|none>       the app's icon, an image's URL (default: a new app gets
                          the agent's avatar in Voiceflow, or Voiceflow's icon when
                          it has none; an existing app keeps its icon)
  --command </name|none>  the slash command (default /ask)
  --no-tools              make the app, but install no tools
  --no-workspace-tools    install only the presentation tools (then pass
                          workspaceTools: false to slack() on your server)
  --restore <a,b>         add these tools again, although they were removed
  --env-file <path>       your server's env file. Connect reads the Voiceflow
                          values from it, and writes to it the Slack app's
                          SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET and any
                          Voiceflow value it had to ask for. A value already
                          there is never changed
  --port <n>              while the app is made, answer Slack's URL check on
                          127.0.0.1:<n>, where your tunnel points (default 3000;
                          skipped if your server already holds the port)
  --key-file <path>       a file holding only the Voiceflow API key
  --dry-run               show the plan and stop
  --yes                   don't ask before going ahead
  --remove-tools          disconnect: also take Slack's tools off the agent
  --print-manifest        print the app's manifest and stop`;

/** What the command reads and writes, for a test or a program that runs it: by default the console, the Slack CLI's login, the environment and `fetch`. */
export interface CliIO {
  /** Takes each line of output. */
  out?: (line: string) => void;
  /** Takes each line of an error or a warning. */
  err?: (line: string) => void;
  /** The Slack CLI's login for a workspace. */
  login?: (teamId?: string) => SlackCliLogin;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Whether a person is there to answer a question. */
  interactive?: boolean;
  /** Asks a question and returns the answer. */
  ask?: (question: string) => Promise<string>;
  /** Asks for a secret, without showing what's typed. */
  secret?: (question: string) => Promise<string>;
}

/** Runs the command. Returns its exit code: an error is printed, cleaned of every secret the command holds, and never thrown. */
export async function cli(argv: string[], io: CliIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  // Learns each secret as soon as the command has it, and cleans every line on its way out.
  const secrets = createRedactor(env.VOICEFLOW_API_KEY, env.SLACK_BOT_TOKEN, env.SLACK_SIGNING_SECRET);
  const out = (line: string) => (io.out ?? console.log)(secrets.redact(line));
  const err = (line: string) => (io.err ?? console.error)(secrets.redact(line));
  try {
    return await run(argv, { ...io, env }, secrets, out, err);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

type Say = (line: string) => void;
/** A value that reads the same in every env file parser with no quotes around it. */
const BARE = /^[\w.:/@+=,-]+$/;

async function run(
  argv: string[],
  io: CliIO & { env: Record<string, string | undefined> },
  secrets: ReturnType<typeof createRedactor>,
  out: Say,
  err: Say,
): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      environment: { type: 'string' },
      workspace: { type: 'string' },
      'public-url': { type: 'string' },
      'request-url': { type: 'string' },
      'tools-url': { type: 'string' },
      team: { type: 'string' },
      app: { type: 'string' },
      name: { type: 'string' },
      icon: { type: 'string' },
      command: { type: 'string' },
      'no-tools': { type: 'boolean', default: false },
      'no-workspace-tools': { type: 'boolean', default: false },
      restore: { type: 'string' },
      'env-file': { type: 'string' },
      port: { type: 'string', default: '3000' },
      'key-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'remove-tools': { type: 'boolean', default: false },
      'print-manifest': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const action = positionals[0] ?? 'connect';
  if (o.help || !['connect', 'disconnect'].includes(action)) {
    out(USAGE);
    return o.help ? 0 : 2;
  }
  const command = o.command === undefined ? undefined : o.command === 'none' ? (false as const) : o.command;
  const icon = o.icon === undefined ? undefined : o.icon === 'none' ? (false as const) : o.icon;
  const app = { ...(o.name ? { name: o.name } : {}), ...(command !== undefined ? { command } : {}) };
  const tools = o['no-tools'] ? (false as const) : { workspace: !o['no-workspace-tools'] };

  const requestUrl = o['request-url'] ?? (o['public-url'] ? `${o['public-url'].replace(/\/+$/, '')}/api/slack` : undefined);
  if (o['print-manifest']) {
    out(JSON.stringify(slackManifest({ ...app, requestUrl: requestUrl ?? 'https://example.com/api/slack', tools }), null, 2));
    return 0;
  }

  // The server's env file, when there is one: what it already says isn't asked for again.
  const envFile = o['env-file'];
  const inFile = envFile ? await readEnvFile(envFile) : {};
  secrets.add(inFile.VOICEFLOW_API_KEY, inFile.SLACK_BOT_TOKEN, inFile.SLACK_SIGNING_SECRET);
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY);
  const ask = io.ask ?? question;
  // A flag wins, then the environment, then the env file. A person is asked for what's left.
  let project = o.project || io.env.VOICEFLOW_PROJECT_ID || inFile.VOICEFLOW_PROJECT_ID || '';
  let environment = o.environment || io.env.VOICEFLOW_ENVIRONMENT || inFile.VOICEFLOW_ENVIRONMENT || '';
  if (action === 'connect' && !requestUrl) {
    err(`Missing --public-url: your server's public address, where Slack sends its requests.\n\n${USAGE}`);
    return 2;
  }
  if (!project && interactive) project = (await ask('Voiceflow project ID: ')).trim();
  if (!environment && interactive) environment = (await ask('Voiceflow environment to install the tools into (development, say): ')).trim();
  const missing = [...(project ? [] : ['--project (or VOICEFLOW_PROJECT_ID)']), ...(environment ? [] : ['--environment (or VOICEFLOW_ENVIRONMENT)'])];
  if (missing.length) {
    err(`Missing ${missing.join(' and ')}${envFile ? `, in the environment or in ${envFile}` : ''}.\n\n${USAGE}`);
    return 2;
  }

  const login = (io.login ?? slackCliLogin)(o.team);
  secrets.add(login.token);
  const key = await voiceflowKey({ file: o['key-file'], env: io.env, inFile, envFile, interactive, secret: io.secret ?? hidden });
  const apiKey = key.value;
  secrets.add(apiKey);
  /** What the server needs and its env file doesn't say yet. Written once connect has done its work, never over a value that's there. */
  const needed: [name: string, value: string][] = [
    ['VOICEFLOW_API_KEY', key.typed ? apiKey : ''],
    ['VOICEFLOW_PROJECT_ID', project],
    ['VOICEFLOW_ENVIRONMENT', environment],
  ];
  const toSave = envFile ? needed.filter(([name, value]) => value && !inFile[name]) : [];
  const withFetch = io.fetch ? { fetch: io.fetch } : {};
  const voiceflow = { apiKey, projectID: project, environment, ...(o.workspace ? { expectWorkspace: o.workspace } : {}), ...withFetch };
  const slack = { token: login.token, teamId: login.teamId, ...withFetch };
  const confirm = async (lines: string[]) => {
    out(lines.join('\n'));
    if (o['dry-run']) return false;
    if (o.yes) return true;
    if (!interactive) {
      err('\nNothing was changed: run it again with --yes to go ahead.');
      return false;
    }
    return /^y(es)?$/i.test((await ask('\nGo ahead? [y/N] ')).trim());
  };

  if (action === 'disconnect') {
    const result = await disconnectSlack({
      slack,
      voiceflow,
      ...(o.app ? { appId: o.app } : {}),
      removeTools: o['remove-tools'],
      confirm,
      onProgress: out,
    });
    if (result.applied) out('\nDisconnected.');
    return 0;
  }

  // Slack checks the request URL while it makes the app: answer it here unless your server already does.
  const checker = o['dry-run'] ? { close: async () => {} } : await urlChecker(Number(o.port), out);
  let result: ConnectResult;
  try {
    result = await connectSlack({
      slack,
      voiceflow,
      requestUrl: requestUrl!,
      ...(o['tools-url'] ? { toolsUrl: o['tools-url'] } : {}),
      ...(o.app ? { appId: o.app } : {}),
      app: { ...app, ...(icon !== undefined ? { icon } : {}) },
      tools,
      ...(o.restore
        ? {
            restore: o.restore
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
      confirm: (plan) => confirm(plan.lines),
      onProgress: out,
      // Each credential is one to hide from the moment it exists, before anything after it can fail.
      onCredentials: async (c) => {
        secrets.add(c.botToken, c.signingSecret);
        if (envFile) await writeEnvFile(envFile, { SLACK_BOT_TOKEN: c.botToken, SLACK_SIGNING_SECRET: c.signingSecret });
      },
    });
  } finally {
    await checker.close();
  }
  secrets.add(result.botToken, result.signingSecret, result.userToken);
  if (!result.applied) return 0;
  // A value an env file would read back as something else (a space, a quote, a `#`, a `$`) is yours to write.
  const saved = toSave.filter(([, value]) => BARE.test(value));
  const unsaved = toSave.filter(([, value]) => !BARE.test(value));
  if (envFile && saved.length) {
    await writeEnvFile(envFile, Object.fromEntries(saved));
    out(`+ saved ${saved.map(([name]) => name).join(', ')} to ${envFile}`);
  }
  for (const [name] of unsaved) err(`! ${name} wasn't saved to ${envFile}: its value needs quoting there. Add it yourself.`);
  const keyIsSaved = Boolean(envFile && (inFile.VOICEFLOW_API_KEY || saved.some(([name]) => name === 'VOICEFLOW_API_KEY')));
  printSettings(result, { envFile, requestUrl: requestUrl!, projectID: project, environment, keyIsSaved }, out);
  for (const problem of result.install?.problems ?? []) err(`! ${problem}`);
  for (const note of result.install?.notes ?? []) err(`! ${note}`);
  return 0;
}

function printSettings(r: ConnectResult, s: { envFile?: string; requestUrl: string; projectID: string; environment: string; keyIsSaved: boolean }, out: Say) {
  const page = (tab: string) => `https://api.slack.com/apps/${r.appId}/${tab}`;
  const token = s.envFile ? `in ${s.envFile}` : `not saved: copy it from OAuth & Permissions, ${page('oauth')}`;
  const secret = r.signingSecret
    ? s.envFile
      ? `in ${s.envFile}`
      : `not saved: copy it from Basic Information, ${page('general')}`
    : `unchanged (the app already existed): Basic Information, ${page('general')}`;
  out(`
Connected: Slack app ${r.appId}, bot user ${r.botUserId}.

Your server needs:
  SLACK_BOT_TOKEN       ${token}
  SLACK_SIGNING_SECRET  ${secret}
  VOICEFLOW_API_KEY     ${s.keyIsSaved ? `in ${s.envFile}` : 'your Voiceflow API key'}

  createChannels({
    voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY, projectID: '${s.projectID}', environment: '${s.environment}' },
    channels: [slack()],
  })

Slack sends to ${s.requestUrl}.${
    r.install
      ? `
The agent's Slack tools call your server at ${r.toolsUrl}: it runs them, with its own SLACK_BOT_TOKEN.
The tools are on the ${s.environment} environment's draft. Those that act in Slack answer only in Slack: in Voiceflow's test chat they say so.
Your bot runs ${s.environment}'s published version, so the agent in Slack has them only once you publish ${s.environment} in Voiceflow.`
      : ''
  }`);
}

/** Answers Slack's URL check (and nothing else) on a local port, unless something already listens there. */
export async function urlChecker(port: number, say: (line: string) => void = console.log): Promise<{ close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let challenge: unknown;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body?.type === 'url_verification') challenge = body.challenge;
      } catch {}
      if (typeof challenge === 'string') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ challenge }));
      } else {
        res.writeHead(503);
        res.end('connect is running: start your server when it finishes');
      }
    });
  });
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (!listening) say(`(port ${port} is in use: your server there answers Slack's URL check)`);
  return { close: () => (listening ? new Promise<void>((r) => server.close(() => r())) : Promise.resolve()) };
}

/** Sets these keys in an env file, keeping its other lines, readable only by you. */
export async function writeEnvFile(path: string, values: Record<string, string | undefined>): Promise<void> {
  const set = Object.entries(values).filter((e): e is [string, string] => Boolean(e[1]));
  if (!set.length) return;
  let lines: string[] = [];
  try {
    lines = (await readFile(path, 'utf8')).split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (lines.at(-1) === '') lines.pop();
  for (const [key, value] of set) {
    const i = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  // A new file, readable only by you from the start, renamed over the old one:
  // the secrets never go into a file someone else can read.
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}`);
  try {
    await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The Voiceflow values in an env file, or any others: its `KEY=value` lines,
 * with or without `export` and quotes. A file that isn't there is an empty one.
 */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    // Unquoted, a value ends where a comment starts.
    values[match[1]!] = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '');
  }
  return values;
}

/**
 * The Voiceflow API key: from the file that holds only it, the environment, the
 * server's env file, or (asked of a person) a hidden prompt. `typed` says it
 * came from the prompt, so it can be saved for the server.
 */
async function voiceflowKey(from: {
  file?: string;
  env: Record<string, string | undefined>;
  inFile: Record<string, string>;
  envFile?: string;
  interactive: boolean;
  secret: (question: string) => Promise<string>;
}): Promise<{ value: string; typed: boolean }> {
  if (from.file) {
    const key = (await readFile(from.file, 'utf8')).trim();
    if (!key) throw new Error(`${from.file} is empty.`);
    return { value: key, typed: false };
  }
  if (from.env.VOICEFLOW_API_KEY) return { value: from.env.VOICEFLOW_API_KEY, typed: false };
  if (from.inFile.VOICEFLOW_API_KEY) return { value: from.inFile.VOICEFLOW_API_KEY, typed: false };
  if (!from.interactive) {
    throw new Error(`No Voiceflow API key: set VOICEFLOW_API_KEY${from.envFile ? `, here or in ${from.envFile},` : ''} or pass --key-file.`);
  }
  const key = await from.secret('Voiceflow API key (hidden): ');
  if (!key) throw new Error('No Voiceflow API key entered.');
  return { value: key, typed: true };
}

/**
 * Reads a line from the terminal without showing it. It reads raw keystrokes and
 * writes only the prompt, so nothing typed reaches the screen: not as it's
 * typed, and not when a terminal would redraw the line (a backspace, a wrap).
 */
export function hidden(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const wasRaw = input.isRaw;
    let value = '';
    // An escape sequence (an arrow key, say) is skipped whole. inEscape: 1 after ESC, 2 inside `ESC [`, 3 after `ESC O`.
    let inEscape = 0;
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const key of decoder.write(chunk)) {
        if (inEscape === 1) inEscape = key === '[' ? 2 : key === 'O' ? 3 : 0;
        else if (inEscape === 2) inEscape = key >= '@' && key <= '~' ? 0 : 2;
        else if (inEscape === 3) inEscape = 0;
        else if (key === '\x1b') inEscape = 1;
        else if (key === '\r' || key === '\n' || key === '\x04') return finish();
        else if (key === '\x03') return finish(new Error('Cancelled.'));
        else if (key === '\x7f' || key === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (key === '\x15') value = '';
        else if (key >= ' ') value += key;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
