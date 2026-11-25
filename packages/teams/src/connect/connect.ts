// `connect teams`: from a Microsoft 365 sign-in to a bot in Teams your
// Voiceflow agent answers through. Microsoft's own command makes the app, its
// bot and their secret (ms.ts): no Azure account is needed. Connect gives the
// bot your agent's name and picture, asks for the one permission that lets it
// read a thread's replies, creates the `teams_*` variables on the agent, and
// says what link adds the bot in Teams.
//
// Everything the app is goes in before it is first added to Teams: a
// permission added afterwards made Teams refuse to add the app again
// ("AppDefinitionDoesntExist"), in a live run. So an app made before is left
// as it is, but for the address Teams sends to, which Teams takes at any time.
//
// It shows its whole plan before it changes anything. The bot's secret is for
// your server alone: it never goes to Voiceflow.
//
// Node only: import it from `@voiceflow/channels-teams/connect`.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NeedsYou } from '@voiceflow/channels-sdk';
import { type ApiOptions, checkProject, type InstallResult, installTools, memoryRecordStore } from '@voiceflow/channels-sdk/install';
import { downloadIcon, type IconFile, iconUrl, readEnvFile, VOICEFLOW_ICON_NAME, voiceflowIcon } from '@voiceflow/channels-sdk/setup';
import { CONTEXT_VARIABLES } from '../context.js';
import { teamsIcon } from './icon.js';
import { MS_CLI_NPX, type MsAccount, type MsApp, type MsCli, MsCliError } from './ms.js';

/** The path of your server's Teams route, where the starter puts it. */
export const WEBHOOK_PATH = '/api/teams';
/** What lets a bot be sent a thread's replies that don't mention it: with it, everything written in a channel it's added to. */
export const THREAD_PERMISSION = 'ChannelMessage.Read.Group';
/** Teams' limit on an app's name. */
export const MAX_NAME = 30;
export const TEAMS_ADMIN = 'https://admin.teams.microsoft.com';
export const DEVELOPER_PORTAL = 'https://dev.teams.microsoft.com/apps';
const ENTRA_APP = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId';

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
/** "name, picture and permissions are", or "permissions are": what an app made before keeps. */
const kept = (...things: string[]) => {
  const named = things.filter(Boolean);
  return `${named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]} are`;
};

/** An agent's name as a Teams app's: on one line, and within Teams' 30 characters, cut at a word. */
export function botNameOf(name: string): string {
  const line = name.replace(/\s+/g, ' ').trim();
  if (line.length <= MAX_NAME) return line;
  const cut = line.slice(0, MAX_NAME);
  const space = cut.lastIndexOf(' ');
  return (space > MAX_NAME / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** How a person signs in to Microsoft 365 for this, said in full. */
export function signInSteps(): string {
  return `Not signed in to Microsoft 365. Sign in with the account you use Teams with:

  ${MS_CLI_NPX} login

It opens a browser. Where none can open here (over SSH, say), add --device-code: it prints a link, and a code to enter there.
Then run this again: it does the rest.`;
}

/** Why a bot made here couldn't be added to Teams, and who puts that right: or nothing, when it can be. */
export function uploadProblem(account: MsAccount): string | undefined {
  if (account.upload.organization === false) {
    return `Your Microsoft 365 organization doesn't let people add apps of their own to Teams, so a bot made here couldn't be added. An admin turns it on, once: Teams admin center → Teams apps → Manage apps → Actions → Org-wide app settings → Custom apps (${TEAMS_ADMIN}/policies/manage-apps). Nothing was changed. Run this again once it's on.`;
  }
  if (account.upload.person === false) {
    return `Your Microsoft 365 account (${account.username}) isn't allowed to add apps of its own to Teams, so a bot made here couldn't be added. An admin turns it on, once: Teams admin center → Teams apps → Setup policies → Global (Org-wide default), or the policy you're under → Upload custom apps (${TEAMS_ADMIN}/policies/app-setup). Nothing was changed. Run this again once it's on: it took a few minutes to apply when tried.`;
  }
  return undefined;
}

/**
 * A call to Microsoft's command about an app, with two of its refusals said as what a person does about them:
 * nobody signed in, and an app this account can't see (it was made from another account, or deleted).
 */
async function signedIn<T>(call: () => Promise<T>, appId?: string): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof MsCliError && (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_TOKEN_FAILED')) throw new NeedsYou(signInSteps());
    if (error instanceof MsCliError && appId && /\b404\b|not found/i.test(error.message)) {
      throw new Error(
        `Microsoft 365 has no Teams app ${appId} for the account signed in (${error.message}). It was made from another account, or deleted. To connect a bot of your own, take TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID out of your server's env file and run connect again. Nothing was changed.`,
      );
    }
    throw error;
  }
}

// ── Connect ─────────────────────────────────────────────────────────────────

/** What your server signs in to Teams with: TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID. */
export interface TeamsCredentials {
  appId: string;
  password: string;
  tenantId: string;
}

export interface ConnectTeamsOptions {
  /** Microsoft's command (`createMsCli(msRunner())`). */
  microsoft: MsCli;
  /** Who is signed in, where it's been read already. */
  account?: MsAccount;
  voiceflow: ApiOptions & { projectID: string; environment: string; expectWorkspace?: string };
  /** The app connected from here before (TEAMS_APP_ID): it is kept, and only what's missing is added. */
  appId?: string;
  /** Where Teams sends the bot's messages: your server's public address and its route. Without it, `voiceflow-channels dev` gives one. */
  endpoint?: string;
  /** The bot's name in Teams. Default: your agent's name in Voiceflow, on a new app. An app made before keeps its name unless you give one. */
  name?: string;
  /** The bot's picture, an image's URL, or `false` for Teams' placeholder. Default: the agent's avatar in Voiceflow, or Voiceflow's icon, on a new app. */
  icon?: string | false;
  /** Ask for the permission that lets the bot read a thread's replies with no mention. Default: `true`. Only a new app is given it. */
  threadReplies?: boolean;
  /** Create the `teams_*` variables on the agent. Default: `true`. */
  variables?: boolean;
  /**
   * Given a new app's credentials the moment it is made, before anything else
   * is done: save them here. Its secret is shown once, and what comes after
   * can fail.
   */
  save?: (credentials: TeamsCredentials) => void | Promise<void>;
  /** Shown the plan before anything is changed. Return `false` to stop. */
  confirm?: (plan: ConnectPlan) => boolean | Promise<boolean>;
  onProgress?: (line: string) => void;
  /** Downloads a picture, in place of `fetch`. */
  fetch?: typeof fetch;
}

export interface ConnectPlan {
  account: MsAccount;
  project: { id: string; name: string; workspaceID: string };
  /** The app made before, where there is one. */
  app?: MsApp;
  /** The name a new app gets. */
  name?: string;
  /** The plan, a line per thing, for a person to read. */
  lines: string[];
  /** Whether the agent gets anything new. */
  installs: boolean;
}

export interface ConnectResult {
  applied: boolean;
  plan: ConnectPlan;
  /** The Teams app: the one made, or the one there already. Absent when nothing was applied and none existed. */
  app?: MsApp;
  /** A new app's credentials. Absent for an app made before: its secret is where connect put it then. */
  credentials?: TeamsCredentials;
  install?: InstallResult;
  /** What connect couldn't do and the bot works without, each a line. */
  notes: string[];
}

type Picture = { from: 'option' | 'agent'; url: string } | { from: 'default' };

const VARIABLE_SET = { channel: 'teams', variables: CONTEXT_VARIABLES, tools: [] };

export async function connectTeams(options: ConnectTeamsOptions): Promise<ConnectResult> {
  const ms = options.microsoft;
  const say = options.onProgress ?? (() => {});
  const account = options.account ?? (await ms.account());
  if (!account.signedIn) throw new NeedsYou(signInSteps());
  const blocked = uploadProblem(account);
  if (blocked) throw new NeedsYou(blocked);
  if (typeof options.name === 'string' && !options.name.trim()) throw new TypeError('connectTeams: the name is empty');
  if (typeof options.name === 'string' && options.name.trim().length > MAX_NAME)
    throw new TypeError(`connectTeams: a Teams app's name is at most ${MAX_NAME} characters, and "${options.name.trim()}" is ${options.name.trim().length}`);
  if (typeof options.icon === 'string' && !iconUrl(options.icon))
    throw new TypeError(`connectTeams: the icon must be an image's http(s) URL, not "${options.icon}"`);
  if (options.endpoint && !/^https:\/\//.test(options.endpoint))
    throw new TypeError(`connectTeams: Teams sends only to an https address, not "${options.endpoint}"`);

  const project = await checkProject(options.voiceflow);
  const existing = options.appId ? await signedIn(() => ms.app(options.appId!), options.appId) : undefined;
  const wantsVariables = options.variables !== false;
  // No tools to keep track of, so nothing is recorded on disk.
  const voiceflow = { ...options.voiceflow, record: memoryRecordStore() };
  const dry = wantsVariables ? await installTools(VARIABLE_SET, { ...voiceflow, dryRun: true }) : undefined;
  const newVariables = dry?.steps.filter((s) => s.kind === 'variable' && s.action === 'create').map((s) => (s as { name: string }).name) ?? [];

  const url = options.endpoint;
  const name = typeof options.name === 'string' ? options.name.trim() : botNameOf(project.name) || 'Voiceflow agent';
  const agentIcon = project.image ? iconUrl(project.image) : undefined;
  // A picture you name goes on any app. The agent's avatar, or Voiceflow's icon, only on a new one.
  const picture: Picture | undefined =
    typeof options.icon === 'string'
      ? { from: 'option', url: iconUrl(options.icon)! }
      : options.icon === false || existing
        ? undefined
        : agentIcon
          ? { from: 'agent', url: agentIcon }
          : { from: 'default' };
  const pictureLine = !picture
    ? undefined
    : picture.from === 'agent'
      ? `the agent's avatar in Voiceflow as its picture, made the 192 by 192 pixels Teams takes (${VOICEFLOW_ICON_NAME} if it can't be): ${picture.url}`
      : picture.from === 'option'
        ? `the image as its picture, made the 192 by 192 pixels Teams takes: ${picture.url}`
        : `${VOICEFLOW_ICON_NAME} as its picture (the agent has no avatar in Voiceflow)`;
  const rename = existing && typeof options.name === 'string' && name !== existing.name ? name : undefined;
  const addressLine = !url
    ? "  · Teams needs your server's address: `voiceflow-channels dev` gives it one each time it starts"
    : existing?.endpoint === url
      ? `  = Teams sends the bot's messages to ${url}`
      : `  ${existing ? '~' : '+'} have Teams send the bot's messages to ${url}${existing?.endpoint ? ` (it sends them to ${existing.endpoint} now)` : ''}`;

  const lines = [
    `Microsoft 365: signed in as ${account.username}${account.tenantId ? ` (organization ${account.tenantId})` : ''}`,
    ...(existing
      ? [
          `  = the Teams app "${existing.name}" (${existing.id}) is there: its ${kept(rename ? '' : 'name', picture ? '' : 'picture', 'permissions')} left as they are`,
          ...(rename ? [`  ~ name it "${rename}" (it is "${existing.name}" now; Teams shows the new name once the app is added again)`] : []),
          ...(pictureLine ? [`  ~ give it ${pictureLine}`] : []),
        ]
      : [
          `  + make a Teams app and its bot, named "${name}"${typeof options.name === 'string' ? '' : ' after your agent in Voiceflow (--name gives another)'}`,
          ...(pictureLine ? [`  + give it ${pictureLine}`] : []),
          options.threadReplies === false
            ? '  · it answers where it is mentioned, and in chats: a reply in a thread needs a mention too'
            : `  + let it read a thread's replies, so they need no mention (the permission ${THREAD_PERMISSION}: Teams then sends it everything written in a channel it's added to, and it answers only in threads where it was mentioned)`,
        ]),
    addressLine,
    `Voiceflow: project "${project.name}" (${project.id}) in workspace ${project.workspaceID}, environment ${options.voiceflow.environment}${wantsVariables ? ': the variables go on its draft' : ''}`,
    !wantsVariables
      ? '  · no variables (then pass context: false to teams() on your server)'
      : newVariables.length
        ? `  + ${count(newVariables.length, 'variable')} for your agent's prompts (${newVariables.slice(0, 2).join(', ')}${newVariables.length > 2 ? ', …' : ''})\n  ~ compile the environment's draft`
        : `  = ${count(Object.keys(CONTEXT_VARIABLES).length, 'variable')}: there already`,
  ];
  const plan: ConnectPlan = { account, project, lines, installs: newVariables.length > 0, ...(existing ? { app: existing } : { name }) };
  if (options.confirm && !(await options.confirm(plan))) return { applied: false, plan, notes: [], ...(existing ? { app: existing } : {}) };

  // What connect couldn't do and the bot works without is said, and nothing more.
  const notes: string[] = [];
  const note = (line: string) => {
    notes.push(line);
    say(`! ${line}`);
  };
  // Microsoft's command reads the picture from a file and writes the credentials to one: both in a folder of
  // this run's own, which only you can read, and which is gone when the run is.
  const work = await mkdtemp(join(tmpdir(), 'vf-teams-'));
  let app: MsApp;
  let credentials: TeamsCredentials | undefined;
  try {
    let colorIcon: string | undefined;
    if (picture) {
      const made = await pictureFor(picture, options.fetch ?? fetch);
      if (made.note) note(`${made.note}${existing ? '' : ` Set another in ${DEVELOPER_PORTAL}, before the app is first added.`}`);
      if (made.png) {
        colorIcon = join(work, 'color.png');
        await writeFile(colorIcon, made.png, { mode: 0o600 });
      }
    }
    if (existing) {
      app = existing;
      const changes = {
        ...(url && existing.endpoint !== url ? { endpoint: url } : {}),
        ...(rename ? { name: rename } : {}),
        ...(colorIcon ? { colorIcon } : {}),
      };
      if (Object.keys(changes).length) {
        const { version } = await signedIn(() => ms.updateApp(existing.id, changes), existing.id);
        app = {
          ...existing,
          ...(changes.endpoint ? { endpoint: changes.endpoint } : {}),
          ...(rename ? { name: rename } : {}),
          version: version || existing.version,
        };
        if (changes.endpoint) say(`~ Teams sends the bot's messages to ${changes.endpoint}`);
        if (rename) say(`~ named it "${rename}"`);
        if (colorIcon) say('~ gave it its picture');
      }
    } else {
      const credentialsFile = join(work, 'credentials.env');
      await writeFile(credentialsFile, '', { mode: 0o600 });
      await chmod(credentialsFile, 0o600);
      app = await signedIn(() => ms.createApp({ name, credentialsFile, ...(url ? { endpoint: url } : {}), ...(colorIcon ? { colorIcon } : {}) }));
      const written = await readEnvFile(credentialsFile);
      if (!written.CLIENT_SECRET || !written.TENANT_ID) {
        throw new Error(
          `Microsoft's command made the Teams app ${app.id} and didn't write its secret. Make one, and put it in your server's env file as TEAMS_APP_PASSWORD: ${MS_CLI_NPX} app auth secret create ${app.id}`,
        );
      }
      credentials = { appId: written.CLIENT_ID || app.id, password: written.CLIENT_SECRET, tenantId: written.TENANT_ID };
      say(`+ made the Teams app "${app.name || name}" (${app.id}), its bot, and the bot's secret${colorIcon ? ', with its picture' : ''}`);
      // Saved before anything else is tried: the secret is shown this once.
      await options.save?.(credentials);
      if (options.threadReplies !== false) {
        try {
          await ms.addPermission(app.id, THREAD_PERMISSION);
          say("+ it can read a thread's replies");
        } catch (error) {
          note(
            `The bot wasn't given the permission to read a thread's replies (${error instanceof Error ? error.message : String(error)}). It answers where it's mentioned, and in chats. To add it, before the app is first added to Teams: ${MS_CLI_NPX} app rsc add ${app.id} ${THREAD_PERMISSION} --type Application`,
          );
        }
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  let install: InstallResult | undefined;
  if (wantsVariables) {
    install = await installTools(VARIABLE_SET, voiceflow);
    const made = install.steps.filter((s) => s.kind === 'variable' && s.action === 'create').length;
    if (made) say(`+ created ${count(made, 'variable')} on the agent`);
  }
  // The link that adds it is the app's own: an app read back says it, one just made says it too.
  if (!app.installLink) app = { ...app, ...(await ms.app(app.id).catch(() => ({}))) };
  return { applied: true, plan, app, ...(credentials ? { credentials } : {}), ...(install ? { install } : {}), notes };
}

/** A picture as a file Teams takes, or a note on why not: an agent's avatar that can't be one gives way to Voiceflow's icon. */
async function pictureFor(picture: Picture, doFetch: typeof fetch): Promise<{ png?: Uint8Array; note?: string }> {
  const read = async (source: Promise<IconFile>): Promise<{ png: Uint8Array } | { problem: string }> => {
    const icon = await source;
    if ('problem' in icon) return icon;
    return teamsIcon(new Uint8Array(await icon.file.arrayBuffer()));
  };
  if (picture.from === 'default') {
    const own = await read(voiceflowIcon());
    return 'png' in own ? own : { note: `${VOICEFLOW_ICON_NAME} couldn't be the bot's picture: ${own.problem}. It has Teams' placeholder.` };
  }
  const given = await read(downloadIcon(picture.url, doFetch));
  if ('png' in given) return given;
  // A picture you named is yours to fix. An agent's avatar that can't be used leaves no bot looking blank.
  if (picture.from === 'option') return { note: `The image couldn't be the bot's picture: ${given.problem}. It has Teams' placeholder.` };
  const own = await read(voiceflowIcon());
  return 'png' in own
    ? { png: own.png, note: `The agent's avatar couldn't be the bot's picture: ${given.problem}. It has ${VOICEFLOW_ICON_NAME} instead.` }
    : { note: `The agent's avatar couldn't be the bot's picture: ${given.problem}. It has Teams' placeholder.` };
}

// ── Point ───────────────────────────────────────────────────────────────────

export interface PointTeamsOptions {
  microsoft: MsCli;
  /** The app's ID: TEAMS_APP_ID. */
  appId: string;
  /** Where Teams is to send the bot's messages. */
  endpoint: string;
  onProgress?: (line: string) => void;
}

/**
 * Gives Teams another address for the bot's messages, and changes nothing else. Teams takes it at once, for an
 * app already added: nobody adds it again (seen live: the next message reached the new address some twenty
 * seconds later).
 */
export async function pointTeams(options: PointTeamsOptions): Promise<void> {
  if (!/^https:\/\//.test(options.endpoint)) throw new TypeError(`pointTeams: Teams sends only to an https address, not "${options.endpoint}"`);
  await signedIn(() => options.microsoft.updateApp(options.appId, { endpoint: options.endpoint }), options.appId);
  options.onProgress?.(`~ Teams sends the bot's messages to ${options.endpoint}`);
}

/** Whether a URL is on this machine: the only place a request is sent to try a server. */
export function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Asks your server on this machine whether its Teams route is there, before Teams is pointed at it: a request
 * with no token, which the route refuses (401) when it's up. One that isn't there, or a server that's down, is
 * said here, with nothing changed. Only Microsoft can sign a request the route would take, so this can't show
 * the server runs with this app's ID and secret: the first message does.
 */
export async function checkServer(options: { url: string; fetch?: typeof fetch }): Promise<void> {
  if (!isLoopback(options.url)) throw new TypeError(`checkServer: ${options.url} isn't on this machine`);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"type":"ping"}',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `Your server didn't answer at ${options.url} (${error instanceof Error ? error.message : String(error)}). Is it running? Nothing was changed.`,
    );
  }
  if (response.status === 401 || response.status === 403) return;
  if (response.status === 404 || response.status === 405) {
    throw new Error(
      `Your server has no Teams route at ${options.url} (HTTP ${response.status}). The starter puts it at app${WEBHOOK_PATH}/route.ts. Nothing was changed.`,
    );
  }
  if (response.status >= 500) {
    throw new Error(
      `Your server failed at ${options.url} (HTTP ${response.status}): its own log says why. A setting it needs may be missing: TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_APP_TENANT_ID and the VOICEFLOW_ ones. Nothing was changed.`,
    );
  }
  throw new Error(
    `Your server took a request with no token at ${options.url} (HTTP ${response.status}): anyone could send it messages as Teams. Its Teams route must go through the adapter, which checks Microsoft's token. Nothing was changed.`,
  );
}

// ── Disconnect ──────────────────────────────────────────────────────────────

/**
 * What takes a bot out of Teams and Microsoft 365. Microsoft's command has no way to remove an app, so these are
 * a person's to do, each on a page of Microsoft's.
 */
export function disconnectSteps(appId: string): string[] {
  return [
    'Microsoft gives no command that removes a Teams app, so this is by hand:',
    '  1. Take it out of Teams: Apps → Manage your apps → the app → the bin beside each place it was added.',
    `  2. Delete the app: ${DEVELOPER_PORTAL}/${appId} → ⋯ → Delete.`,
    `  3. Delete its registration, and with it the bot's secret: ${ENTRA_APP}/${appId} → Delete.`,
    "Then take TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID out of your server's settings.",
    'The teams_* variables stay on the agent: they are its own now.',
  ];
}
