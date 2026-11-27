// The command line for `connect discord`, `point discord` and `disconnect discord`:
//
//   npx voiceflow-channels connect discord --dotenv .env.local
//
// Secrets never reach the screen or the command line: the Voiceflow API key
// and the Discord bot token are each read from a file that holds only it,
// the environment, your server's env file (--dotenv) or a hidden prompt.
// The bot token goes only to Discord and to that env file, written readable
// by you alone, and never to Voiceflow.
// Every line this prints, an error's included, is first cleaned of the secrets
// it holds: a server that repeats one back in an error can't put it on screen.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRedactor, NeedsYou } from '@voiceflow/channels-sdk';
import { checkProject } from '@voiceflow/channels-sdk/install';
import {
  canOpenBrowser,
  ENV_FILE_FLAGS,
  envFileOf,
  hidden,
  iconUrl,
  openInBrowser,
  previewPublish,
  publishStep,
  question,
  readEnvFile,
  resolveAgent,
  type Say,
  saveEnv,
  voiceflowKey,
} from '@voiceflow/channels-sdk/setup';
import { type ForwardGatewayOptions, forwardGateway } from '../gateway.js';
import { createDiscordApi, DEVELOPER_PORTAL, installLink, isSnowflake, NEW_APPLICATION } from './api.js';
import {
  botNameOf,
  checkServer,
  commandName,
  connectDiscord,
  DEFAULT_COMMAND,
  disconnectDiscord,
  greetingText,
  isLoopback,
  pointDiscord,
  readApp,
  readsMessages,
  sendGreeting,
  WEBHOOK_PATH,
  waitForServer,
} from './connect.js';

const USAGE = `Usage:
  voiceflow-channels connect discord [--public-url <https://host>] [--dotenv <path>] [options]
  voiceflow-channels point discord --public-url <https://host> [--dotenv <path>]
  voiceflow-channels disconnect discord [--dotenv <path>] [--yes]

Connect sets up a Discord bot for your Voiceflow agent. Discord has no way to
make an application from here, so that one step is by hand: connect opens
${NEW_APPLICATION} for you
to make one; open its Bot page, and copy its token.
With the token, connect does the rest: it gives a new bot your agent's name
and picture, turns on the intent that lets the bot read what people write,
adds the slash command, creates the discord_* variables on your agent, and
gives you the link that adds the bot to a server. It shows the plan and asks
before changing anything.

The bot token comes from --token-file, then DISCORD_BOT_TOKEN in the
environment, then the same name in --dotenv; a person is asked for it in a
hidden prompt. Your Voiceflow API key, project and environment come the same
way: the flags below, VOICEFLOW_API_KEY, VOICEFLOW_PROJECT_ID and
VOICEFLOW_ENVIRONMENT, then --dotenv.

Discord sends what people write over a standing connection, and slash
commands and button clicks to an address. Without --public-url, connect is
for a server on this machine: \`voiceflow-channels dev\` holds the connection
and gives Discord your server's address each time it starts. Pass --public-url
for a server that has an address of its own: Discord checks it answers there.

Nothing has to be published for the bot to work. The variables are for your
agent's prompts: they go on the environment's draft, and are live once you
publish it. --publish does that here: the whole draft goes live.

Point gives Discord another address for slash commands and buttons, and
changes nothing else: \`voiceflow-channels dev\` runs it on each start.

It exits 0 when done, 1 on a failure, 2 on a mistake in the command, and 3
when it's waiting on you: do what it says, then run it again.

Options:
  --project <id>          the Voiceflow project (agent)
  --environment <alias>   the environment whose draft gets the variables
  --workspace <id>        stop, changing nothing, unless the project is in this
                          Voiceflow workspace
  --public-url <url>      your server's public address; Discord sends slash commands
                          and buttons to <url>${WEBHOOK_PATH}
  --request-url <url>     or the whole URL, if it isn't <url>${WEBHOOK_PATH}
  --local-url <url>       point: your server on this machine (http://127.0.0.1:3000).
                          It is asked first, so a server that's down, or runs with
                          another bot token, is said here and nothing is changed
  --command </name|none>  the slash command (default /${DEFAULT_COMMAND})
  --name <name|keep>      the bot's name in Discord (default: a new app's bot gets
                          your agent's name in Voiceflow; a bot connected before
                          keeps its name)
  --icon <url|none>       the bot's picture, an image's URL (default: a bot with no
                          picture gets the agent's avatar in Voiceflow, or
                          Voiceflow's icon when it has none; a bot with a picture
                          keeps it)
  --server <id>           the Discord server to add the bot to: the page that adds
                          it opens with that server chosen
  --no-open               open no page in your browser: the links are printed
  --no-wait               don't wait for the bot to be added to a server
  --no-greeting           don't have the bot message you in Discord once it's in one
  --no-variables          create no variables on the agent (then pass
                          context: false to discord() on your server)
  --dotenv <path>         your server's env file. Connect reads the bot token and
                          the Voiceflow values from it, and writes to it
                          DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID and any value
                          it had to ask for. A value already there is never changed
  --token-file <path>     a file holding only the Discord bot token
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
  fetch?: typeof fetch;
  /** Whether a person is there to answer a question. */
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  /** Asks for a secret, without showing what's typed. */
  secret?: (question: string) => Promise<string>;
  /** Opens a page in the person's browser, and says whether it could. Default: their own browser, where there is one here. */
  open?: (url: string) => Promise<boolean>;
  /** Waits, between looks at whether the bot has been added to a server. Default: a timer. */
  wait?: (ms: number) => Promise<void>;
  /** Holds Discord's Gateway connection, in place of the real one: for a test. */
  gateway?: (options: ForwardGatewayOptions) => Promise<void>;
}

const RELEASE_NAME = 'Discord variables (Channels SDK)';
const RELEASE_DESCRIPTION = 'Published by `voiceflow-channels connect discord --publish`.';

/**
 * How to get a bot token: the one step Discord leaves to a person. The link opens the dialog that makes an
 * application; Discord has no way to fill the name in, so the agent's is said here.
 */
function tokenSteps(agentName: string | undefined, opened: boolean): string {
  const name = agentName ? `Name it "${agentName}"` : 'Name it after your agent';
  return `Discord has no way to make an application from here, so this one step is by hand:
  1. Make the application${opened ? ' (the page is open in your browser)' : ''}: ${NEW_APPLICATION}
     ${name}: that name shows on the page that adds the bot. Tick the box and click Create.
  2. Open its Bot page, click Reset Token, and copy the token.`;
}

/** Runs the command. Returns its exit code: an error is printed, cleaned of every secret the command holds, and never thrown. */
export async function cli(argv: string[], io: CliIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const secrets = createRedactor(env.VOICEFLOW_API_KEY, env.DISCORD_BOT_TOKEN);
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
      command: { type: 'string' },
      name: { type: 'string' },
      icon: { type: 'string' },
      server: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
      'no-greeting': { type: 'boolean', default: false },
      // Set by `voiceflow-channels dev` when it runs connect itself: the server starts next, so nobody is told to start it.
      'from-dev': { type: 'boolean', default: false },
      'no-variables': { type: 'boolean', default: false },
      ...ENV_FILE_FLAGS,
      'token-file': { type: 'string' },
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
  const command = o.command === undefined ? undefined : o.command === 'none' ? (false as const) : o.command;
  if (typeof command === 'string') {
    try {
      commandName(command);
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  const name = o.name === undefined ? undefined : o.name === 'keep' ? (false as const) : o.name.trim();
  if (name === '') {
    err('--name takes the bot\'s name, or "keep".');
    return 2;
  }
  const icon = o.icon === undefined ? undefined : o.icon === 'none' ? (false as const) : o.icon;
  if (typeof icon === 'string' && !iconUrl(icon)) {
    err(`--icon takes an image's http(s) URL, or "none": "${icon}" isn't one.`);
    return 2;
  }
  if (o.server !== undefined && !isSnowflake(o.server)) {
    err(
      `--server takes a Discord server's ID (17 to 20 digits), and "${o.server}" isn't one. In Discord: Settings → Advanced → Developer Mode, then right-click the server → Copy Server ID.`,
    );
    return 2;
  }
  const requestUrl = o['request-url'] ?? (o['public-url'] ? `${o['public-url'].replace(/\/+$/, '')}${WEBHOOK_PATH}` : undefined);
  if (action === 'point' && !requestUrl) {
    err(`Missing --public-url: your server's public address, where Discord sends slash commands and buttons.\n\n${USAGE}`);
    return 2;
  }
  if (requestUrl && !/^https:\/\//.test(requestUrl)) {
    err(`Discord sends only to an https address, and "${requestUrl}" isn't one.`);
    return 2;
  }

  const envFile = envFileOf(o, err);
  const inFile = envFile ? await readEnvFile(envFile) : {};
  secrets.add(inFile.VOICEFLOW_API_KEY, inFile.DISCORD_BOT_TOKEN);
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY);
  const ask = io.ask ?? question;
  const secret = io.secret ?? hidden;
  const withFetch = io.fetch ? { fetch: io.fetch } : {};
  const apiUrl = io.env.DISCORD_API_URL || inFile.DISCORD_API_URL;
  // A page is opened only for a person who is there to see it, in a browser that is theirs, and not when told not to.
  const opener = interactive && !o['no-open'] ? (io.open ?? (canOpenBrowser(io.env) ? openInBrowser : undefined)) : undefined;
  const open = async (url: string) => (opener ? opener(url).catch(() => false) : false);
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

  // Point and disconnect are Discord's alone: they need the bot's token, and nothing of Voiceflow's.
  if (action !== 'connect') {
    const token = await botToken({ file: o['token-file'], env: io.env, inFile, envFile, interactive: false, secret, say: out, connected: true });
    secrets.add(token.value);
    const discord = { token: token.value, ...(apiUrl ? { apiUrl } : {}), ...withFetch };
    if (action === 'disconnect') {
      const result = await disconnectDiscord({ discord, ...(command !== undefined ? { command } : {}), confirm, onProgress: out });
      if (result.applied) out('\nDisconnected.');
      return 0;
    }
    if (o['local-url']) {
      const at = `${o['local-url'].replace(/\/+$/, '')}${new URL(requestUrl!).pathname}`;
      await checkServer({ url: at, token: token.value, ...(envFile ? { envFile } : {}), ...withFetch });
      out(`= your server takes Discord's events at ${at}, with this bot's token`);
    }
    const pointed = await pointDiscord({ discord, interactionsUrl: requestUrl!, onProgress: out });
    // The server checks Discord's signature with the app's public key: one that isn't this app's refuses everything Discord sends.
    const key = io.env.DISCORD_PUBLIC_KEY || inFile.DISCORD_PUBLIC_KEY;
    if (key && key.trim().toLowerCase() !== pointed.app.publicKey.toLowerCase()) {
      err(
        `! DISCORD_PUBLIC_KEY${envFile ? ` in ${envFile}` : ''} isn't this app's public key. Run connect again with it removed: connect writes the right one.`,
      );
    }
    return 0;
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
  const orWait = async <T>(get: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await get();
    } catch (error) {
      if (interactive || !(error instanceof NeedsYou)) throw error;
      waiting.push(error.message);
      return undefined;
    }
  };
  const key = await orWait(() => voiceflowKey({ file: o['key-file'], env: io.env, inFile, envFile, interactive, secret }));
  secrets.add(key?.value);
  // The application is named by hand, after the agent: so the agent is read first, where there is a token still to
  // get. A key or a project that's wrong is said here, before anyone is sent to make an application.
  const noToken = !o['token-file'] && !io.env.DISCORD_BOT_TOKEN && !inFile.DISCORD_BOT_TOKEN;
  const agentName =
    noToken && key && project
      ? botNameOf(
          (await checkProject({ apiKey: key.value, projectID: project, ...(o.workspace ? { expectWorkspace: o.workspace } : {}), ...withFetch })).name,
        ) || undefined
      : undefined;
  const token = await orWait(() =>
    botToken({ file: o['token-file'], env: io.env, inFile, envFile, interactive, secret, say: out, connected: false, agentName, open }),
  );
  secrets.add(token?.value);
  if (waiting.length || !key || !token) throw new NeedsYou(waiting.join('\n\n'));

  const io2 = { interactive, ask, out, err };
  // Nothing has to be published for the bot to work, so nothing is, and nobody is asked, without --publish.
  const flags = { publish: o.publish, noPublish: !o.publish };
  const voiceflow = { apiKey: key.value, projectID: project, environment, ...(o.workspace ? { expectWorkspace: o.workspace } : {}), ...withFetch };
  const variables = !o['no-variables'];
  const result = await connectDiscord({
    discord: { token: token.value, ...(apiUrl ? { apiUrl } : {}), ...withFetch },
    voiceflow,
    ...(requestUrl ? { interactionsUrl: requestUrl } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(o.server ? { server: o.server } : {}),
    variables,
    confirm: (plan) =>
      confirm([
        ...plan.lines,
        'Then:',
        o.publish
          ? `  + publish ${environment}: its whole draft goes live (--publish)`
          : `  · nothing is published, and nothing has to be: the variables are live once you publish ${environment}`,
        '  + you get the link that adds the bot to a server',
        // Said only where it will happen: for a person who is there, about a bot that is in no server yet.
        ...(interactive && plan.app.servers === 0 && !o['no-wait'] && !o['no-greeting'] && plan.app.ownerId
          ? ["  + once it's in one, the bot messages you in Discord to say it's connected"]
          : []),
      ]),
    onProgress: out,
  });
  if (!result.applied) {
    if (o['dry-run'] && o.publish) await previewPublish(voiceflow, { publish: true, noPublish: false }, io2, result.plan.installs);
    return 0;
  }
  const { app } = result.plan;
  // The key the server checks Discord's signature with, and the app's ID, are read from Discord: nobody copies them.
  const saved = await saveEnv(
    { ...(envFile ? { envFile } : {}), inFile },
    [
      ['DISCORD_BOT_TOKEN', token.typed ? token.value : ''],
      ['DISCORD_PUBLIC_KEY', app.publicKey],
      ['DISCORD_APPLICATION_ID', app.id],
      ['VOICEFLOW_API_KEY', key.typed ? key.value : ''],
      ['VOICEFLOW_PROJECT_ID', project],
      ['VOICEFLOW_ENVIRONMENT', environment],
    ],
    io2,
  );
  // A value the file already had is never changed. One that's another app's would refuse everything Discord sends: say so.
  const stale = (
    [
      ['DISCORD_PUBLIC_KEY', app.publicKey],
      ['DISCORD_APPLICATION_ID', app.id],
    ] as const
  ).filter(([name, value]) => (io.env[name] || inFile[name]) && (io.env[name] || inFile[name])!.trim().toLowerCase() !== value.toLowerCase());
  for (const [name] of stale)
    err(`! ${name}${inFile[name] ? ` in ${envFile}` : ' in the environment'} isn't this app's. Remove it and run connect again: connect writes the right one.`);
  const published = o.publish ? await publishStep(voiceflow, flags, io2, { name: RELEASE_NAME, description: RELEASE_DESCRIPTION }, true) : 'not';

  const where = (name: string, otherwise: string) => (envFile && (inFile[name] || saved.includes(name)) ? `in ${envFile}` : otherwise);
  const inNoServer = app.servers === 0;
  // The one step left to a person: the page is opened for it, where the bot is in no server yet.
  const opened = inNoServer && (await open(result.installLink));
  const adding = `${opened ? 'the page is open in your browser: ' : 'open this link, '}${o.server ? 'your server is chosen there, so' : 'pick the server, and'} authorize.`;
  out(`
Connected: Discord app ${app.id} "${app.name}", bot ${app.botName}.

Your server needs:
  DISCORD_BOT_TOKEN       ${where('DISCORD_BOT_TOKEN', 'the bot token you gave')}
  DISCORD_PUBLIC_KEY      ${where('DISCORD_PUBLIC_KEY', app.publicKey)}
  DISCORD_APPLICATION_ID  ${where('DISCORD_APPLICATION_ID', app.id)}
  VOICEFLOW_API_KEY       ${where('VOICEFLOW_API_KEY', 'your Voiceflow API key')}

  createChannels({
    voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY, projectID: '${project}', environment: '${environment}' },
    channels: [discord()],
  })

${inNoServer ? 'The bot is in no server yet. Add it to one' : 'To add the bot to a server'}: ${adding}

  ${result.installLink}

${
  result.endpoint === 'local'
    ? o['from-dev']
      ? "Your server starts next: dev holds the connection Discord sends messages over, and gives Discord your server's address for slash commands and buttons."
      : "Then start your server with `voiceflow-channels dev -- <its command>` (`npm run dev` in an app the starter made): it holds the connection Discord sends messages over, and gives Discord your server's address for slash commands and buttons."
    : result.endpoint === 'refused'
      ? 'Discord has no address for slash commands and buttons yet: see below.'
      : `Discord sends slash commands and buttons to ${requestUrl}. What people write comes over a standing connection your server has to hold: the starter's README says how, for a server that stays up and for one that doesn't.`
}${variables ? `\nThe discord_* variables are on ${environment}'s draft, for your agent's prompts: {discord_user_name}, say.${published === 'published' ? '' : ` They're live once you publish ${environment}.`}` : ''}`);
  for (const problem of [...(result.install?.problems ?? []), ...(result.install?.notes ?? [])]) err(`! ${problem}`);
  // Adding the bot is a person's, on a page of Discord's. A person who is there is waited for, so the run ends
  // with the bot in a server and saying so, not with a link and a hope.
  if (inNoServer && interactive && !o['no-wait']) {
    out('\nWaiting for the bot to be added to a server. Ctrl-C stops the waiting, and loses nothing.');
    const api = createDiscordApi({ token: token.value, ...(apiUrl ? { apiUrl } : {}), ...withFetch });
    const server = await waitForServer(api, { ...(io.wait ? { wait: io.wait } : {}) });
    if (!server) out("· The bot is in no server yet. The link above adds it, when you're ready.");
    else {
      out(`+ ${app.botName} is in ${server.name}`);
      if (!o['no-greeting'] && app.ownerId) {
        const command = result.plan.command;
        const failed = await sendGreeting(api, {
          userId: app.ownerId,
          text: greetingText({ name: app.botName, server: server.name, ...(command ? { command } : {}) }),
        });
        out(failed ? `· ${app.botName} couldn't message you in Discord: ${failed}.` : `+ ${app.botName} messaged you in Discord: look under Direct Messages`);
      }
    }
  }
  // What's left is a person's to do: the run did everything else.
  const left = result.problems;
  if (left.length) {
    err(
      `\n${left.join('\n\n')}${result.endpoint === 'refused' ? `\n\nOnce it's running there:\n\n  voiceflow-channels point discord --public-url ${o['public-url'] ?? '<https://host>'}${envFile ? ` --dotenv ${envFile}` : ''}` : ''}`,
    );
    return 3;
  }
  return published === 'failed' ? 1 : 0;
}

/**
 * The Discord bot token: from the file that holds only it, the environment,
 * the server's env file, or (asked of a person) a hidden prompt. `typed` says
 * it came from the prompt, so it can be saved for the server.
 */
async function botToken(from: {
  file?: string;
  env: Record<string, string | undefined>;
  inFile: Record<string, string>;
  envFile?: string;
  interactive: boolean;
  secret: (question: string) => Promise<string>;
  say: Say;
  /** Whether a bot was connected from here before: then a missing token is one that went missing. */
  connected: boolean;
  /** The agent's name in Voiceflow, where it's known: what to name the application. */
  agentName?: string;
  /** Opens a page in the person's browser, and says whether it could. */
  open?: (url: string) => Promise<boolean>;
}): Promise<{ value: string; typed: boolean }> {
  if (from.file) {
    const token = (await readFile(from.file, 'utf8')).trim();
    if (!token) throw new Error(`${from.file} is empty.`);
    return { value: token, typed: false };
  }
  const known = from.env.DISCORD_BOT_TOKEN || from.inFile.DISCORD_BOT_TOKEN;
  if (known) return { value: known, typed: false };
  const where = from.envFile ? `in ${from.envFile}` : 'in the environment';
  if (from.connected)
    throw new NeedsYou(
      `No DISCORD_BOT_TOKEN ${where}. Run connect first: voiceflow-channels connect discord${from.envFile ? ` --dotenv ${from.envFile}` : ''}.`,
    );
  if (!from.interactive) {
    throw new NeedsYou(
      `No Discord bot token. ${tokenSteps(from.agentName, false)}\n  3. Put it ${where} as DISCORD_BOT_TOKEN=<the token>, or in a file of its own for --token-file. Never in a chat or a command line.\nThen run this again: it does the rest.`,
    );
  }
  const opened = from.open ? await from.open(NEW_APPLICATION) : false;
  from.say(`${tokenSteps(from.agentName, opened)}\n`);
  const token = await from.secret('Discord bot token (hidden): ');
  if (!token) throw new Error('No Discord bot token entered.');
  return { value: token, typed: true };
}

/**
 * Whether a Discord bot has been connected from here: its token, its public key and its application's ID are all
 * in the environment or the env file. `voiceflow-channels dev` asks, and runs connect first when it hasn't.
 */
export async function connected(options: { envFile?: string; env?: Record<string, string | undefined> } = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const inFile = options.envFile ? await readEnvFile(options.envFile) : {};
  return ['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID'].every((name) => Boolean(env[name] || inFile[name]));
}

/**
 * Holds Discord's Gateway connection open for `voiceflow-channels dev`, passing
 * what people write to your server on this machine, until `signal` aborts.
 */
export async function listen(
  options: { localUrl: string; envFile?: string; signal: AbortSignal; out: (line: string) => void; err: (line: string) => void },
  io: Pick<CliIO, 'env' | 'fetch' | 'gateway'> = {},
): Promise<void> {
  const env = io.env ?? process.env;
  const inFile = options.envFile ? await readEnvFile(options.envFile) : {};
  const get = (name: string) => env[name] || inFile[name] || '';
  const token = get('DISCORD_BOT_TOKEN');
  const secrets = createRedactor(token);
  const out = (line: string) => options.out(secrets.redact(line));
  const err = (line: string) => options.err(secrets.redact(line));
  const absent = ['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID'].filter((name) => !get(name));
  if (absent.length) {
    throw new NeedsYou(
      `No ${absent.join(', ')}${options.envFile ? ` here or in ${options.envFile}` : ' in the environment'}. Run connect first: voiceflow-channels connect discord${options.envFile ? ` --dotenv ${options.envFile}` : ''}.`,
    );
  }
  const webhookUrl = `${options.localUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
  // Each event is passed on with the bot's token: only ever to a server on this machine.
  if (!isLoopback(webhookUrl)) throw new Error(`${webhookUrl} isn't on this machine: Discord's events are passed on only to your server here.`);
  const apiUrl = get('DISCORD_API_URL');
  const app = await readApp(createDiscordApi({ token, ...(apiUrl ? { apiUrl } : {}), ...(io.fetch ? { fetch: io.fetch } : {}) }));
  // Without the intent Discord closes the connection as it opens: said here, where it can be put right.
  if (!readsMessages(app)) {
    throw new NeedsYou(
      `The Message Content intent is off for "${app.name}", so Discord won't send the bot what people write. Run connect again (it turns it on), or turn it on at ${DEVELOPER_PORTAL}/${app.id}/bot.`,
    );
  }
  if (app.servers === 0) out(`· ${app.botName} is in no server yet. Add it to one: ${installLink(app.id)}`);
  const channels = get('DISCORD_RESPOND_TO_CHANNEL_IDS');
  let heard = false;
  await (io.gateway ?? forwardGateway)({
    webhookUrl,
    signal: options.signal,
    adapter: {
      botToken: token,
      publicKey: get('DISCORD_PUBLIC_KEY'),
      applicationId: get('DISCORD_APPLICATION_ID'),
      ...(apiUrl ? { apiUrl } : {}),
      ...(channels
        ? {
            respondToChannelIds: channels
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean),
          }
        : {}),
    },
    onConnected: (bot) => out(`= connected to Discord as ${bot || app.botName}: what people write reaches your server at ${webhookUrl}`),
    onProblem: (problem) => err(`! discord: ${problem}`),
    // Said once: the proof that it's working end to end, for whoever just set it up.
    onForwarded: (type) => {
      if (heard || type !== 'GATEWAY_MESSAGE_CREATE') return;
      heard = true;
      out('= the first message from Discord reached your server');
    },
  });
}
