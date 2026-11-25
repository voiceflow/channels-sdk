// The Slack sign-in connect needs, with as little left to you as Slack allows.
//
// Connect makes and installs the app with the Slack CLI's login. So when that
// login has expired, this refreshes it; when the CLI is logged in to several
// workspaces, it asks which; when there is no login, it runs `slack login`;
// and when there is no Slack CLI, it offers Slack's own installer for it.
//
// With nobody at the terminal (a script, a coding agent) it does what needs no
// one, and stops with what a person has to do and how to carry on: `NeedsYou`,
// which the command turns into exit code 3. Node only.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NeedsYou } from '@voiceflow/channels-sdk';
import { SLACK_CLI_CREDENTIALS, SlackApiError, type SlackCliLogin, slackCliLogins } from './api.js';

export { NeedsYou };

/** Slack's own installers for its CLI (https://tools.slack.dev/slack-cli). */
export const SLACK_CLI_INSTALL = 'curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash';
export const SLACK_CLI_INSTALL_WINDOWS = 'irm https://downloads.slack-edge.com/slack-cli/install-windows.ps1 | iex';

/** For an app made by hand, said wherever the Slack CLI is the obstacle. */
const OR_BY_HAND = 'For a Slack app you made by hand, run this with --manual instead.';

/** The Slack CLI on this machine: where it keeps its logins, how it's found and run. A test stands in for each. */
export interface SlackCliHost {
  credentialsFile: string;
  platform: NodeJS.Platform;
  /** The Slack CLI's path, or undefined when it isn't installed. */
  find(): string | undefined;
  /** Runs a command. Shown, a person sees it and answers it; otherwise what it printed comes back. */
  run(command: string, args: string[], options: { show: boolean }): Promise<{ code: number; output: string }>;
}

export interface SlackSignInOptions {
  /** The workspace to sign in to. Without one: the only login, or the one a person picks. */
  team?: string;
  /** From a run that stopped for sign-in: the ticket it gave, and the code Slack showed for it. */
  ticket?: string;
  code?: string;
  /** Whether a person is there to answer. */
  interactive: boolean;
  ask(question: string): Promise<string>;
  say(line: string): void;
  /** Asks Slack whether it takes a login (`auth.test` with its token): resolves, or rejects with Slack's error. */
  check(login: SlackCliLogin): Promise<unknown>;
  host?: Partial<SlackCliHost>;
}

/** The Slack CLI's login for connect to work with, refreshed or made on the way if it has to be. */
export async function slackSignIn(options: SlackSignInOptions): Promise<SlackCliLogin> {
  const host: SlackCliHost = { ...defaultHost(), ...options.host };
  const before = tokens(host);
  if (options.ticket || options.code) {
    const refused = await finishLogin(options, host);
    if (refused) {
      // The same command run twice gives a ticket that was used the first time. That's no failure while its sign-in stands.
      if (!(await signedIn(options, host, before))) throw new Error(refused);
      options.say("You're signed in to Slack already: that ticket and code aren't needed again.");
    }
  }

  let login = await pick(options, host, before);
  if (login && !(await accepted(login, options))) {
    // An expired login: the CLI renews it whenever it runs.
    const cli = host.find();
    const team = login.teamId;
    if (cli) await host.run(cli, ['--skip-update', 'auth', 'list'], { show: false });
    const renewed = slackCliLogins(host.credentialsFile).find((l) => l.teamId === team);
    login = renewed && (await accepted(renewed, options)) ? renewed : undefined;
    if (!login) options.say(`Your Slack CLI login for ${team} has expired.`);
  }
  return login ?? newLogin(options, host);
}

function tokens(host: SlackCliHost): Map<string, string> {
  return new Map(slackCliLogins(host.credentialsFile).map((l) => [l.teamId, l.token]));
}

async function accepted(login: SlackCliLogin, options: SlackSignInOptions): Promise<boolean> {
  try {
    await options.check(login);
    return true;
  } catch (error) {
    if (error instanceof SlackApiError && ['token_expired', 'invalid_auth', 'not_authed', 'token_revoked'].includes(error.error)) return false;
    throw error;
  }
}

/** The login to use, of those the CLI has: the workspace named, the only one, the one just made, or the one a person picks. */
async function pick(options: SlackSignInOptions, host: SlackCliHost, before: Map<string, string>): Promise<SlackCliLogin | undefined> {
  const logins = slackCliLogins(host.credentialsFile);
  if (options.team) return logins.find((l) => l.teamId === options.team);
  if (logins.length <= 1) return logins[0];
  const fresh = logins.filter((l) => before.get(l.teamId) !== l.token);
  if (fresh.length === 1) return fresh[0];
  const name = (l: SlackCliLogin) => `${l.teamId}${l.teamDomain ? ` ${l.teamDomain}` : ''}`;
  if (!options.interactive) throw new Error(`The Slack CLI is logged in to several workspaces: name one with --team (${logins.map(name).join(', ')}).`);
  options.say(`The Slack CLI is logged in to several workspaces:\n${logins.map((l, i) => `  ${i + 1}. ${name(l)}`).join('\n')}`);
  const answer = (await options.ask(`Which one? [1-${logins.length}] `)).trim();
  const chosen = (/^\d+$/.test(answer) ? logins[Number(answer) - 1] : undefined) ?? logins.find((l) => l.teamId === answer || l.teamDomain === answer);
  if (!chosen) throw new Error(`"${answer}" isn't one of them. Nothing was changed.`);
  return chosen;
}

/** Whether there's a login to use right now, without asking anyone. */
async function signedIn(options: SlackSignInOptions, host: SlackCliHost, before: Map<string, string>): Promise<boolean> {
  try {
    const login = await pick({ ...options, interactive: false }, host, before);
    return Boolean(login && (await accepted(login, options)));
  } catch {
    return false;
  }
}

/** Signs in with the ticket an earlier run gave and the code Slack showed for it. Returns what to say when Slack refuses them. */
async function finishLogin(options: SlackSignInOptions, host: SlackCliHost): Promise<string | undefined> {
  const { ticket, code } = options;
  if (!ticket || !code) throw new Error('--slack-ticket and --slack-code go together: the ticket this command gave you, and the code Slack showed for it.');
  if (ticket.startsWith('-') || code.startsWith('-')) throw new Error("That isn't a ticket and a code from Slack.");
  const cli = host.find();
  if (!cli) throw new NeedsYou(installFirst(host));
  const done = await host.run(cli, ['--skip-update', 'login', '--no-prompt', '--ticket', ticket, '--challenge', code], { show: false });
  return done.code === 0
    ? undefined
    : `Slack didn't take that code${said(done.output)}. Run this again without --slack-ticket and --slack-code for a new ticket.`;
}

/** No login to use: installs the CLI if a person agrees to, then signs in, or says how. */
async function newLogin(options: SlackSignInOptions, host: SlackCliHost): Promise<SlackCliLogin> {
  let cli = host.find();
  if (!cli) {
    // Slack's installer for Windows is PowerShell's to run, and this hasn't been tried there: it's left to you.
    if (!options.interactive || host.platform === 'win32') throw new NeedsYou(installFirst(host));
    options.say(`Connect makes and installs the Slack app with the Slack CLI, which isn't installed. Slack's installer for it:\n\n  ${SLACK_CLI_INSTALL}\n`);
    if (!/^y(es)?$/i.test((await options.ask('Run it now? [y/N] ')).trim())) {
      throw new NeedsYou(`Install the Slack CLI, then run this again. ${OR_BY_HAND}`);
    }
    const done = await host.run('bash', ['-c', SLACK_CLI_INSTALL], { show: true });
    cli = host.find();
    if (done.code !== 0 || !cli) {
      const why = done.code !== 0 ? `the installer exited ${done.code}` : "it isn't where the installer puts it";
      throw new Error(`The Slack CLI wasn't installed (${why}). Install it yourself (https://tools.slack.dev/slack-cli), then run this again.`);
    }
  }

  const before = tokens(host);
  if (options.interactive) {
    options.say('Signing in to Slack. The Slack CLI takes it from here:\n');
    const done = await host.run(cli, ['--skip-update', 'login'], { show: true });
    if (done.code !== 0) throw new Error(`\`slack login\` didn't finish (it exited ${done.code}). Run it yourself, then run this again.`);
    const login = await pick(options, host, before);
    if (!login)
      throw new Error(
        `The Slack CLI still has no login${options.team ? ` for workspace ${options.team}` : ''}. Run \`slack login\` yourself, then run this again.`,
      );
    return login;
  }

  // Nobody to answer it: ask Slack for a ticket, and leave the rest with a person.
  const asked = await host.run(cli, ['--skip-update', 'login', '--no-prompt'], { show: false });
  const ticket = /\/slackauthticket\s+(\S+)/.exec(asked.output)?.[1];
  if (!ticket) throw new Error(`\`slack login --no-prompt\` gave no sign-in ticket${said(asked.output)}. Run \`slack login\` yourself, then run this again.`);
  throw new NeedsYou(
    `Sign in to Slack. Paste this into any Slack channel or DM, and approve what it shows:\n\n  /slackauthticket ${ticket}\n\nSlack then gives you a code. Run this again with it, adding:\n\n  --slack-ticket ${ticket} --slack-code <the code>`,
  );
}

function installFirst(host: SlackCliHost): string {
  const windows = host.platform === 'win32';
  return `Connect makes and installs the Slack app with the Slack CLI, which isn't installed. Install it${windows ? ', in PowerShell' : ''}:\n\n  ${windows ? SLACK_CLI_INSTALL_WINDOWS : SLACK_CLI_INSTALL}\n\nThen run this again. ${OR_BY_HAND}`;
}

/** What a command printed, short enough for an error. */
function said(output: string): string {
  const text = output.trim().replace(/\s+/g, ' ');
  return text ? `: ${text.slice(0, 300)}` : '';
}

function defaultHost(): SlackCliHost {
  return { credentialsFile: SLACK_CLI_CREDENTIALS, platform: process.platform, find: findSlackCli, run };
}

/** The Slack CLI, on the PATH or where its installer puts it. */
function findSlackCli(): string | undefined {
  const exe = process.platform === 'win32' ? 'slack.exe' : 'slack';
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    path.join(os.homedir(), '.slack', 'bin'),
  ].filter(Boolean);
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, exe);
    if (!fs.existsSync(candidate)) continue;
    // Slack's desktop app is called `slack` too. The CLI says which it is.
    const version = spawnSync(candidate, ['--skip-update', '--version'], { encoding: 'utf8', timeout: 10_000 });
    if (/^Using \S+ v\d/m.test(`${version.stdout ?? ''}${version.stderr ?? ''}`)) return candidate;
  }
  return undefined;
}

function run(command: string, args: string[], { show }: { show: boolean }): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // Unshown, a command gets no input and a minute: it can't wait on a question nobody sees.
    const child = spawn(command, args, show ? { stdio: 'inherit' } : { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
