// The Slack app this package needs: every scope, event and feature it uses, and
// the scopes Slack's tools need. `connect slack` creates the app from it; you can
// also paste it into api.slack.com ("Create New App" > "From a manifest").
import { slackTools, slackToolScopes, type SlackToolsOptions } from '../tools/index.js';

/** What the bot itself uses: mentions, threads, DMs, the assistant panel, reactions, slash commands, the person's profile. */
export const BOT_SCOPES = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'commands',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'users:read',
  'users:read.email',
] as const;

export const BOT_EVENTS = [
  'app_home_opened',
  'app_mention',
  'assistant_thread_context_changed',
  'assistant_thread_started',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'reaction_added',
  'reaction_removed',
] as const;

export const DEFAULT_COMMAND = '/ask';

export interface ManifestOptions {
  /** Where Slack sends events, button clicks and slash commands: your server's Slack webhook (`https://…/api/slack`). */
  requestUrl: string;
  /** The app's name in Slack. Default: `Voiceflow agent`. */
  name?: string;
  description?: string;
  /** The bot's display name (lowercase, no spaces). Default: from `name`. */
  botName?: string;
  /** The slash command, or `false` for none. Default: `/ask`. */
  command?: string | false;
  /** Which of Slack's tools the app needs scopes for, or `false` for none. Default: all. */
  tools?: SlackToolsOptions | false;
}

export interface SlackManifest {
  display_information: { name: string; description?: string };
  features: Record<string, any>;
  oauth_config: { scopes: { bot: string[]; user?: string[] }; [key: string]: unknown };
  settings: Record<string, any>;
  [key: string]: unknown;
}

const MAX_NAME = 35;
const MAX_BOT_NAME = 80;

function botNameOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'voiceflow-agent').slice(0, MAX_BOT_NAME);
}

/** Every bot scope the app needs: the bot's own and the tools'. Sorted, no repeats. */
export function requiredScopes(tools: SlackToolsOptions | false = {}): string[] {
  const toolScopes = tools === false ? [] : slackToolScopes(slackTools(tools));
  return [...new Set<string>([...BOT_SCOPES, ...toolScopes])].sort();
}

/** The manifest of a new app with everything this package uses. */
export function slackManifest(options: ManifestOptions): SlackManifest {
  const requestUrl = checkUrl(options.requestUrl);
  const name = (options.name ?? 'Voiceflow agent').slice(0, MAX_NAME);
  const description = options.description ?? 'A Voiceflow agent.';
  const command = options.command === undefined ? DEFAULT_COMMAND : options.command;
  return {
    display_information: { name, description },
    features: {
      app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: options.botName ?? botNameOf(name), always_online: true },
      assistant_view: { assistant_description: description },
      ...(command ? { slash_commands: [slashCommand(command, requestUrl, name)] } : {}),
    },
    oauth_config: { scopes: { bot: requiredScopes(options.tools) } },
    settings: {
      event_subscriptions: { request_url: requestUrl, bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true, request_url: requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export interface ManifestChanges {
  scopesAdded: string[];
  eventsAdded: string[];
  /** The request URL changed from this one. */
  urlFrom?: string;
  commandAdded?: string;
  assistantAdded: boolean;
  homeTabTurnedOn: boolean;
  messagesTabTurnedOn: boolean;
}

/**
 * An app that already exists, with what this package needs added: scopes,
 * events and features are only ever added, never taken away, and the event,
 * interactivity and slash command URLs point at `requestUrl`.
 */
export function mergeManifest(existing: SlackManifest, wanted: SlackManifest): { manifest: SlackManifest; changes: ManifestChanges } {
  const manifest = structuredClone(existing);
  const before = {
    scopes: new Set<string>(existing.oauth_config?.scopes?.bot ?? []),
    events: new Set<string>(existing.settings?.event_subscriptions?.bot_events ?? []),
  };
  const requestUrl = wanted.settings.event_subscriptions.request_url as string;
  const scopes = [...new Set([...before.scopes, ...wanted.oauth_config.scopes.bot])].sort();
  const events = [...new Set([...before.events, ...wanted.settings.event_subscriptions.bot_events])].sort();
  manifest.oauth_config = { ...manifest.oauth_config, scopes: { ...manifest.oauth_config?.scopes, bot: scopes } };

  const features = (manifest.features ??= {});
  const assistantAdded = !features.assistant_view;
  if (assistantAdded) features.assistant_view = wanted.features.assistant_view;
  if (!features.bot_user) features.bot_user = wanted.features.bot_user;
  const home = (features.app_home ??= {});
  const homeTabTurnedOn = home.home_tab_enabled !== true;
  const messagesTabTurnedOn = home.messages_tab_enabled !== true || home.messages_tab_read_only_enabled === true;
  Object.assign(home, { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false });

  let commandAdded: string | undefined;
  const wantedCommand = (wanted.features.slash_commands as any[] | undefined)?.[0];
  if (wantedCommand) {
    const commands = (features.slash_commands ??= []) as any[];
    const same = commands.find((c) => c.command === wantedCommand.command);
    if (same) same.url = requestUrl;
    else {
      commands.push(wantedCommand);
      commandAdded = wantedCommand.command;
    }
  }

  const urlFrom = existing.settings?.event_subscriptions?.request_url;
  manifest.settings = {
    ...manifest.settings,
    event_subscriptions: { ...manifest.settings?.event_subscriptions, request_url: requestUrl, bot_events: events },
    interactivity: { ...manifest.settings?.interactivity, is_enabled: true, request_url: requestUrl },
    socket_mode_enabled: false,
  };
  return {
    manifest,
    changes: {
      scopesAdded: scopes.filter((s) => !before.scopes.has(s)),
      eventsAdded: events.filter((e) => !before.events.has(e)),
      ...(urlFrom !== requestUrl ? { urlFrom: urlFrom ?? '(none)' } : {}),
      ...(commandAdded ? { commandAdded } : {}),
      assistantAdded,
      homeTabTurnedOn,
      messagesTabTurnedOn,
    },
  };
}

function slashCommand(command: string, url: string, name: string) {
  if (!/^\/[a-z0-9_-]{1,31}$/.test(command)) throw new Error(`"${command}" isn't a slash command Slack accepts: a "/" and up to 31 lowercase letters, digits, "-" or "_".`);
  return { command, url, description: `Ask ${name} a question`, usage_hint: "what's our refund policy?", should_escape: false };
}

function checkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`The request URL "${url}" isn't a URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`Slack only sends to https URLs, and "${url}" isn't one.`);
  return url;
}
