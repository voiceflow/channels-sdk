// The command line for `connect teams`, `point teams` and `disconnect teams`:
//
//   npx voiceflow-channels connect teams --env-file .env.local
//
// Secrets never reach the screen or the command line. Your Voiceflow API key
// is read from a file that holds only it, the environment, your server's env
// file (--env-file) or a hidden prompt. The bot's secret is made by Microsoft
// and goes straight to that env file, written readable by you alone, and
// never to Voiceflow. Your Microsoft 365 sign-in is Microsoft's own command's:
// this never sees your password or its tokens.
// Every line this prints, an error's included, is first cleaned of the secrets
// it holds: a server that repeats one back in an error can't put it on screen.
import { parseArgs } from 'node:util';
import { createRedactor, NeedsYou } from '@voiceflow/channels-sdk';
import {
  BARE,
  canOpenBrowser,
  hidden,
  iconUrl,
  openInBrowser,
  previewPublish,
  publishStep,
  question,
  readEnvFile,
  resolveAgent,
  type Say,
  voiceflowKey,
  writeEnvFile,
} from '@voiceflow/channels-sdk/setup';
import {
  checkServer,
  connectTeams,
  disconnectSteps,
  isLoopback,
  MAX_NAME,
  pointTeams,
  signInSteps,
  THREAD_PERMISSION,
  uploadProblem,
  WEBHOOK_PATH,
} from './connect.js';
import { createMsCli, MS_CLI_NPX, type MsAccount, type MsCli, msRunner } from './ms.js';

const USAGE = `Usage:
  voiceflow-channels connect teams --env-file <path> [--public-url <https://host>] [options]
  voiceflow-channels point teams --public-url <https://host> [--env-file <path>]
  voiceflow-channels disconnect teams [--env-file <path>]

Connect sets up a bot in Microsoft Teams for your Voiceflow agent. It runs
Microsoft's own Teams command (${MS_CLI_NPX}) to make the app, its
bot and the bot's secret: no Azure account is needed. The first time, that
command has you sign in to Microsoft 365, with the account you use Teams with.

Then connect gives the bot your agent's name and picture, asks for the
permission that lets it read a thread's replies, creates the teams_* variables
on your agent, writes what your server needs to --env-file, and gives you the
link that adds the bot in Teams. It shows the plan and asks before changing
anything. Run again, it keeps the app it made and adds only what's missing.

Two things are Microsoft's to allow, and connect says so when they aren't:
your organization has to let people add apps of their own to Teams (an admin
turns that on, once), and you click Add in Teams yourself.

Your Voiceflow API key, project and environment come from the flags below,
then VOICEFLOW_API_KEY, VOICEFLOW_PROJECT_ID and VOICEFLOW_ENVIRONMENT in the
environment, then --env-file; a person is asked for what's left.

Teams sends the bot's messages to an address. Without --public-url, connect is
for a server on this machine: \`voiceflow-channels dev\` gives Teams your
server's address each time it starts. Pass --public-url for a server that has
an address of its own.

Nothing has to be published for the bot to work. The variables are for your
agent's prompts: they go on the environment's draft, and are live once you
publish it. --publish does that here: the whole draft goes live.

Point gives Teams another address for the bot's messages, and changes nothing
else: \`voiceflow-channels dev\` runs it on each start. Teams takes it at once;
nobody adds the bot again.

Disconnect says how to remove the bot: Microsoft gives no command for it.

It exits 0 when done, 1 on a failure, 2 on a mistake in the command, and 3
when it's waiting on you: do what it says, then run it again.

Options:
  --project <id>          the Voiceflow project (agent)
  --environment <alias>   the environment whose draft gets the variables
  --workspace <id>        stop, changing nothing, unless the project is in this
                          Voiceflow workspace
  --public-url <url>      your server's public address; Teams sends the bot's
                          messages to <url>${WEBHOOK_PATH}
  --request-url <url>     or the whole URL, if it isn't <url>${WEBHOOK_PATH}
  --local-url <url>       point: your server on this machine (http://127.0.0.1:3000).
                          It is asked first, so a server that's down, or has no
                          Teams route, is said here and nothing is changed
  --name <name>           the bot's name in Teams, at most ${MAX_NAME} characters
                          (default: your agent's name in Voiceflow, on a new app)
  --icon <url|none>       the bot's picture, a PNG's URL (default: a new app gets
                          the agent's avatar in Voiceflow, or Voiceflow's icon)
  --mentions-only         don't ask for the permission that lets the bot read a
                          thread's replies (${THREAD_PERMISSION}). With it
                          Teams sends the bot everything written in a channel it's
                          added to; without it, every message to the bot in a
                          channel needs a mention
  --device-code           sign in to Microsoft 365 with a link and a code, where no
                          browser can open here (the default over SSH)
  --no-open               open no page in your browser: the link is printed
  --no-variables          create no variables on the agent (then pass
                          context: false to teams() on your server)
  --env-file <path>       your server's env file. Connect reads the Voiceflow
                          values and TEAMS_APP_ID from it, and writes to it
                          TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_APP_TENANT_ID
                          and any value it had to ask for
  --key-file <path>       a file holding only the Voiceflow API key
  --publish               publish the environment once the variables are on its
                          draft, without asking: its whole draft goes live
  --no-publish            don't publish (the default)
  --dry-run               show the plan and stop
  --yes                   don't ask before going ahead`;

/** What the command reads and writes, for a test or a program that runs it: by default the console, the environment and `fetch`. */
export interface CliIO {
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  cwd?: string;
  fetch?: typeof fetch;
  /** Whether a person is there to answer a question. */
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  /** Asks for a secret, without showing what's typed. */
  secret?: (question: string) => Promise<string>;
  /** Opens a page in the person's browser, and says whether it could. Default: their own browser, where there is one here. */
  open?: (url: string) => Promise<boolean>;
  /** Microsoft's Teams command, in place of the real one: for a test. */
  microsoft?: MsCli;
}

const RELEASE_NAME = 'Teams variables (Channels SDK)';
const RELEASE_DESCRIPTION = 'Published by `voiceflow-channels connect teams --publish`.';

/** Runs the command. Returns its exit code: an error is printed, cleaned of every secret the command holds, and never thrown. */
export async function cli(argv: string[], io: CliIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const secrets = createRedactor(env.VOICEFLOW_API_KEY, env.TEAMS_APP_PASSWORD);
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
      'local-url': { type: 'string' },
      name: { type: 'string' },
      icon: { type: 'string' },
      'mentions-only': { type: 'boolean', default: false },
      'device-code': { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      // Set by `voiceflow-channels dev` when it runs connect itself: the server starts next, so nobody is told to start it.
      'from-dev': { type: 'boolean', default: false },
      'no-variables': { type: 'boolean', default: false },
      'env-file': { type: 'string' },
      'key-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      'no-publish': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const action = positionals[0] ?? 'connect';
  if (o.help || !['connect', 'disconnect', 'point'].includes(action)) {
    out(USAGE);
    return o.help ? 0 : 2;
  }
  if (o.publish && o['no-publish']) {
    err('--publish and --no-publish say opposite things: pass one.');
    return 2;
  }
  const name = o.name?.trim();
  if (o.name !== undefined && (!name || name.length > MAX_NAME)) {
    err(`--name takes the bot's name in Teams, at most ${MAX_NAME} characters${name ? `: "${name}" is ${name.length}` : ''}.`);
    return 2;
  }
  const icon = o.icon === undefined ? undefined : o.icon === 'none' ? (false as const) : o.icon;
  if (typeof icon === 'string' && !iconUrl(icon)) {
    err(`--icon takes a PNG's http(s) URL, or "none": "${icon}" isn't one.`);
    return 2;
  }
  const requestUrl = o['request-url'] ?? (o['public-url'] ? `${o['public-url'].replace(/\/+$/, '')}${WEBHOOK_PATH}` : undefined);
  if (action === 'point' && !requestUrl) {
    err(`Missing --public-url: your server's public address, where Teams sends the bot's messages.\n\n${USAGE}`);
    return 2;
  }
  if (requestUrl && !/^https:\/\//.test(requestUrl)) {
    err(`Teams sends only to an https address, and "${requestUrl}" isn't one.`);
    return 2;
  }

  const envFile = o['env-file'];
  const inFile = envFile ? await readEnvFile(envFile) : {};
  secrets.add(inFile.VOICEFLOW_API_KEY, inFile.TEAMS_APP_PASSWORD);
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY);
  const ask = io.ask ?? question;
  const secret = io.secret ?? hidden;
  const withFetch = io.fetch ? { fetch: io.fetch } : {};
  const microsoft = io.microsoft ?? createMsCli(msRunner({ env: io.env, ...(io.cwd ? { cwd: io.cwd } : {}) }));
  const appId = io.env.TEAMS_APP_ID || inFile.TEAMS_APP_ID;
  const connectAgain = `voiceflow-channels connect teams${envFile ? ` --env-file ${envFile}` : ' --env-file <path>'}`;

  /** Has a person sign in to Microsoft 365, in Microsoft's own command: a browser where one can open here, a link and a code where not. */
  const signIn = async () => {
    const deviceCode = o['device-code'] || !canOpenBrowser(io.env);
    out(
      `Sign in to Microsoft 365, with the account you use Teams with. ${deviceCode ? "Microsoft's command prints a link and a code to enter there:" : "Microsoft's command opens your browser for it:"}\n`,
    );
    if (!(await microsoft.signIn({ deviceCode }))) throw new Error(`The sign-in didn't finish. Run this again, or sign in yourself first: ${MS_CLI_NPX} login`);
    out('');
  };

  if (action === 'disconnect') {
    if (!appId) throw new NeedsYou(`No TEAMS_APP_ID ${envFile ? `in ${envFile}` : 'in the environment'}: there is no bot connected from here to remove.`);
    // Nothing can be removed from here: what's said is the whole of it, and all of it is a person's to do.
    err(disconnectSteps(appId).join('\n'));
    return 3;
  }

  if (action === 'point') {
    if (!appId) throw new NeedsYou(`No TEAMS_APP_ID ${envFile ? `in ${envFile}` : 'in the environment'}. Run connect first: ${connectAgain}.`);
    if (o['local-url']) {
      const at = `${o['local-url'].replace(/\/+$/, '')}${new URL(requestUrl!).pathname}`;
      if (!isLoopback(at)) {
        err(`--local-url is your server on this machine, and "${o['local-url']}" isn't.`);
        return 2;
      }
      await checkServer({ url: at, ...withFetch });
      out(`= your server has its Teams route at ${at}, and refuses a request that isn't Teams'`);
    }
    try {
      await pointTeams({ microsoft, appId, endpoint: requestUrl!, onProgress: out });
    } catch (error) {
      // A sign-in runs out in time. A person who is there (dev was started by one) signs in again, and it goes on.
      if (!(error instanceof NeedsYou) || !interactive || (await microsoft.account()).signedIn) throw error;
      await signIn();
      await pointTeams({ microsoft, appId, endpoint: requestUrl!, onProgress: out });
    }
    return 0;
  }

  // Connect makes a secret, and it has to land somewhere the server reads: said before anything is asked or made.
  if (!envFile && !appId && !o['dry-run']) {
    err(`connect teams makes the bot's secret, which has to be written where your server reads it: pass --env-file <path> (.env.local, say).\n\n${USAGE}`);
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
  if (missing.length && interactive) {
    err(`Missing ${missing.join(' and ')}${envFile ? `, in the environment or in ${envFile}` : ''}.\n\n${USAGE}`);
    return 2;
  }
  // With nobody to ask, everything a person has to do is said in one stop, not one thing per run.
  const waiting: string[] = [...agentWaits];
  let key: { value: string; typed: boolean } | undefined;
  try {
    key = await voiceflowKey({ file: o['key-file'], env: io.env, inFile, envFile, interactive, secret });
  } catch (error) {
    if (interactive || !(error instanceof NeedsYou)) throw error;
    waiting.push(error.message);
  }
  secrets.add(key?.value);

  // Who is signed in to Microsoft 365. A person who is there signs in now, in Microsoft's own command.
  let account: MsAccount | undefined = await microsoft.account();
  if (!account.signedIn && interactive && !o['dry-run']) {
    await signIn();
    account = await microsoft.account();
  }
  if (!account.signedIn) waiting.push(signInSteps());
  else {
    const blocked = uploadProblem(account);
    if (blocked) waiting.push(blocked);
  }
  if (waiting.length || !key) throw new NeedsYou(waiting.join('\n\n'));

  const io2 = { interactive, ask, out, err };
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
  // Nothing has to be published for the bot to work, so nothing is, and nobody is asked, without --publish.
  const flags = { publish: o.publish, noPublish: !o.publish };
  const voiceflow = { apiKey: key.value, projectID: project, environment, ...(o.workspace ? { expectWorkspace: o.workspace } : {}), ...withFetch };
  const variables = !o['no-variables'];
  const saved: string[] = [];
  const result = await connectTeams({
    microsoft,
    account,
    voiceflow,
    ...(appId ? { appId } : {}),
    ...(requestUrl ? { endpoint: requestUrl } : {}),
    ...(name ? { name } : {}),
    ...(icon !== undefined ? { icon } : {}),
    threadReplies: !o['mentions-only'],
    variables,
    ...withFetch,
    // The secret is shown this once: it is in the env file before anything that could fail is tried.
    save: async (made) => {
      secrets.add(made.password);
      // Written whatever it holds: the secret is shown this once. One an env file would read back as something
      // else goes in quotes, which every parser takes.
      const written = (value: string) => (BARE.test(value) || value.includes("'") ? value : `'${value}'`);
      const values = { TEAMS_APP_ID: made.appId, TEAMS_APP_PASSWORD: written(made.password), TEAMS_APP_TENANT_ID: made.tenantId };
      await writeEnvFile(envFile!, values);
      saved.push(...Object.keys(values));
      out(`+ saved ${Object.keys(values).join(', ')} to ${envFile}`);
    },
    confirm: (plan) =>
      confirm([
        ...plan.lines,
        'Then:',
        o.publish
          ? `  + publish ${environment}: its whole draft goes live (--publish)`
          : `  · nothing is published, and nothing has to be${variables ? `: the variables are live once you publish ${environment}` : ''}`,
        ...(plan.app ? [] : [`  + ${envFile} gets TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID`]),
        '  + you get the link that adds the bot in Teams',
      ]),
    onProgress: out,
  });
  if (!result.applied) {
    if (o['dry-run'] && o.publish) await previewPublish(voiceflow, { publish: true, noPublish: false }, io2, result.plan.installs);
    return 0;
  }
  const app = result.app!;
  // What the file lacks of the Voiceflow values, and a key typed here: never over a value that's there.
  if (envFile) {
    const more = Object.fromEntries(
      (
        [
          ['VOICEFLOW_API_KEY', key.typed ? key.value : ''],
          ['VOICEFLOW_PROJECT_ID', project],
          ['VOICEFLOW_ENVIRONMENT', environment],
        ] as const
      ).filter(([variable, value]) => value && !inFile[variable] && BARE.test(value)),
    );
    if (Object.keys(more).length) {
      await writeEnvFile(envFile, more);
      saved.push(...Object.keys(more));
      out(`+ saved ${Object.keys(more).join(', ')} to ${envFile}`);
    }
  }
  const published = o.publish ? await publishStep(voiceflow, flags, io2, { name: RELEASE_NAME, description: RELEASE_DESCRIPTION }, true) : 'not';

  const where = (variable: string, otherwise: string) => (envFile && (inFile[variable] || saved.includes(variable)) ? `in ${envFile}` : otherwise);
  // The one step left to a person: the page is opened for it, for someone who is there, in a browser that is theirs.
  const opener = interactive && !o['no-open'] ? (io.open ?? (canOpenBrowser(io.env) ? openInBrowser : undefined)) : undefined;
  const opened = app.installLink && opener && !result.plan.app ? await opener(app.installLink).catch(() => false) : false;
  out(`
Connected: Teams app ${app.id} "${app.name}", in ${account.username}'s organization.

Your server needs:
  TEAMS_APP_ID          ${where('TEAMS_APP_ID', app.id)}
  TEAMS_APP_PASSWORD    ${where('TEAMS_APP_PASSWORD', "the bot's secret, where connect put it")}
  TEAMS_APP_TENANT_ID   ${where('TEAMS_APP_TENANT_ID', account.tenantId)}
  VOICEFLOW_API_KEY     ${where('VOICEFLOW_API_KEY', 'your Voiceflow API key')}

  createChannels({
    voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY, projectID: '${project}', environment: '${environment}' },
    channels: [teams()],
  })

${result.plan.app ? 'To add the bot in Teams' : 'Add the bot in Teams'}: ${opened ? 'the page is open in your browser.' : 'open this link.'} Choose "Use the web app instead" if you don't have Teams' desktop app, then click Add. From there, Open starts a chat with the bot, and picking a team's channel adds it there.

  ${app.installLink || `${MS_CLI_NPX} app get ${app.id} --install-link`}

${
  requestUrl
    ? `Teams sends the bot's messages to ${requestUrl}.`
    : o['from-dev']
      ? 'Your server starts next: dev gives Teams its address.'
      : "Then start your server with `voiceflow-channels dev -- <its command>` (`npm run dev` in an app the starter made): it gives Teams your server's address, each time it starts."
}${variables ? `\nThe teams_* variables are on ${environment}'s draft, for your agent's prompts: {teams_user_name}, say.${published === 'published' ? '' : ` They're live once you publish ${environment}.`}` : ''}`);
  for (const problem of result.install?.problems ?? []) err(`! ${problem}`);
  return published === 'failed' ? 1 : 0;
}

/**
 * Whether a Teams bot has been connected from here: its app's ID, its secret and its organization's ID are all
 * in the environment or the env file. `voiceflow-channels dev` asks, and runs connect first when it hasn't.
 */
export async function connected(options: { envFile?: string; env?: Record<string, string | undefined> } = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const inFile = options.envFile ? await readEnvFile(options.envFile) : {};
  return ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_APP_TENANT_ID'].every((variable) => Boolean(env[variable] || inFile[variable]));
}
