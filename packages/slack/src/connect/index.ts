// `connect slack`: one command from a Voiceflow agent to a working Slack app.
// It creates the app from this package's manifest (or adds what's missing to
// an app you have), installs it in the workspace, and installs Slack's default
// tools on the agent with the app's bot token as a Voiceflow secret. It shows
// its whole plan before it changes anything, and never publishes the agent.
//
// After that the app and the tools are yours: change them in Slack and in
// Voiceflow. Running connect again only adds what's missing.
//
// Node only: import it from `@voiceflow/channels-slack/connect`.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  checkProject,
  formatStep,
  installTools,
  uninstallTools,
  type ApiOptions,
  type InstallResult,
  type RecordStore,
  type Step,
} from '@voiceflow/channels-sdk/install';
import { slackTools, type SlackToolsOptions } from '../tools/index.js';
import { createSlackApi, SlackApiError, type SlackApi } from './api.js';
import { mergeManifest, slackManifest, type ManifestChanges, type ManifestOptions, type SlackManifest } from './manifest.js';

export { createSlackApi, slackCliLogin, SlackApiError, type SlackApi, type SlackApiOptions, type SlackCliLogin } from './api.js';
export { BOT_EVENTS, BOT_SCOPES, DEFAULT_COMMAND, mergeManifest, requiredScopes, slackManifest, type ManifestChanges, type ManifestOptions, type SlackManifest } from './manifest.js';

export const DEFAULT_APP_RECORD_PATH = '.voiceflow/channels-slack-apps.json';
const BOT_TOKEN_SECRET = 'slack_bot_token';

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
      await writeFile(temp, JSON.stringify(all, null, 2) + '\n');
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
  /** Use this app instead of the one connect made before, or a new one. */
  appId?: string;
  app?: Omit<ManifestOptions, 'requestUrl' | 'tools'>;
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
  project: { id: string; name: string; workspaceID: string };
  environment: string;
  app: {
    action: 'create' | 'update' | 'unchanged';
    id?: string;
    name: string;
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
  botUserId?: string;
  install?: InstallResult;
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
    await records.set(key, { ...before, appId: appId!, teamId: plan.team.id, projectID: plan.project.id, environment: plan.environment, requestUrl, updatedAt: now });
  }

  const installed = await slack<{ api_access_tokens?: { bot?: string } }>(
    'apps.developerInstall',
    { app_id: appId, bot_scopes: manifest.oauth_config.scopes.bot.join(','), outgoing_domains: '[]' },
    { form: true },
  );
  const botToken = installed.api_access_tokens?.bot;
  if (!botToken) throw new Error(`Slack installed app ${appId} but returned no bot token.`);
  const me = await slack<{ user_id: string }>('auth.test', {}, { token: botToken });
  await options.onCredentials?.({ appId: appId!, botToken, botUserId: me.user_id });
  say(`+ installed it in ${plan.team.name}: bot user ${me.user_id}`);

  let install: InstallResult | undefined;
  if (options.tools !== false) {
    install = await installTools(slackTools(options.tools), {
      ...options.voiceflow,
      ...(options.restore ? { restore: options.restore } : {}),
      secretValues: { [BOT_TOKEN_SECRET]: botToken },
      onStep: (step) => say(connectStepLine(step)),
    });
  }
  return { applied: true, plan, appId: appId!, created: plan.app.action === 'create', botToken, ...(signingSecret ? { signingSecret } : {}), botUserId: me.user_id, ...(install ? { install } : {}) };
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
  const wanted = slackManifest({ ...options.app, requestUrl: options.requestUrl, ...(options.tools === false ? {} : { tools: options.tools ?? {} }) });

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

  let install: InstallResult | undefined;
  if (options.tools !== false) {
    install = await installTools(slackTools(options.tools), {
      ...voiceflow,
      ...(options.restore ? { restore: options.restore } : {}),
      // A stand-in, so the plan shows the secret getting a value: the real one exists once the app is installed.
      secretValues: { [BOT_TOKEN_SECRET]: 'planned' },
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
    );
  } else if (app.action === 'update') {
    const c = app.changes!;
    const parts = [
      c.scopesAdded.length ? `add scopes ${c.scopesAdded.join(', ')}` : '',
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
  lines.push(`  + install it in ${plan.team.name} (its bot token stays in memory${plan.voiceflow ? ` and goes to Voiceflow as the ${BOT_TOKEN_SECRET} secret` : ''})`);
  lines.push(`Voiceflow: project "${plan.project.name}" (${plan.project.id}) in workspace ${plan.project.workspaceID}, environment ${plan.environment} (nothing is published)`);
  if (plan.voiceflow) lines.push(...plan.voiceflow.steps.map((s) => `  ${connectStepLine(s)}`));
  else lines.push('  = no tools installed (tools: false)');
  return lines;
}

/** A plan step as a line; the bot token's value is described, never shown. */
export function connectStepLine(step: Step): string {
  if (step.kind === 'secret' && step.name === BOT_TOKEN_SECRET && step.value === 'set') {
    return `${step.action === 'create' ? '+' : '='} secret ${step.name} (${step.action === 'create' ? 'new, restricted' : 'exists'}; value: the app's bot token)`;
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
  const lines = [`Slack: workspace ${auth.team} (${auth.team_id})`, appId ? `  - delete app ${appId} (its tokens stop working)` : '  = no app recorded for this agent'];
  let removal: InstallResult | undefined;
  if (options.removeTools) {
    removal = await uninstallTools(slackTools(), { ...options.voiceflow, dryRun: true });
    lines.push(`Voiceflow: project "${project.name}" (${project.id}), environment ${options.voiceflow.environment} (nothing is published)`, ...removal.steps.map((s) => `  ${formatStep(s)}`));
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
