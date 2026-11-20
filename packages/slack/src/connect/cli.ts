// The command line for `connect slack` and `disconnect slack`:
//
//   npx voiceflow-channels connect slack --project <id> --environment <alias> --public-url https://<host>
//
// Secrets never reach the screen or the command line: the Voiceflow API key is
// read from VOICEFLOW_API_KEY, a file (--key-file) or a hidden prompt; the
// Slack login is the Slack CLI's; the app's credentials go only to a file you
// name (--env-file), written readable by you alone.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { connectSlack, disconnectSlack, slackCliLogin, slackManifest, type ConnectResult } from './index.js';

const USAGE = `Usage:
  voiceflow-channels connect slack --project <id> --environment <alias> --public-url <https://host> [options]
  voiceflow-channels disconnect slack --project <id> --environment <alias> [--remove-tools] [--yes]
  voiceflow-channels connect slack --print-manifest --public-url <https://host>

Connect makes a Slack app for your Voiceflow agent (or adds what's missing to
one you have), installs it in your workspace, and installs Slack's tools on the
agent, with the app's bot token as the slack_bot_token secret. It shows the plan
and asks before changing anything. It never publishes the agent.

Options:
  --project <id>          the Voiceflow project (agent)
  --environment <alias>   the environment to install the tools into: its draft is
                          changed and compiled, nothing is published
  --workspace <id>        stop, changing nothing, unless the project is in this
                          Voiceflow workspace
  --public-url <url>      your server's public address; Slack sends to <url>/api/slack
  --request-url <url>     or the whole webhook URL, if it isn't <url>/api/slack
  --team <id>             the Slack workspace (from \`slack login\`); default: the only one
  --app <id>              use this app, adding what's missing, instead of making one
  --name <name>           a new app's name (default: the agent's name in Voiceflow)
  --icon <url|none>       the app's icon, an image's URL (default: a new app gets
                          the agent's avatar in Voiceflow, or Voiceflow's icon when
                          it has none; an existing app keeps its icon)
  --command </name|none>  the slash command (default /ask)
  --no-tools              make the app, but install no tools
  --no-workspace-tools    install only the presentation tools
  --restore <a,b>         add these tools again, although they were removed
  --env-file <path>       write SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET to this file
  --port <n>              while the app is made, answer Slack's URL check on
                          127.0.0.1:<n>, where your tunnel points (default 3000;
                          skipped if your server already holds the port)
  --key-file <path>       a file holding the Voiceflow API key (default:
                          VOICEFLOW_API_KEY, or a hidden prompt)
  --dry-run               show the plan and stop
  --yes                   don't ask before going ahead
  --remove-tools          disconnect: also take Slack's tools off the agent
  --print-manifest        print the app's manifest and stop`;

export async function cli(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      environment: { type: 'string' },
      workspace: { type: 'string' },
      'public-url': { type: 'string' },
      'request-url': { type: 'string' },
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
    console.log(USAGE);
    return o.help ? 0 : 2;
  }
  const command = o.command === undefined ? undefined : o.command === 'none' ? (false as const) : o.command;
  const icon = o.icon === undefined ? undefined : o.icon === 'none' ? (false as const) : o.icon;
  const app = { ...(o.name ? { name: o.name } : {}), ...(command !== undefined ? { command } : {}) };
  const tools = o['no-tools'] ? (false as const) : { workspace: !o['no-workspace-tools'] };

  const requestUrl = o['request-url'] ?? (o['public-url'] ? `${o['public-url'].replace(/\/+$/, '')}/api/slack` : undefined);
  if (o['print-manifest']) {
    console.log(JSON.stringify(slackManifest({ ...app, requestUrl: requestUrl ?? 'https://example.com/api/slack', tools }), null, 2));
    return 0;
  }

  const missing = ['project', 'environment'].filter((k) => !o[k as 'project']);
  if (action === 'connect' && !requestUrl) missing.push('public-url');
  if (missing.length) {
    console.error(`Missing ${missing.map((m) => `--${m}`).join(', ')}.\n\n${USAGE}`);
    return 2;
  }

  const login = slackCliLogin(o.team);
  const apiKey = await voiceflowKey(o['key-file']);
  const voiceflow = { apiKey, projectID: o.project!, environment: o.environment!, ...(o.workspace ? { expectWorkspace: o.workspace } : {}) };
  const slack = { token: login.token, teamId: login.teamId };
  const confirm = async (lines: string[]) => {
    console.log(lines.join('\n'));
    if (o['dry-run']) return false;
    if (o.yes) return true;
    if (!process.stdin.isTTY) {
      console.error('\nNothing was changed: run it again with --yes to go ahead.');
      return false;
    }
    return yes('\nGo ahead? [y/N] ');
  };

  if (action === 'disconnect') {
    const result = await disconnectSlack({ slack, voiceflow, ...(o.app ? { appId: o.app } : {}), removeTools: o['remove-tools'], confirm, onProgress: (l) => console.log(l) });
    if (result.applied) console.log('\nDisconnected.');
    return 0;
  }

  // Slack checks the request URL while it makes the app: answer it here unless your server already does.
  const checker = o['dry-run'] ? { close: async () => {} } : await urlChecker(Number(o.port));
  let result: ConnectResult;
  try {
    result = await connectSlack({
      slack,
      voiceflow,
      requestUrl: requestUrl!,
      ...(o.app ? { appId: o.app } : {}),
      app: { ...app, ...(icon !== undefined ? { icon } : {}) },
      tools,
      ...(o.restore ? { restore: o.restore.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      confirm: (plan) => confirm(plan.lines),
      onProgress: (line) => console.log(line),
      onCredentials: o['env-file'] ? (c) => writeEnvFile(o['env-file']!, { SLACK_BOT_TOKEN: c.botToken, SLACK_SIGNING_SECRET: c.signingSecret }) : undefined,
    });
  } finally {
    await checker.close();
  }
  if (!result.applied) return 0;
  printSettings(result, { envFile: o['env-file'], requestUrl: requestUrl!, projectID: o.project!, environment: o.environment! });
  for (const problem of result.install?.problems ?? []) console.warn(`! ${problem}`);
  return 0;
}

function printSettings(r: ConnectResult, s: { envFile?: string; requestUrl: string; projectID: string; environment: string }) {
  const page = (tab: string) => `https://api.slack.com/apps/${r.appId}/${tab}`;
  const token = s.envFile ? `in ${s.envFile}` : `not saved: copy it from OAuth & Permissions, ${page('oauth')}`;
  const secret = r.signingSecret
    ? s.envFile
      ? `in ${s.envFile}`
      : `not saved: copy it from Basic Information, ${page('general')}`
    : `unchanged (the app already existed): Basic Information, ${page('general')}`;
  console.log(`
Connected: Slack app ${r.appId}, bot user ${r.botUserId}.

Your server needs:
  SLACK_BOT_TOKEN       ${token}
  SLACK_SIGNING_SECRET  ${secret}
  VOICEFLOW_API_KEY     your Voiceflow API key

  createChannels({
    voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY, projectID: '${s.projectID}', environment: '${s.environment}' },
    channels: [slack()],
  })

Slack sends to ${s.requestUrl}.${r.install ? `
The tools are on the ${s.environment} environment's draft: try them in Voiceflow's test chat.
Your bot runs ${s.environment}'s published version, so the agent in Slack has them only once you publish ${s.environment} in Voiceflow.` : ''}`);
}

/** Answers Slack's URL check (and nothing else) on a local port, unless something already listens there. */
export async function urlChecker(port: number): Promise<{ close(): Promise<void> }> {
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
  if (!listening) console.log(`(port ${port} is in use: your server there answers Slack's URL check)`);
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
  await writeFile(path, lines.join('\n') + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

async function voiceflowKey(file?: string): Promise<string> {
  if (file) {
    const key = (await readFile(file, 'utf8')).trim();
    if (!key) throw new Error(`${file} is empty.`);
    return key;
  }
  if (process.env.VOICEFLOW_API_KEY) return process.env.VOICEFLOW_API_KEY;
  if (!process.stdin.isTTY) throw new Error('No Voiceflow API key: set VOICEFLOW_API_KEY or pass --key-file.');
  const key = await hidden('Voiceflow API key (hidden): ');
  if (!key) throw new Error('No Voiceflow API key entered.');
  return key;
}

function hidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(prompt)) process.stdout.write(s);
    };
    rl.question(prompt, (value) => {
      rl.close();
      process.stdout.write('\n');
      resolve(value.trim());
    });
  });
}

function yes(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
