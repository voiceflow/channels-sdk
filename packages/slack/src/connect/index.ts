// `connect slack`: one command from a Voiceflow agent to a working Slack app.
// It creates the app from this package's manifest (or adds what's missing to
// an app you have), installs it in the workspace, and installs Slack's default
// tools on the agent, pointed at your server, which runs them. The app's bot
// token is for your server alone: it never goes to Voiceflow. Connect shows its
// whole plan before it changes anything, and never publishes the agent.
//
// After that the app and the tools are yours: change them in Slack and in
// Voiceflow. Running connect again only adds what's missing.
//
// Node only: import it from `@voiceflow/channels-slack/connect`.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, TOOLS_URL_SECRET } from '@voiceflow/channels-sdk';
import {
  type ApiOptions,
  checkProject,
  formatStep,
  type InstallResult,
  installTools,
  type RecordStore,
  type Step,
  secretState,
  uninstallTools,
} from '@voiceflow/channels-sdk/install';
import { type SlackToolsOptions, slackTools } from '../tools/index.js';
import { createSlackApi, type SlackApi, SlackApiError } from './api.js';
import { appNameOf, type ManifestChanges, type ManifestOptions, mergeManifest, type SlackManifest, slackManifest } from './manifest.js';

export {
  createSlackApi,
  SLACK_CLI_CREDENTIALS,
  type SlackApi,
  SlackApiError,
  type SlackApiOptions,
  type SlackCliLogin,
  slackCliLogin,
  slackCliLogins,
} from './api.js';
export {
  appNameOf,
  BOT_EVENTS,
  BOT_SCOPES,
  DEFAULT_COMMAND,
  type ManifestChanges,
  type ManifestOptions,
  mergeManifest,
  requiredScopes,
  type SlackManifest,
  slackManifest,
} from './manifest.js';

export const DEFAULT_APP_RECORD_PATH = '.voiceflow/channels-slack-apps.json';

// ── Which app belongs to which agent ────────────────────────────────────────

/** The app connect made or used for an agent. No secrets: Slack shows those in the app's settings. */
export interface SlackAppRecord {
  appId: string;
  teamId: string;
  projectID: string;
  environment: string;
  requestUrl: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppRecordStore {
  get(key: string): Promise<SlackAppRecord | null>;
  set(key: string, record: SlackAppRecord | null): Promise<void>;
}

export function appRecordKey(teamId: string, projectID: string, environment: string): string {
  return `${teamId}/${projectID}/${environment}`;
}

export function fileAppRecordStore(path: string = DEFAULT_APP_RECORD_PATH): AppRecordStore {
  const read = async (): Promise<{ version: 1; apps: Record<string, SlackAppRecord> }> => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, apps: {} };
      throw error;
    }
  };
  return {
    async get(key) {
      return (await read()).apps[key] ?? null;
    },
    async set(key, record) {
      const all = await read();
      if (record) all.apps[key] = record;
      else delete all.apps[key];
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`);
      await rename(temp, path);
    },
  };
}

export function memoryAppRecordStore(): AppRecordStore & { apps: Map<string, SlackAppRecord> } {
  const apps = new Map<string, SlackAppRecord>();
  return {
    apps,
    async get(key) {
      return apps.get(key) ?? null;
    },
    async set(key, record) {
      if (record) apps.set(key, record);
      else apps.delete(key);
    },
  };
}

// ── Connecting ──────────────────────────────────────────────────────────────

export interface ConnectSlackOptions {
  slack: {
    /** A token that can create and install apps: the Slack CLI's login (`slackCliLogin()`). Never printed. */
    token: string;
    /** The workspace the token must be for. */
    teamId?: string;
    apiURL?: string;
    fetch?: typeof fetch;
  };
  voiceflow: ApiOptions & {
    projectID: string;
    /** The environment to install the tools into. Its draft is changed and compiled; nothing is published. */
    environment: string;
    /** The workspace the project must be in. Nothing changes, in Slack or Voiceflow, when it isn't. */
    expectWorkspace?: string;
    record?: RecordStore;
  };
  /**
   * Your server's Slack webhook, as Slack reaches it (`https://…/api/slack`).
   * Slack checks that it answers while it creates the app, or when the URL
   * changes, so it must be up then (the CLI answers for you while it runs).
   */
  requestUrl: string;
  /**
   * Where the agent's Slack tools reach your server, which runs them. Default:
   * `requestUrl`, since `channels.webhook('slack', request)` answers a tool's
   * call too. Give another address if you serve `channels.tools(request)` on a
   * route of its own.
   */
  toolsUrl?: string;
  /** Use this app instead of the one connect made before, or a new one. */
  appId?: string;
  /**
   * The app's name, command and so on. A new app is named after the agent (its
   * project's name in Voiceflow) unless `name` says otherwise.
   */
  app?: Omit<ManifestOptions, 'requestUrl' | 'tools'> & {
    /**
     * The app's icon: an image's URL (PNG, JPG or GIF, 512 to 2000 pixels).
     * Default: a new app gets the agent's avatar in Voiceflow, or Voiceflow's
     * icon when the agent has none (or Slack won't take it); an app that
     * already exists keeps its icon. `false` for none.
     */
    icon?: string | false;
  };
  /** Which of Slack's tools to install, or `false` to install none (the app still gets their scopes, so they can be installed later). */
  tools?: SlackToolsOptions | false;
  /** Tools to add again although they were removed, by name. */
  restore?: readonly string[];
  appRecords?: AppRecordStore;
  /** Shown the plan before anything changes. Return `false` to stop. Default: go ahead. */
  confirm?: (plan: ConnectPlan) => boolean | Promise<boolean>;
  /** Called with each change as it's made, as a line for a person. */
  onProgress?: (line: string) => void;
  /** Called as soon as a credential exists, so it can be kept before anything else can fail. Values are never printed. */
  onCredentials?: (credentials: { appId: string; signingSecret?: string; botToken?: string; botUserId?: string }) => void | Promise<void>;
}

export interface ConnectPlan {
  team: { id: string; name: string };
  project: { id: string; name: string; workspaceID: string; image?: string };
  environment: string;
  app: {
    action: 'create' | 'update' | 'unchanged';
    id?: string;
    name: string;
    /** The icon connect sets: the agent's avatar, the one you named, or Voiceflow's (`default`). */
    icon?: { from: 'agent' | 'option'; url: string } | { from: 'default' };
    manifest: SlackManifest;
    /** The app's manifest before this update, to put back if you want. */
    previous?: SlackManifest;
    changes?: ManifestChanges;
    /** Why the app was chosen (a recorded app that no longer exists, say). */
    note?: string;
  };
  /** The tool install's plan, unless `tools: false`. */
  voiceflow?: InstallResult;
  /** The plan as lines for a person. */
  lines: string[];
}

export interface ConnectResult {
  applied: boolean;
  plan: ConnectPlan;
  appId?: string;
  created?: boolean;
  /** The bot token. Kept in memory: give it to your server; never print it. */
  botToken?: string;
  /** Only when the app was created now: Slack returns it once. Afterwards it's in the app's Basic Information. */
  signingSecret?: string;
  /** Where the agent's Slack tools call your server. */
  toolsUrl?: string;
  /** With `app.userScopes`: a token that acts as the person who installed the app. Kept in memory; never print it. */
  userToken?: string;
  botUserId?: string;
  install?: InstallResult;
  /** What connect couldn't do but didn't stop for (an icon Slack refused, say), each a line for a person. */
  notes?: string[];
}

export async function connectSlack(options: ConnectSlackOptions): Promise<ConnectResult> {
  const slack = createSlackApi(options.slack);
  const plan = await planConnect(slack, options);
  if (options.confirm && !(await options.confirm(plan))) return { applied: false, plan };

  const say = options.onProgress ?? (() => {});
  const records = options.appRecords ?? fileAppRecordStore();
  const key = appRecordKey(plan.team.id, plan.project.id, plan.environment);
  const now = new Date().toISOString();
  const { manifest } = plan.app;
  const requestUrl = options.requestUrl;

  let appId = plan.app.id;
  let signingSecret: string | undefined;
  if (plan.app.action === 'create') {
    const created = await slack<{ app_id: string; credentials?: { signing_secret?: string } }>('apps.manifest.create', { manifest: JSON.stringify(manifest) });
    appId = created.app_id;
    signingSecret = created.credentials?.signing_secret;
    await records.set(key, { appId, teamId: plan.team.id, projectID: plan.project.id, environment: plan.environment, requestUrl, createdAt: now });
    await options.onCredentials?.({ appId, ...(signingSecret ? { signingSecret } : {}) });
    say(`+ created Slack app ${appId}`);
  } else {
    if (plan.app.action === 'update') {
      await slack('apps.manifest.update', { app_id: appId, manifest: JSON.stringify(manifest) });
      say(`~ updated Slack app ${appId}`);
    }
    const before = await records.get(key);
    await records.set(key, {
      ...before,
      appId: appId!,
      teamId: plan.team.id,
      projectID: plan.project.id,
      environment: plan.environment,
      requestUrl,
      updatedAt: now,
    });
  }

  const notes: string[] = [];
  const { icon } = plan.app;
  if (icon) {
    const settings = `Basic Information, https://api.slack.com/apps/${appId}/general`;
    const doFetch = options.slack.fetch ?? fetch;
    const what = icon.from === 'agent' ? "the agent's avatar" : icon.from === 'option' ? 'the icon' : DEFAULT_ICON_NAME;
    const problem = await setAppIcon(slack, appId!, icon.from === 'default' ? defaultIcon() : downloadIcon(icon.url, doFetch));
    // An avatar Slack won't take leaves a new app with Slack's blank icon: Voiceflow's stands in. An icon you named is yours to fix.
    const fallback = problem && icon.from === 'agent' ? await setAppIcon(slack, appId!, defaultIcon()) : undefined;
    const note = !problem
      ? undefined
      : icon.from !== 'agent'
        ? `Slack didn't take ${what} as the app's icon: ${problem}. Set one in ${settings}`
        : fallback
          ? `Slack didn't take the agent's avatar (${problem}) or ${DEFAULT_ICON_NAME} (${fallback}) as the app's icon. Set one in ${settings}`
          : `Slack didn't take the agent's avatar as the app's icon: ${problem}. It has ${DEFAULT_ICON_NAME} instead; set another in ${settings}`;
    if (note) {
      notes.push(note);
      say(`! ${note}`);
    } else say(`+ set the app's icon to ${what}`);
  }

  const userScopes = manifest.oauth_config.scopes.user ?? [];
  const installed = await slack<{ api_access_tokens?: { bot?: string; user?: string } }>(
    'apps.developerInstall',
    {
      app_id: appId,
      bot_scopes: manifest.oauth_config.scopes.bot.join(','),
      ...(userScopes.length ? { user_scopes: userScopes.join(',') } : {}),
      outgoing_domains: '[]',
    },
    { form: true },
  );
  const botToken = installed.api_access_tokens?.bot;
  if (!botToken) throw new Error(`Slack installed app ${appId} but returned no bot token.`);
  const userToken = installed.api_access_tokens?.user || undefined;
  if (options.app?.userScopes?.length && !userToken) throw new Error(`Slack installed app ${appId} but returned no user token for the user scopes.`);
  const me = await slack<{ user_id: string }>('auth.test', {}, { token: botToken });
  await options.onCredentials?.({ appId: appId!, botToken, botUserId: me.user_id });
  say(`+ installed it in ${plan.team.name}: bot user ${me.user_id}`);

  let install: InstallResult | undefined;
  if (options.tools !== false) {
    install = await installTools(slackTools(options.tools), {
      ...options.voiceflow,
      ...(options.restore ? { restore: options.restore } : {}),
      secretValues: { [TOOLS_URL_SECRET]: toolsUrlOf(options) },
      onStep: (step) => say(connectStepLine(step)),
    });
    notes.push(...install.notes);
  }
  return {
    applied: true,
    plan,
    appId: appId!,
    created: plan.app.action === 'create',
    botToken,
    ...(signingSecret ? { signingSecret } : {}),
    ...(install ? { toolsUrl: toolsUrlOf(options) } : {}),
    ...(userToken ? { userToken } : {}),
    botUserId: me.user_id,
    ...(install ? { install } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** Where the agent's tools call your server: the address you gave, or the webhook's own. */
// ── An app you made by hand ─────────────────────────────────────────────────

export interface ConnectOwnAppOptions {
  /** Your app's bot token. Connect reads with it who the app is and what it was granted, and changes nothing in Slack. */
  slack: { botToken: string; apiURL?: string; fetch?: typeof fetch };
  voiceflow: ConnectSlackOptions['voiceflow'];
  /** Where your server takes Slack's requests: the address the app's settings point at. */
  requestUrl: string;
  /** Where the agent's Slack tools call your server. Default: `requestUrl`. */
  toolsUrl?: string;
  /** The slash command your app has (default `/ask`), or `false` for none. */
  command?: string | false;
  tools?: SlackToolsOptions | false;
  restore?: readonly string[];
  /** Called with the plan before anything changes; return false to stop. */
  confirm?: (plan: OwnAppPlan) => boolean | Promise<boolean>;
  onProgress?: (line: string) => void;
}

export interface OwnAppPlan {
  team: { id: string; name: string };
  botUserId: string;
  project: ConnectPlan['project'];
  environment: string;
  /** Scopes this package uses that the app wasn't granted. Undefined when Slack didn't say what it was granted. */
  missingScopes?: string[];
  /** What would change on the agent. */
  voiceflow?: InstallResult;
  /** The plan, as lines for a person. */
  lines: string[];
}

export interface OwnAppResult {
  applied: boolean;
  plan: OwnAppPlan;
  toolsUrl?: string;
  install?: InstallResult;
}

/**
 * Connect for a Slack app you made and installed yourself: the Voiceflow half
 * alone. It checks the app against what this package uses and installs
 * Slack's tools on the agent. Nothing in Slack is changed, and it needs no
 * Slack CLI: the app's settings stay yours to keep.
 */
export async function connectOwnApp(options: ConnectOwnAppOptions): Promise<OwnAppResult> {
  const { voiceflow } = options;
  if (!voiceflow.environment) throw new TypeError('connectOwnApp: `voiceflow.environment` is required');
  // The workspace check comes first, as it does for an app connect makes.
  const project = await checkProject(voiceflow);
  const app = await ownApp(options.slack);
  const wanted = slackManifest({
    requestUrl: options.requestUrl,
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.tools === false ? {} : { tools: options.tools ?? {} }),
  });
  const granted = app.scopes;
  const install = (dryRun: boolean, onStep?: (step: Step) => void) =>
    installTools(slackTools(options.tools || undefined), {
      ...voiceflow,
      ...(options.restore ? { restore: options.restore } : {}),
      secretValues: { [TOOLS_URL_SECRET]: toolsUrlOf(options) },
      ...(dryRun ? { dryRun } : {}),
      ...(onStep ? { onStep } : {}),
    });
  const plan: OwnAppPlan = {
    team: app.team,
    botUserId: app.botUserId,
    project,
    environment: voiceflow.environment,
    ...(granted ? { missingScopes: wanted.oauth_config.scopes.bot.filter((scope) => !granted.includes(scope)) } : {}),
    ...(options.tools !== false ? { voiceflow: await install(true) } : {}),
    lines: [],
  };
  plan.lines = ownAppLines(plan, wanted, options);
  if (options.confirm && !(await options.confirm(plan))) return { applied: false, plan };

  const say = options.onProgress ?? (() => {});
  const installed = options.tools === false ? undefined : await install(false, (step) => say(connectStepLine(step)));
  return { applied: true, plan, ...(installed ? { toolsUrl: toolsUrlOf(options), install: installed } : {}) };
}

/** Who a bot token is and what it was granted: `auth.test`, whose answer carries the token's scopes in a header. */
async function ownApp(slack: ConnectOwnAppOptions['slack']): Promise<{ team: { id: string; name: string }; botUserId: string; scopes?: string[] }> {
  const base = (slack.apiURL ?? 'https://slack.com/api').replace(/\/$/, '');
  const res = await (slack.fetch ?? fetch)(`${base}/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${slack.botToken}` } });
  const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as any;
  const where = "your app's OAuth & Permissions page (https://api.slack.com/apps)";
  if (!json.ok) {
    const error = redact(String(json.error ?? 'unknown_error'), [slack.botToken]).slice(0, 200);
    throw new Error(`Slack doesn't take SLACK_BOT_TOKEN (${error}). Copy the Bot User OAuth Token from ${where}. Nothing was changed.`);
  }
  if (!json.bot_id) throw new Error(`SLACK_BOT_TOKEN isn't a bot's token. Use the Bot User OAuth Token (it starts xoxb-) from ${where}. Nothing was changed.`);
  const header = res.headers.get('x-oauth-scopes');
  const scopes =
    header === null
      ? undefined
      : header
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
  return { team: { id: String(json.team_id), name: String(json.team) }, botUserId: String(json.user_id), ...(scopes ? { scopes } : {}) };
}

function ownAppLines(plan: OwnAppPlan, wanted: SlackManifest, options: ConnectOwnAppOptions): string[] {
  const commands = (wanted.features.slash_commands as { command: string }[] | undefined)?.map((c) => c.command) ?? [];
  const lines = [`Slack: your own app in workspace ${plan.team.name} (${plan.team.id}), bot user ${plan.botUserId} (connect changes nothing in it)`];
  const missing = plan.missingScopes;
  if (!missing) lines.push("  · Slack didn't say which scopes the app has: compare them with the manifest yourself");
  else if (missing.length) {
    lines.push(
      `  ! it wasn't granted ${missing.length === 1 ? 'a scope' : `${missing.length} scopes`} this package uses: ${missing.join(', ')}`,
      '    add them under OAuth & Permissions, then reinstall the app',
    );
  } else lines.push(`  = it has every scope this package uses (${wanted.oauth_config.scopes.bot.length})`);
  lines.push(
    `  · these settings are yours to keep, each pointed at ${options.requestUrl}:`,
    '      Event Subscriptions > Request URL',
    '      Interactivity & Shortcuts > Request URL',
    ...commands.map((command) => `      Slash Commands > ${command} > Request URL`),
    '    the whole manifest, to compare with: connect slack --print-manifest --public-url <your address>',
  );
  lines.push(...voiceflowLines(plan, options));
  return lines;
}

function toolsUrlOf(options: Pick<ConnectSlackOptions, 'toolsUrl' | 'requestUrl'>): string {
  const url = options.toolsUrl ?? options.requestUrl;
  // A turn's pass travels with every call, so the address is https.
  if (!/^https:\/\/\S+$/.test(url)) throw new TypeError(`connectSlack: the tools URL must be an https address, not "${url}"`);
  return url;
}

/** Slack refuses icons outside 512 to 2000 pixels (measured: 100 and 3000 refused, 512x512 and 800x500 taken) and anything but an image. */
const MAX_ICON_BYTES = 10 * 1024 * 1024;

/**
 * Voiceflow's icon, for an agent with no avatar: the brand's butterfly on its
 * blue, as Voiceflow's own agent avatar draws it (made by scripts/make-icon.mjs
 * from the website's mark and colour tokens; 512 pixels, the size Slack's CLI uploads).
 */
const DEFAULT_ICON = new URL('../../assets/voiceflow-icon.png', import.meta.url);
const DEFAULT_ICON_NAME = "Voiceflow's icon";

type IconFile = { file: File } | { problem: string };

async function defaultIcon(): Promise<IconFile> {
  try {
    return { file: new File([await readFile(fileURLToPath(DEFAULT_ICON))], 'voiceflow-icon.png', { type: 'image/png' }) };
  } catch (error) {
    return { problem: `it isn't in this package (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` };
  }
}

/** Downloads an image to be an icon, or says why it couldn't. */
async function downloadIcon(url: string, doFetch: typeof fetch): Promise<IconFile> {
  let res: Response;
  try {
    res = await doFetch(url);
  } catch (error) {
    return { problem: `it couldn't be downloaded (${(error as Error).message})` };
  }
  if (!res.ok) return { problem: `it couldn't be downloaded (HTTP ${res.status})` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_ICON_BYTES) return { problem: 'it is larger than 10 MB' };
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'icon';
  return { file: new File([bytes], name, { type }) };
}

/** Makes the image the app's icon. Returns why it couldn't, or nothing. */
async function setAppIcon(slack: SlackApi, appId: string, image: Promise<IconFile>): Promise<string | undefined> {
  const icon = await image;
  if ('problem' in icon) return icon.problem;
  try {
    await slack('apps.icon.set', { app_id: appId, file: icon.file }, { multipart: true });
    return undefined;
  } catch (error) {
    if (!(error instanceof SlackApiError)) throw error;
    if (error.error === 'invalid_icon_size') return 'Slack takes icons from 512 to 2000 pixels';
    if (error.error === 'error_bad_format') return 'Slack takes a PNG, JPG or GIF';
    return `Slack answered ${error.error}`;
  }
}

/** A URL connect may download an icon from. */
function iconUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Reads Slack and Voiceflow and works out what connect would change. Writes nothing. */
export async function planConnect(slack: SlackApi, options: ConnectSlackOptions): Promise<ConnectPlan> {
  const { voiceflow } = options;
  if (!voiceflow.environment) throw new TypeError('connectSlack: `voiceflow.environment` is required');
  // The workspace check comes first: nothing else is read or written for a project in the wrong one.
  const project = await checkProject(voiceflow);
  const auth = await slack<{ team_id: string; team: string }>('auth.test');
  if (options.slack.teamId && auth.team_id !== options.slack.teamId) {
    throw new Error(`The Slack login is for workspace ${auth.team_id}, not ${options.slack.teamId}. Nothing was changed.`);
  }
  const team = { id: auth.team_id, name: auth.team };
  const { icon, ...appOptions } = options.app ?? {};
  // A new app takes the agent's name, in the characters Slack allows; a name you give is yours to get right.
  const wanted = slackManifest({
    ...appOptions,
    name: appOptions.name ?? appNameOf(project.name),
    requestUrl: options.requestUrl,
    ...(options.tools === false ? {} : { tools: options.tools ?? {} }),
  });
  if (typeof icon === 'string' && !iconUrl(icon)) throw new TypeError(`connectSlack: the icon must be an image's http(s) URL, not "${icon}"`);

  const records = options.appRecords ?? fileAppRecordStore();
  const recorded = await records.get(appRecordKey(team.id, project.id, voiceflow.environment));
  const appId = options.appId ?? recorded?.appId;
  let app: ConnectPlan['app'];
  let previous: SlackManifest | undefined;
  let note: string | undefined;
  if (appId) {
    try {
      previous = (await slack<{ manifest: SlackManifest }>('apps.manifest.export', { app_id: appId })).manifest;
    } catch (error) {
      const gone = error instanceof SlackApiError && ['app_not_found', 'invalid_app_id', 'invalid_app'].includes(error.error);
      if (!gone || options.appId) throw error;
      note = `the app connect made before (${appId}) no longer exists, so a new one is made`;
    }
  }
  if (previous) {
    const { manifest, changes } = mergeManifest(previous, wanted);
    const changed = JSON.stringify(manifest) !== JSON.stringify(previous);
    if (changed) await validate(slack, manifest, appId);
    app = { action: changed ? 'update' : 'unchanged', id: appId!, name: previous.display_information?.name ?? appId!, manifest, previous, changes };
  } else {
    await validate(slack, wanted);
    app = { action: 'create', name: wanted.display_information.name, manifest: wanted, ...(note ? { note } : {}) };
  }
  // An icon you name goes on any app; the agent's avatar (or Voiceflow's icon) only on a new one, so an icon set in Slack stays.
  const agentIcon = project.image ? iconUrl(project.image) : undefined;
  if (typeof icon === 'string') app.icon = { from: 'option', url: iconUrl(icon)! };
  else if (icon !== false && app.action === 'create') app.icon = agentIcon ? { from: 'agent', url: agentIcon } : { from: 'default' };

  let install: InstallResult | undefined;
  if (options.tools !== false) {
    install = await installTools(slackTools(options.tools), {
      ...voiceflow,
      ...(options.restore ? { restore: options.restore } : {}),
      secretValues: { [TOOLS_URL_SECRET]: toolsUrlOf(options) },
      dryRun: true,
    });
  }
  const plan: ConnectPlan = { team, project, environment: voiceflow.environment, app, ...(install ? { voiceflow: install } : {}), lines: [] };
  plan.lines = planLines(plan, options);
  return plan;
}

async function validate(slack: SlackApi, manifest: SlackManifest, appId?: string): Promise<void> {
  try {
    await slack('apps.manifest.validate', { manifest: JSON.stringify(manifest), ...(appId ? { app_id: appId } : {}) });
  } catch (error) {
    if (error instanceof SlackApiError && error.error === 'invalid_manifest') {
      const problems = (error.details as { message?: string; pointer?: string }[]).map((d) => `${d.pointer ?? ''} ${d.message ?? ''}`.trim());
      throw new Error(`Slack refused the manifest, so nothing was changed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    }
    throw error;
  }
}

function planLines(plan: ConnectPlan, options: ConnectSlackOptions): string[] {
  const { app } = plan;
  const m = app.manifest;
  const command = (m.features.slash_commands as { command: string }[] | undefined)?.map((c) => c.command).join(', ');
  const lines = [`Slack: workspace ${plan.team.name} (${plan.team.id})`];
  if (app.note) lines.push(`  (${app.note})`);
  if (app.action === 'create') {
    lines.push(
      `  + create app "${app.name}" from the manifest: ${m.oauth_config.scopes.bot.length} bot scopes, ${m.settings.event_subscriptions.bot_events.length} events, the assistant panel, the Home tab${command ? `, ${command}` : ''}`,
      `    requests go to ${options.requestUrl} (Slack checks it answers while it creates the app)`,
      ...(m.oauth_config.scopes.user?.length ? [`    and user scopes, so it can act as you: ${m.oauth_config.scopes.user.join(', ')}`] : []),
    );
  } else if (app.action === 'update') {
    const c = app.changes!;
    const parts = [
      c.scopesAdded.length ? `add scopes ${c.scopesAdded.join(', ')}` : '',
      c.userScopesAdded.length ? `add user scopes ${c.userScopesAdded.join(', ')} (it acts as you with these)` : '',
      c.eventsAdded.length ? `add events ${c.eventsAdded.join(', ')}` : '',
      c.urlFrom ? `requests go to ${options.requestUrl} instead of ${c.urlFrom}` : '',
      c.commandAdded ? `add ${c.commandAdded}` : '',
      c.assistantAdded ? 'turn on the assistant panel' : '',
      c.homeTabTurnedOn ? 'turn on the Home tab' : '',
      c.messagesTabTurnedOn ? 'let people message it in the Messages tab' : '',
    ].filter(Boolean);
    lines.push(`  ~ update app ${app.id} "${app.name}": ${parts.join('; ') || 'URLs and settings'} (nothing is taken away)`);
  } else {
    lines.push(`  = app ${app.id} "${app.name}" has everything this package uses`);
  }
  if (app.icon?.from === 'agent')
    lines.push(`  + set its icon to the agent's avatar in Voiceflow (${DEFAULT_ICON_NAME} if Slack won't take it): ${app.icon.url}`);
  else if (app.icon?.from === 'option') lines.push(`  + set its icon to the image: ${app.icon.url}`);
  else if (app.icon) lines.push(`  + set its icon to ${DEFAULT_ICON_NAME} (the agent has no avatar in Voiceflow)`);
  lines.push(`  + install it in ${plan.team.name} (its bot token is for your server alone: it never goes to Voiceflow)`);
  lines.push(...voiceflowLines(plan, options));
  return lines;
}

/** The Voiceflow half of a plan: the agent, and each step of installing the tools on it. */
function voiceflowLines(
  plan: Pick<ConnectPlan, 'project' | 'environment' | 'voiceflow'>,
  options: Pick<ConnectSlackOptions, 'toolsUrl' | 'requestUrl'>,
): string[] {
  const lines = [
    `Voiceflow: project "${plan.project.name}" (${plan.project.id}) in workspace ${plan.project.workspaceID}, environment ${plan.environment} (nothing is published)`,
  ];
  if (plan.voiceflow) {
    lines.push(...plan.voiceflow.steps.map((s) => `  ${connectStepLine(s)}`));
    if (plan.voiceflow.steps.some((s) => s.kind === 'secret' && s.name === TOOLS_URL_SECRET)) {
      lines.push(`    Slack's tools run on your server: the agent calls them at ${toolsUrlOf(options)}`);
    }
    lines.push(...plan.voiceflow.notes.map((note) => `  ! ${note}`));
  } else lines.push('  = no tools installed (tools: false)');
  return lines;
}

/** A plan step as a line, with what the tools URL secret holds said in words. */
export function connectStepLine(step: Step): string {
  if (step.kind === 'secret' && step.name === TOOLS_URL_SECRET && step.value === 'set') {
    return `${step.action === 'create' ? '+' : '='} secret ${step.name} (${secretState(step)}; value: where your server runs the tools)`;
  }
  return formatStep(step);
}

// ── Disconnecting ───────────────────────────────────────────────────────────

export interface DisconnectSlackOptions {
  slack: ConnectSlackOptions['slack'];
  voiceflow: ConnectSlackOptions['voiceflow'];
  /** The app to delete. Default: the one connect made for this agent. */
  appId?: string;
  /** Also take Slack's tools off the agent (functions you edited are only detached). Default: `false`, the tools stay. */
  removeTools?: boolean;
  appRecords?: AppRecordStore;
  confirm?: (lines: string[]) => boolean | Promise<boolean>;
  onProgress?: (line: string) => void;
}

/** Deletes the Slack app connect made and, if asked, takes Slack's tools off the agent. */
export async function disconnectSlack(options: DisconnectSlackOptions): Promise<{ applied: boolean; lines: string[]; appId?: string }> {
  const slack = createSlackApi(options.slack);
  const project = await checkProject(options.voiceflow);
  const auth = await slack<{ team_id: string; team: string }>('auth.test');
  if (options.slack.teamId && auth.team_id !== options.slack.teamId) {
    throw new Error(`The Slack login is for workspace ${auth.team_id}, not ${options.slack.teamId}. Nothing was changed.`);
  }
  const records = options.appRecords ?? fileAppRecordStore();
  const key = appRecordKey(auth.team_id, project.id, options.voiceflow.environment);
  const appId = options.appId ?? (await records.get(key))?.appId;
  const lines = [
    `Slack: workspace ${auth.team} (${auth.team_id})`,
    appId ? `  - delete app ${appId} (its tokens stop working)` : '  = no app recorded for this agent',
  ];
  let removal: InstallResult | undefined;
  if (options.removeTools) {
    removal = await uninstallTools(slackTools(), { ...options.voiceflow, dryRun: true });
    lines.push(
      `Voiceflow: project "${project.name}" (${project.id}), environment ${options.voiceflow.environment} (nothing is published)`,
      ...removal.steps.map((s) => `  ${formatStep(s)}`),
    );
  } else {
    lines.push("Voiceflow: the tools stay on the agent (they're yours now); --remove-tools takes them off");
  }
  if (options.confirm && !(await options.confirm(lines))) return { applied: false, lines };
  const say = options.onProgress ?? (() => {});
  if (appId) {
    await slack('apps.manifest.delete', { app_id: appId });
    if ((await records.get(key))?.appId === appId) await records.set(key, null);
    say(`- deleted Slack app ${appId}`);
  }
  if (options.removeTools) await uninstallTools(slackTools(), { ...options.voiceflow, onStep: (s) => say(formatStep(s)) });
  return { applied: true, lines, ...(appId ? { appId } : {}) };
}

export { cli } from './cli.js';
export {
  NeedsYou,
  SLACK_CLI_INSTALL,
  SLACK_CLI_INSTALL_WINDOWS,
  type SlackCliHost,
  type SlackSignInOptions,
  slackSignIn,
} from './sign-in.js';
