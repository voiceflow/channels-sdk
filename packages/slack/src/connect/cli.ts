// The command line for `connect slack` and `disconnect slack`:
//
//   npx voiceflow-channels connect slack --public-url https://<host> --env-file .env.local
//
// Secrets never reach the screen or the command line: the Voiceflow API key is
// read from a file (--key-file), VOICEFLOW_API_KEY, your server's env file
// (--env-file) or a hidden prompt; the Slack login is the Slack CLI's, which
// connect refreshes, or makes with `slack login`, when it has to (sign-in.ts);
// the app's credentials go only to that env file, written readable by you
// alone, and never to Voiceflow.
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
import { checkTunnelTool, startTunnel, type Tunnel, type TunnelHost } from '@voiceflow/channels-sdk/dev';
import { type DraftChanges, draftChanges, formatDraftChanges, publishEnvironment } from '@voiceflow/channels-sdk/install';
import { slackCliLogins } from './api.js';
import {
  type ConnectResult,
  checkServer,
  connectOwnApp,
  connectSlack,
  createSlackApi,
  disconnectSlack,
  greetingText,
  type OwnAppResult,
  pointSlack,
  type SlackCliLogin,
  sendGreeting,
  slackManifest,
} from './index.js';
import { NeedsYou, type SlackCliHost, slackSignIn } from './sign-in.js';

const USAGE = `Usage:
  voiceflow-channels connect slack [--public-url <https://host>] [--env-file <path>] [options]
  voiceflow-channels connect slack --manual --public-url <https://host> [--env-file <path>]
  voiceflow-channels point slack --public-url <https://host> [--env-file <path>]
  voiceflow-channels disconnect slack [--env-file <path>] [--remove-tools] [--yes]
  voiceflow-channels connect slack --print-manifest --public-url <https://host>

Connect makes a Slack app for your Voiceflow agent (or adds what's missing to
one you have), installs it in your workspace, and installs Slack's tools on the
agent. The tools run on your server, so the app's bot token never goes to
Voiceflow. It shows the plan and asks before changing anything.

The tools go on the environment's draft, and your bot runs its published
version. So connect then shows what the draft holds that isn't live, and asks
whether to publish it: the whole draft goes live, not only these tools. It
publishes only on your yes, or with --publish; a script without --publish is
never published for. A new app's bot then messages you in Slack to say it's
connected.

Your Voiceflow API key, project and environment come from the flags below,
then VOICEFLOW_API_KEY, VOICEFLOW_PROJECT_ID and VOICEFLOW_ENVIRONMENT in the
environment, then the same names in --env-file. What's still missing is asked
for, the key in a hidden prompt.

Connect works in Slack with the Slack CLI's login. It refreshes a login that
has expired, asks which workspace when there are several, runs \`slack login\`
when there is none, and offers Slack's installer when there is no Slack CLI.
With nobody at the terminal it stops instead, saying what to do and how to
carry on.

With --manual, connect leaves Slack to you: for an app you made and installed
by hand, it checks the app's scopes and installs the tools on the agent, and
needs no Slack CLI. It reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the
environment or --env-file, or asks for them.

Without --public-url, connect is for a server on this machine: it opens a
temporary tunnel so Slack has an address while the app is made, and
\`voiceflow-channels dev\` gives Slack your server's address each time it
starts. Pass --public-url for a server that has an address of its own.

Point moves a connected app, and the agent's Slack tools, to another address,
and changes nothing else: \`voiceflow-channels dev\` runs it on each start.
Slack checks the address as it takes it, so your server has to be answering.

It exits 0 when done, 1 on a failure, 2 on a mistake in the command, and 3
when it's waiting on you: do what it says, then run it again.

Options:
  --project <id>          the Voiceflow project (agent)
  --environment <alias>   the environment to install the tools into: its draft is
                          changed and compiled (publishing is --publish, or
                          your yes)
  --workspace <id>        stop, changing nothing, unless the project is in this
                          Voiceflow workspace
  --public-url <url>      your server's public address; Slack sends to <url>/api/slack.
                          Without it, connect opens a temporary tunnel
  --request-url <url>     or the whole webhook URL, if it isn't <url>/api/slack
  --local-url <url>       point: your server on this machine (http://127.0.0.1:3000).
                          It is asked Slack's signed URL check first, so a server
                          that's down, or has the wrong signing secret, is said
                          here and nothing is changed
  --tools-url <url>       where the agent's Slack tools call your server
                          (default: the webhook URL, which answers them too)
  --team <id>             the Slack workspace (from \`slack login\`); default: the only
                          one, or the one you pick
  --slack-ticket <ticket> finish a sign-in an earlier run started: the ticket it
  --slack-code <code>     gave you, and the code Slack showed for it
  --manual                the Slack app is one you made by hand: change nothing in
                          Slack, check the app and install the tools on the agent
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
  --publish               publish the environment once the tools are on its draft,
                          without asking: its whole draft goes live
  --no-publish            don't publish, and don't ask
  --no-greeting           don't have a new app's bot message you in Slack
  --dry-run               show the plan and stop
  --yes                   don't ask before going ahead (publishing is still yours to
                          answer: see --publish and --no-publish)
  --remove-tools          disconnect: also take Slack's tools off the agent
  --print-manifest        print the app's manifest and stop`;

/** What the command reads and writes, for a test or a program that runs it: by default the console, the Slack CLI's login, the environment and `fetch`. */
export interface CliIO {
  /** Takes each line of output. */
  out?: (line: string) => void;
  /** Takes each line of an error or a warning. */
  err?: (line: string) => void;
  /** The Slack CLI's login for a workspace, in place of signing in. */
  login?: (teamId?: string) => SlackCliLogin;
  /** The Slack CLI on this machine: where its logins are kept, how it's found and run. */
  slackCli?: Partial<SlackCliHost>;
  /** The machine a tunnel runs on, when connect opens one. */
  tunnel?: Partial<TunnelHost>;
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
    // Waiting on a person is its own answer: whoever ran this knows to hand it over, then run it again.
    return error instanceof NeedsYou ? 3 : 1;
  }
}

type Say = (line: string) => void;
/** Said wherever a tunnel can't be opened: the way to do without one. */
const NO_TUNNEL = "Or give connect your server's address: --public-url https://<host>.";
/** Stands in for a tunnel's address in a plan that is only shown. */
const NOT_YET = 'https://temporary-tunnel.invalid';
/** The release a publish by connect makes in Voiceflow. */
const RELEASE_NAME = 'Slack tools (Channels SDK)';
const RELEASE_DESCRIPTION = 'Published by `voiceflow-channels connect slack`, on a yes.';
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
      'local-url': { type: 'string' },
      'slack-ticket': { type: 'string' },
      'slack-code': { type: 'string' },
      manual: { type: 'boolean', default: false },
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
      publish: { type: 'boolean', default: false },
      'no-publish': { type: 'boolean', default: false },
      'no-greeting': { type: 'boolean', default: false },
      'remove-tools': { type: 'boolean', default: false },
      'print-manifest': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const action = positionals[0] ?? 'connect';
  if (o.help || !['connect', 'disconnect', 'point'].includes(action)) {
    out(USAGE);
    return o.help ? 0 : 2;
  }
  const command = o.command === undefined ? undefined : o.command === 'none' ? (false as const) : o.command;
  const icon = o.icon === undefined ? undefined : o.icon === 'none' ? (false as const) : o.icon;
  const app = { ...(o.name ? { name: o.name } : {}), ...(command !== undefined ? { command } : {}) };
  const tools = o['no-tools'] ? (false as const) : { workspace: !o['no-workspace-tools'] };

  let requestUrl = o['request-url'] ?? (o['public-url'] ? `${o['public-url'].replace(/\/+$/, '')}/api/slack` : undefined);
  // No address given to connect: a server on this machine, reached through a tunnel.
  const local = action === 'connect' && !requestUrl && !o.manual;
  if (o['print-manifest']) {
    out(JSON.stringify(slackManifest({ ...app, requestUrl: requestUrl ?? 'https://example.com/api/slack', tools }), null, 2));
    return 0;
  }

  if (o.publish && o['no-publish']) {
    err('--publish and --no-publish say opposite things: pass one.');
    return 2;
  }
  if (o.manual && action === 'disconnect') {
    err('--manual is for connect and point: an app you made by hand is yours to delete in Slack.');
    return 2;
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
  if (action !== 'disconnect' && !requestUrl && !local) {
    err(
      `Missing --public-url: ${o.manual ? "the address your app's settings point at" : "your server's public address, where Slack sends its requests"}.\n\n${USAGE}`,
    );
    return 2;
  }
  if (!project && interactive) project = (await ask('Voiceflow project ID: ')).trim();
  if (!environment && interactive) environment = (await ask('Voiceflow environment to install the tools into (development, say): ')).trim();
  const missing = [...(project ? [] : ['--project (or VOICEFLOW_PROJECT_ID)']), ...(environment ? [] : ['--environment (or VOICEFLOW_ENVIRONMENT)'])];
  if (missing.length) {
    err(`Missing ${missing.join(' and ')}${envFile ? `, in the environment or in ${envFile}` : ''}.\n\n${USAGE}`);
    return 2;
  }

  const withFetch = io.fetch ? { fetch: io.fetch } : {};
  // With nobody to ask, everything a person has to do is said in one stop, not one thing per run.
  const waiting: string[] = [];
  const orWait = async <T>(get: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await get();
    } catch (error) {
      if (interactive || !(error instanceof NeedsYou)) throw error;
      waiting.push(error.message);
      return undefined;
    }
  };
  // Slack: the CLI's login, or (--manual) the credentials of an app you made.
  if (!io.login && !o.manual) secrets.add(...slackCliLogins(io.slackCli?.credentialsFile).map((l) => l.token));
  const login = o.manual
    ? undefined
    : await orWait(() =>
        io.login
          ? io.login(o.team)
          : slackSignIn({
              ...(o.team ? { team: o.team } : {}),
              ...(o['slack-ticket'] ? { ticket: o['slack-ticket'] } : {}),
              ...(o['slack-code'] ? { code: o['slack-code'] } : {}),
              interactive,
              ask,
              say: out,
              check: (l) => createSlackApi({ token: l.token, ...withFetch })('auth.test'),
              ...(io.slackCli ? { host: io.slackCli } : {}),
            }),
      );
  secrets.add(login?.token);
  // An app you made is asked for its credentials when it's connected; pointing it needs none.
  const own =
    o.manual && action === 'connect'
      ? await orWait(() => ownCredentials({ env: io.env, inFile, envFile, interactive, secret: io.secret ?? hidden }))
      : undefined;
  if (local && !o['dry-run'] && !interactive) await orWait(() => checkTunnelTool({ instead: NO_TUNNEL, ...(io.tunnel ? { host: io.tunnel } : {}) }));
  secrets.add(own?.botToken, own?.signingSecret);
  const key = await orWait(() => voiceflowKey({ file: o['key-file'], env: io.env, inFile, envFile, interactive, secret: io.secret ?? hidden }));
  if (waiting.length || !key) throw new NeedsYou(waiting.join('\n\n'));
  const apiKey = key.value;
  secrets.add(apiKey);

  /**
   * Writes to the env file what the server needs and the file doesn't say yet,
   * once connect has done its work: never over a value that's there. A value an
   * env file would read back as something else (a space, a quote, a `#`, a `$`)
   * is yours to write. Returns the names it wrote.
   */
  const save = async (values: [name: string, value: string][]): Promise<string[]> => {
    const absent = envFile ? values.filter(([name, value]) => value && !inFile[name]) : [];
    const saved = absent.filter(([, value]) => BARE.test(value));
    if (envFile && saved.length) {
      await writeEnvFile(envFile, Object.fromEntries(saved));
      out(`+ saved ${saved.map(([name]) => name).join(', ')} to ${envFile}`);
    }
    for (const [name, value] of absent) {
      if (!BARE.test(value)) err(`! ${name} wasn't saved to ${envFile}: its value needs quoting there. Add it yourself.`);
    }
    return saved.map(([name]) => name);
  };
  const agent: [name: string, value: string][] = [
    ['VOICEFLOW_API_KEY', key.typed ? apiKey : ''],
    ['VOICEFLOW_PROJECT_ID', project],
    ['VOICEFLOW_ENVIRONMENT', environment],
  ];
  const voiceflow = { apiKey, projectID: project, environment, ...(o.workspace ? { expectWorkspace: o.workspace } : {}), ...withFetch };
  const restore = o.restore
    ? {
        restore: o.restore
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }
    : {};
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
  /** What happens once the plan is done, said with it: publishing, and a new app's first message. */
  const after = (greets: boolean): string[] => [
    'Then:',
    tools === false && !o.publish
      ? `  · ${environment} is left as it is: no tools were installed for a publish to carry`
      : o['no-publish']
        ? `  · you're shown what ${environment}'s draft holds; it is not published (--no-publish)`
        : o.publish
          ? `  + publish ${environment}: its whole draft goes live (--publish)`
          : interactive
            ? `  ? you're shown what ${environment}'s draft holds, and asked whether to publish it`
            : `  · you're shown what ${environment}'s draft holds; it is published only with --publish`,
    ...(greets ? ["  + the bot messages you in Slack to say it's connected"] : []),
  ];
  /**
   * Says what the environment's draft holds that isn't live, and publishes it
   * when that's wanted: by --publish, or by a person's yes. Publishing makes
   * the whole draft live, so nothing is published for a script that didn't ask.
   * The draft is read either way: whether the agent in Slack has the tools is
   * said from what's there, never assumed.
   */
  const publish = async (installed: boolean): Promise<'published' | 'not' | 'failed'> => {
    if (!installed && !o.publish) return 'not';
    let waiting: DraftChanges | undefined;
    try {
      waiting = await draftChanges(voiceflow);
    } catch (error) {
      err(`! Couldn't read what ${environment}'s draft holds: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (waiting && waiting.created + waiting.updated + waiting.deleted === 0) {
      out(`\n= ${environment} is published: nothing in its draft is waiting`);
      return 'published';
    }
    out(`\n${waiting ? formatDraftChanges(environment, waiting).join('\n') : `${environment}'s draft may hold changes that aren't live.`}`);
    if (o['no-publish']) {
      out(`${environment} is not published (--no-publish).`);
      return 'not';
    }
    if (!o.publish && !interactive) {
      out(`${environment} is not published: run this again with --publish, or publish it in Voiceflow.`);
      return 'not';
    }
    if (!o.publish && !/^y(es)?$/i.test((await ask(`\nPublish ${environment} now? Its whole draft goes live, not only these tools. [y/N] `)).trim())) {
      out(`${environment} is not published.`);
      return 'not';
    }
    try {
      const { release } = await publishEnvironment({ ...voiceflow, name: RELEASE_NAME, description: RELEASE_DESCRIPTION });
      out(`+ published ${environment} (release "${release}")`);
      return 'published';
    } catch (error) {
      err(`! Voiceflow didn't publish ${environment}: ${error instanceof Error ? error.message : String(error)}. Publish it in Voiceflow.`);
      return 'failed';
    }
  };

  if (own) {
    const result = await connectOwnApp({
      slack: { botToken: own.botToken, ...withFetch },
      voiceflow,
      requestUrl: requestUrl!,
      ...(o['tools-url'] ? { toolsUrl: o['tools-url'] } : {}),
      ...(command !== undefined ? { command } : {}),
      tools,
      ...restore,
      confirm: (plan) => confirm([...plan.lines, ...after(false)]),
      onProgress: out,
    });
    if (!result.applied) return 0;
    const saved = await save([...own.typed, ...agent]);
    const published = await publish(Boolean(result.install));
    const inPlace = (name: string) => Boolean(envFile && (inFile[name] || saved.includes(name)));
    printSettings(
      {
        heading: `Connected the agent to your Slack app: bot user ${result.plan.botUserId} in ${result.plan.team.name}.`,
        token: inPlace('SLACK_BOT_TOKEN') ? `in ${envFile}` : 'the Bot User OAuth Token you gave',
        secret: inPlace('SLACK_SIGNING_SECRET') ? `in ${envFile}` : 'the Signing Secret you gave',
        key: inPlace('VOICEFLOW_API_KEY') ? `in ${envFile}` : 'your Voiceflow API key',
        sends: `Slack sends to ${requestUrl}, once the app's settings say so.`,
        projectID: project,
        environment,
        published: published === 'published',
        ...(result.install ? { toolsUrl: result.toolsUrl! } : {}),
      },
      out,
    );
    report(result.install, err);
    return published === 'failed' ? 1 : 0;
  }
  if (action === 'point' && o['local-url']) {
    // The server is asked what Slack will ask it, before anything is pointed at it.
    const signingSecret = io.env.SLACK_SIGNING_SECRET || inFile.SLACK_SIGNING_SECRET;
    const at = `${o['local-url'].replace(/\/+$/, '')}${new URL(requestUrl!).pathname}`;
    if (signingSecret) {
      await checkServer({ url: at, signingSecret, ...withFetch });
      out(`= your server answers Slack's signed check at ${at}`);
    } else out(`· no SLACK_SIGNING_SECRET here${envFile ? ` or in ${envFile}` : ''}, so your server at ${at} wasn't checked first`);
  }
  if (action === 'point' && o.manual) {
    await pointSlack({ voiceflow, requestUrl: requestUrl!, ...(o['tools-url'] ? { toolsUrl: o['tools-url'] } : {}), onProgress: out });
    return 0;
  }
  if (!login) throw new Error('No Slack login.');
  const slack = { token: login.token, teamId: login.teamId, ...withFetch };

  if (action === 'point') {
    await pointSlack({
      slack,
      voiceflow,
      requestUrl: requestUrl!,
      ...(o['tools-url'] ? { toolsUrl: o['tools-url'] } : {}),
      ...(o.app ? { appId: o.app } : {}),
      onProgress: out,
    });
    return 0;
  }

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
  let tunnel: Tunnel | undefined;
  let result: ConnectResult;
  // A plan only shown opens no tunnel: it says where one would go.
  const planned = (lines: string[]) =>
    local && o['dry-run'] ? lines.map((line) => line.replaceAll(`${NOT_YET}/api/slack`, "a temporary tunnel's address")) : lines;
  try {
    if (local && o['dry-run']) requestUrl = `${NOT_YET}/api/slack`;
    else if (local) {
      tunnel = await startTunnel({ port: Number(o.port), interactive, ask, say: out, instead: NO_TUNNEL, ...(io.tunnel ? { host: io.tunnel } : {}) });
      requestUrl = `${tunnel.url}/api/slack`;
      out(`No --public-url, so Slack gets a temporary address while the app is made: ${tunnel.url}\n`);
    }
    result = await connectSlack({
      slack,
      voiceflow,
      requestUrl: requestUrl!,
      ...(o['tools-url'] ? { toolsUrl: o['tools-url'] } : {}),
      ...(o.app ? { appId: o.app } : {}),
      app: { ...app, ...(icon !== undefined ? { icon } : {}) },
      tools,
      ...restore,
      confirm: (plan) => confirm([...planned(plan.lines), ...after(plan.app.action === 'create' && !o['no-greeting'] && Boolean(plan.me))]),
      onProgress: out,
      // Each credential is one to hide from the moment it exists, before anything after it can fail.
      onCredentials: async (c) => {
        secrets.add(c.botToken, c.signingSecret);
        if (envFile) await writeEnvFile(envFile, { SLACK_BOT_TOKEN: c.botToken, SLACK_SIGNING_SECRET: c.signingSecret });
      },
    });
  } finally {
    await checker.close();
    await tunnel?.close();
  }
  secrets.add(result.botToken, result.signingSecret, result.userToken);
  if (!result.applied) return 0;
  const saved = await save(agent);
  const published = await publish(Boolean(result.install));
  // A new app says so itself, in Slack: the proof that it's installed and can speak.
  if (result.created && !o['no-greeting'] && result.plan.me && result.botToken) {
    const text = greetingText({
      name: result.plan.app.name,
      team: result.plan.team.name,
      environment,
      tools: Boolean(result.install),
      published: published === 'published',
    });
    const why = await sendGreeting({ botToken: result.botToken, userId: result.plan.me.id, text, ...withFetch });
    if (why) err(`! The bot couldn't message you in Slack (${why}). Message it yourself once your server is running.`);
    else out(`+ ${result.plan.app.name} messaged you in Slack: look for it under Apps`);
  }
  const page = (tab: string) => `https://api.slack.com/apps/${result.appId}/${tab}`;
  printSettings(
    {
      heading: `Connected: Slack app ${result.appId}, bot user ${result.botUserId}.`,
      token: envFile ? `in ${envFile}` : `not saved: copy it from OAuth & Permissions, ${page('oauth')}`,
      secret: result.signingSecret
        ? envFile
          ? `in ${envFile}`
          : `not saved: copy it from Basic Information, ${page('general')}`
        : `unchanged (the app already existed): Basic Information, ${page('general')}`,
      key: envFile && (inFile.VOICEFLOW_API_KEY || saved.includes('VOICEFLOW_API_KEY')) ? `in ${envFile}` : 'your Voiceflow API key',
      sends: local
        ? "Slack has a temporary address, which has stopped. Start your server with `voiceflow-channels dev -- <its command>` (`npm run dev` in an app the starter made): it opens a tunnel and points Slack, and the agent's tools, at it."
        : `Slack sends to ${requestUrl}.`,
      projectID: project,
      environment,
      published: published === 'published',
      ...(result.install ? { toolsUrl: local ? 'the address dev gives them' : result.toolsUrl! } : {}),
    },
    out,
  );
  report(result.install, err);
  return published === 'failed' ? 1 : 0;
}

/** What the tools' install couldn't do, or wants you to know. */
function report(install: ConnectResult['install'] | OwnAppResult['install'], err: Say) {
  for (const problem of install?.problems ?? []) err(`! ${problem}`);
  for (const note of install?.notes ?? []) err(`! ${note}`);
}

function printSettings(
  s: {
    heading: string;
    token: string;
    secret: string;
    key: string;
    sends: string;
    projectID: string;
    environment: string;
    published: boolean;
    toolsUrl?: string;
  },
  out: Say,
) {
  out(`
${s.heading}

Your server needs:
  SLACK_BOT_TOKEN       ${s.token}
  SLACK_SIGNING_SECRET  ${s.secret}
  VOICEFLOW_API_KEY     ${s.key}

  createChannels({
    voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY, projectID: '${s.projectID}', environment: '${s.environment}' },
    channels: [slack()],
  })

${s.sends}${
  s.toolsUrl
    ? `
The agent's Slack tools call your server at ${s.toolsUrl}: it runs them, with its own SLACK_BOT_TOKEN.
Those that act in Slack answer only in Slack: in Voiceflow's test chat they say so.
${
  s.published
    ? `${s.environment} is published: the agent in Slack has the tools now.`
    : `The tools are on the ${s.environment} environment's draft. Your bot runs its published version, so the agent in Slack has them only once you publish ${s.environment}: in Voiceflow, or with --publish.`
}`
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
    throw new NeedsYou(`No Voiceflow API key: set VOICEFLOW_API_KEY${from.envFile ? `, here or in ${from.envFile},` : ''} or pass --key-file.`);
  }
  const key = await from.secret('Voiceflow API key (hidden): ');
  if (!key) throw new Error('No Voiceflow API key entered.');
  return { value: key, typed: true };
}

/**
 * The credentials of a Slack app you made by hand: from the environment, the
 * env file, or (asked of a person) hidden prompts. `typed` are the ones that
 * were asked for, to save for the server.
 */
async function ownCredentials(from: {
  env: Record<string, string | undefined>;
  inFile: Record<string, string>;
  envFile?: string;
  interactive: boolean;
  secret: (question: string) => Promise<string>;
}): Promise<{ botToken: string; signingSecret: string; typed: [name: string, value: string][] }> {
  const typed: [name: string, value: string][] = [];
  const get = async (name: 'SLACK_BOT_TOKEN' | 'SLACK_SIGNING_SECRET', label: string): Promise<string> => {
    const value = from.env[name] || from.inFile[name];
    if (value || !from.interactive) return value ?? '';
    const answer = (await from.secret(`${label} (hidden): `)).trim();
    if (!answer) throw new Error(`No ${name} entered.`);
    typed.push([name, answer]);
    return answer;
  };
  const botToken = await get('SLACK_BOT_TOKEN', "Your Slack app's Bot User OAuth Token, from its OAuth & Permissions page");
  const signingSecret = await get('SLACK_SIGNING_SECRET', "Your Slack app's Signing Secret, from its Basic Information page");
  const absent = [
    ...(botToken ? [] : ['SLACK_BOT_TOKEN (OAuth & Permissions > Bot User OAuth Token)']),
    ...(signingSecret ? [] : ['SLACK_SIGNING_SECRET (Basic Information > Signing Secret)']),
  ];
  if (absent.length) {
    throw new NeedsYou(
      `--manual works with the Slack app you made. Set ${absent.join(' and ')}${from.envFile ? `, here or in ${from.envFile}` : ''}, from the app's settings at https://api.slack.com/apps. Then run this again.`,
    );
  }
  return { botToken, signingSecret, typed };
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
