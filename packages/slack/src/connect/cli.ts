// The command line for `connect slack` and `disconnect slack`:
//
//   npx voiceflow-channels connect slack --public-url https://<host> --dotenv .env.local
//
// Secrets never reach the screen or the command line: the Voiceflow API key is
// read from a file (--key-file), VOICEFLOW_API_KEY, your server's env file
// (--dotenv) or a hidden prompt; the Slack login is the Slack CLI's, which
// connect refreshes, or makes with `slack login`, when it has to (sign-in.ts);
// the app's credentials go only to that env file, written readable by you
// alone, and never to Voiceflow.
// Every line this prints, an error's included, is first cleaned of the secrets
// it holds: a server that repeats one back in an error can't put it on screen.
import http from 'node:http';
import { parseArgs } from 'node:util';
import { createRedactor } from '@voiceflow/channels-sdk';
import { checkTunnelTool, startTunnel, type Tunnel, type TunnelHost } from '@voiceflow/channels-sdk/dev';
import {
  ENV_FILE_FLAGS,
  envFileOf,
  hidden,
  previewPublish,
  publishPlanLine,
  publishStep,
  question,
  readEnvFile,
  resolveAgent,
  type Say,
  saveEnv,
  voiceflowKey,
  writeEnvFile,
} from '@voiceflow/channels-sdk/setup';
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
  voiceflow-channels connect slack [--public-url <https://host>] [--dotenv <path>] [options]
  voiceflow-channels connect slack --manual --public-url <https://host> [--dotenv <path>]
  voiceflow-channels point slack --public-url <https://host> [--dotenv <path>]
  voiceflow-channels disconnect slack [--dotenv <path>] [--remove-tools] [--yes]
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
environment, then the same names in --dotenv. What's still missing is asked
for, the key in a hidden prompt.

Connect works in Slack with the Slack CLI's login. It refreshes a login that
has expired, asks which workspace when there are several, runs \`slack login\`
when there is none, and offers Slack's installer when there is no Slack CLI.
With nobody at the terminal it stops instead, saying what to do and how to
carry on.

With --manual, connect leaves Slack to you: for an app you made and installed
by hand, it checks the app's scopes and installs the tools on the agent, and
needs no Slack CLI. It reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the
environment or --dotenv, or asks for them.

Without --public-url, connect is for a server on this machine: it opens a
temporary tunnel so Slack has an address while the app is made, and
\`voiceflow-channels dev\` gives Slack your server's address each time it
starts. Pass --public-url for a server that has an address of its own.

Point moves a connected app, and the agent's Slack tools, to another address,
and changes nothing else: \`voiceflow-channels dev\` runs it on each start.
Slack checks the address as it takes it, so your server has to be answering.

It exits 0 when done, 1 on a failure, 2 on a mistake in the command, and 3
when it's waiting on you: do what it says, then run it again. With nobody at
the terminal, everything it's waiting on is said in the one stop: which agent,
its key, the Slack sign-in.

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
  --dotenv <path>         your server's env file. Connect reads the Voiceflow
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
  --dry-run               show the plan and stop: what would be made in Slack and put
                          on the agent, and what a publish would carry
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

/** Said wherever a tunnel can't be opened: the way to do without one. */
const NO_TUNNEL = "Or give connect your server's address: --public-url https://<host>.";
/** Stands in for a tunnel's address in a plan that is only shown. */
const NOT_YET = 'https://temporary-tunnel.invalid';
/** The release a publish by connect makes in Voiceflow. */
const RELEASE_NAME = 'Slack tools (Channels SDK)';
const RELEASE_DESCRIPTION = 'Published by `voiceflow-channels connect slack`, on a yes.';

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
      ...ENV_FILE_FLAGS,
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
  const envFile = envFileOf(o, err);
  const inFile = envFile ? await readEnvFile(envFile) : {};
  secrets.add(inFile.VOICEFLOW_API_KEY, inFile.SLACK_BOT_TOKEN, inFile.SLACK_SIGNING_SECRET);
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY);
  const ask = io.ask ?? question;
  // A flag wins, then the environment, then the env file. A person is asked for what's left.
  if (action !== 'disconnect' && !requestUrl && !local) {
    err(
      `Missing --public-url: ${o.manual ? "the address your app's settings point at" : "your server's public address, where Slack sends its requests"}.\n\n${USAGE}`,
    );
    return 2;
  }
  // A flag wins, then the environment, then the env file. A person is asked for what's left.
  const {
    project,
    environment,
    missing,
    waiting: agentWaits,
  } = await resolveAgent(
    { ...(o.project ? { project: o.project } : {}), ...(o.environment ? { environment: o.environment } : {}) },
    { env: io.env, inFile, ...(envFile ? { envFile } : {}), interactive, ask },
  );
  // A person who was asked and gave nothing made a mistake in the command. A script wasn't asked: it's waiting on someone.
  if (missing.length && interactive) {
    err(`Missing ${missing.join(' and ')}${envFile ? `, in the environment or in ${envFile}` : ''}.\n\n${USAGE}`);
    return 2;
  }

  const withFetch = io.fetch ? { fetch: io.fetch } : {};
  // With nobody to ask, everything a person has to do is said in one stop, not one thing per run.
  const waiting: string[] = [];
  waiting.push(...agentWaits);
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

  const io2 = { interactive, ask, out, err };
  const flags = { publish: o.publish, noPublish: o['no-publish'] };
  const save = (values: [name: string, value: string][]) => saveEnv({ ...(envFile ? { envFile } : {}), inFile }, values, io2);
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
    publishPlanLine(environment, flags, interactive, tools !== false),
    ...(greets ? ["  + the bot messages you in Slack to say it's connected"] : []),
  ];
  const publish = (installed: boolean) => publishStep(voiceflow, flags, io2, { name: RELEASE_NAME, description: RELEASE_DESCRIPTION }, installed);
  /** For a plan that is only shown: what a publish would carry, so one answer can cover the plan and the publish. */
  const preview = async (installs: boolean) => {
    if (o['dry-run']) await previewPublish(voiceflow, flags, io2, installs);
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
    if (!result.applied) {
      await preview(tools !== false);
      return 0;
    }
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
  if (!result.applied) {
    await preview(tools !== false);
    return 0;
  }
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

// The env file and the prompts are core's, shared by every channel's command. They are exported from here as they always were.
export { hidden, readEnvFile, writeEnvFile };
