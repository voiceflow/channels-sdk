// `connect discord`: from a Discord bot token to a bot your Voiceflow agent
// answers through. Discord has no way to make an application from outside its
// Developer Portal, so a person makes one there and copies its bot token: the
// one step by hand. Connect does the rest with that token: it gives a new bot
// your agent's name and picture, turns on the intent that lets the bot read
// what people write, adds the slash command, creates the `discord_*` variables
// on the agent, gives Discord your server's address, and says what link adds
// the bot to a server.
//
// It shows its whole plan before it changes anything, and running it again
// only adds what's missing. The bot's token is for your server alone: it never
// goes to Voiceflow.
//
// Node only: import it from `@voiceflow/channelkit-discord/connect`.
import { type ApiOptions, checkProject, type InstallResult, installTools, memoryRecordStore } from '@voiceflow/channelkit/install';
import { downloadIcon, type IconFile, iconUrl, VOICEFLOW_ICON_NAME, voiceflowIcon } from '@voiceflow/channelkit/setup';
import { CONTEXT_VARIABLES } from '../context.js';
import { APP_FLAGS, createDiscordApi, DEVELOPER_PORTAL, type DiscordApi, DiscordApiError, type DiscordApiOptions, installLink, isSnowflake } from './api.js';

export const DEFAULT_COMMAND = 'ask';
/** The path of your server's Discord route, where the starter puts it. */
export const WEBHOOK_PATH = '/api/discord';

// ── The application a bot token belongs to ──────────────────────────────────

export interface DiscordApp {
  id: string;
  name: string;
  /** What your server checks Discord's signature with: DISCORD_PUBLIC_KEY. */
  publicKey: string;
  flags: number;
  /** Where Discord sends slash commands and button clicks. Empty when they come over the Gateway. */
  endpoint: string;
  botId: string;
  /** The bot's name as people see it. */
  botName: string;
  /** The bot's username: the name connect sets. */
  botUsername: string;
  /** Whether the bot has a picture of its own. */
  hasAvatar: boolean;
  /** Whether the application has an icon: what the page that adds the bot shows. */
  hasIcon: boolean;
  /** How many servers the bot is in (counted up to 200), where Discord says. */
  servers?: number;
  /** Who the application belongs to: the person who made it, or its team's owner. */
  ownerId?: string;
}

/** Reads the application the token belongs to. A token Discord refuses is said plainly. */
export async function readApp(api: DiscordApi): Promise<DiscordApp> {
  let app: any;
  try {
    app = await api('GET', '/applications/@me');
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 401) {
      throw new Error(`Discord refused the bot token (401). Copy it again: ${DEVELOPER_PORTAL} → your app → Bot → Reset Token. Nothing was changed.`);
    }
    throw error;
  }
  // The application's own count of servers is brought up to date once a day: a bot added a minute ago is still
  // "in none" by it. The bot's list of its servers is as things are.
  const servers = await botServers(api).then(
    (list) => list.length,
    () => undefined,
  );
  return {
    id: String(app.id),
    name: String(app.name ?? ''),
    publicKey: String(app.verify_key ?? ''),
    flags: Number(app.flags ?? 0),
    endpoint: String(app.interactions_endpoint_url ?? ''),
    botId: String(app.bot?.id ?? app.id),
    botName: String(app.bot?.global_name || app.bot?.username || app.name || ''),
    botUsername: String(app.bot?.username ?? ''),
    hasAvatar: Boolean(app.bot?.avatar),
    hasIcon: Boolean(app.icon),
    ...(servers !== undefined ? { servers } : {}),
    ...(app.team?.owner_user_id || app.owner?.id ? { ownerId: String(app.team?.owner_user_id || app.owner.id) } : {}),
  };
}

/** Whether the bot is sent what people write: the Message Content intent, either way it's had. */
export function readsMessages(app: Pick<DiscordApp, 'flags'>): boolean {
  return (app.flags & (APP_FLAGS.GATEWAY_MESSAGE_CONTENT | APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0;
}

// ── The bot's name and picture ──────────────────────────────────────────────

/**
 * An agent's name as a Discord bot's: 2 to 32 characters, without the "@", "#", ":" and "```" Discord
 * refuses in a name. Empty when nothing usable is left.
 */
export function botNameOf(agentName: string): string {
  const name = agentName
    .replace(/```|[@#:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
    .trim();
  return name.length >= 2 ? name : '';
}

type Picture = { from: 'agent' | 'option'; url: string } | { from: 'default' };

/**
 * Makes the image the bot's picture, and the application's icon where `icon` says. Returns why the picture
 * couldn't be set, and why the icon couldn't: nothing for each that was.
 */
async function setPicture(api: DiscordApi, image: Promise<IconFile>, icon: boolean): Promise<{ avatar?: string; icon?: string }> {
  const file = await image;
  if ('problem' in file) return { avatar: file.problem };
  const data = `data:${file.file.type};base64,${Buffer.from(await file.file.arrayBuffer()).toString('base64')}`;
  try {
    await api('PATCH', '/users/@me', { avatar: data });
  } catch (error) {
    if (!(error instanceof DiscordApiError)) throw error;
    return { avatar: error.message };
  }
  if (!icon) return {};
  try {
    await api('PATCH', '/applications/@me', { icon: data });
    return {};
  } catch (error) {
    if (!(error instanceof DiscordApiError)) throw error;
    return { icon: error.message };
  }
}

// ── Once the bot is in a server ─────────────────────────────────────────────

export interface DiscordServer {
  id: string;
  name: string;
}

/** The servers the bot is in, as its own list of them says (the first 200). */
export async function botServers(api: DiscordApi): Promise<DiscordServer[]> {
  const list = await api<{ id?: unknown; name?: unknown }[]>('GET', '/users/@me/guilds?limit=200');
  return (Array.isArray(list) ? list : []).map((server) => ({ id: String(server.id ?? ''), name: String(server.name ?? '') }));
}

/**
 * Waits for the bot to be added to a server: a person does that, on a page of Discord's. Returns the server,
 * or nothing when the time is up. A call that fails is tried again: the wait is no place to stop for one.
 */
export async function waitForServer(
  api: DiscordApi,
  options: { timeoutMs?: number; everyMs?: number; wait?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<DiscordServer | undefined> {
  const every = options.everyMs ?? 2000;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited <= (options.timeoutMs ?? 300_000) && !options.signal?.aborted; waited += every) {
    const [server] = await botServers(api).catch(() => []);
    if (server) return server;
    await wait(every);
  }
  return undefined;
}

/** What a new bot says to whoever made it: that it's there, and what's left before it answers. */
export function greetingText(bot: { name: string; server: string; command?: string }): string {
  return `${bot.name} is connected to ${bot.server}. Once your server is running, mention me in a channel there, message me here${bot.command ? `, or use /${bot.command}` : ''}.`;
}

/**
 * Has the bot message the person its application belongs to: proof, in Discord, that it is there and can
 * speak. It can only once it shares a server with them. Returns why it couldn't, when it couldn't: a greeting
 * that fails is no reason to fail a connect that worked.
 */
export async function sendGreeting(api: DiscordApi, options: { userId: string; text: string }): Promise<string | undefined> {
  try {
    const dm = await api<{ id: string }>('POST', '/users/@me/channels', { recipient_id: options.userId });
    await api('POST', `/channels/${dm.id}/messages`, { content: options.text });
    return undefined;
  } catch (error) {
    if (!(error instanceof DiscordApiError)) throw error;
    return error.code === 50007 ? "your privacy settings don't let a server's members message you" : error.message;
  }
}

// ── The slash command ───────────────────────────────────────────────────────

interface CommandBody {
  name: string;
  type: 1;
  description: string;
  options: { type: 3; name: string; description: string; required: true }[];
}

/** The slash command: `/ask question: …`. The question is its one, required, option. */
export function askCommand(name: string, agentName: string): CommandBody {
  return {
    name,
    type: 1,
    description: `Ask ${agentName || 'the agent'} a question`.slice(0, 100),
    options: [{ type: 3, name: 'question', description: 'What you want to ask', required: true }],
  };
}

/** A command's name as Discord takes it: no "/", lowercase, up to 32 letters, digits, "-" and "_". */
export function commandName(given: string): string {
  const name = given.replace(/^\//, '');
  if (!/^[-_\p{Ll}\p{N}]{1,32}$/u.test(name))
    throw new TypeError(`"${given}" isn't a slash command's name: Discord takes 1 to 32 lowercase letters, digits, "-" and "_".`);
  return name;
}

function sameCommand(existing: any, wanted: CommandBody): boolean {
  const option = existing?.options?.[0];
  return (
    existing?.description === wanted.description &&
    existing?.options?.length === 1 &&
    option?.type === 3 &&
    option?.name === wanted.options[0]!.name &&
    option?.description === wanted.options[0]!.description &&
    option?.required === true
  );
}

// ── Connect ─────────────────────────────────────────────────────────────────

type VoiceflowOptions = ApiOptions & { projectID: string; environment: string; expectWorkspace?: string };

export interface ConnectDiscordOptions {
  discord: DiscordApiOptions;
  voiceflow: VoiceflowOptions;
  /**
   * Your server's Discord route as Discord reaches it (`https://…/api/discord`).
   * Discord checks it answers as it takes it. Omit it for a server on this
   * machine: `voiceflow-channelkit dev` gives Discord the address each time it starts.
   */
  interactionsUrl?: string;
  /** The slash command's name, or `false` for none. Default: `ask`. */
  command?: string | false;
  /**
   * The bot's name in Discord. Default: a new app's bot (one with no slash
   * command yet) gets your agent's name in Voiceflow, and a bot connected
   * before keeps its name. `false` to leave it.
   */
  name?: string | false;
  /**
   * The bot's picture: an image's URL (PNG, JPG or GIF). Default: a bot with
   * no picture gets the agent's avatar in Voiceflow, or Voiceflow's icon when
   * the agent has none (or Discord won't take it); a bot with a picture keeps
   * it. `false` for none.
   */
  icon?: string | false;
  /** Create the `discord_*` variables on the agent. Default: `true`. */
  variables?: boolean;
  /** The server the bot is to be added to, by its ID: the page that adds the bot opens with it chosen. */
  server?: string;
  /** Shown the plan before anything is changed. Return `false` to stop. */
  confirm?: (plan: ConnectPlan) => boolean | Promise<boolean>;
  onProgress?: (line: string) => void;
}

export interface ConnectPlan {
  app: DiscordApp;
  project: { id: string; name: string; workspaceID: string };
  /** The plan, a line per thing, for a person to read. */
  lines: string[];
  /** Whether the agent gets anything new. */
  installs: boolean;
  /** The slash command's name, where there is one. */
  command?: string;
}

export interface ConnectResult {
  applied: boolean;
  plan: ConnectPlan;
  install?: InstallResult;
  /** What happened to the address Discord sends slash commands and buttons to. */
  endpoint: 'set' | 'unchanged' | 'local' | 'refused';
  /** What's left for a person, each a line: an intent Discord wouldn't turn on, an address it couldn't verify. */
  problems: string[];
  /** What connect couldn't do and the bot works without, each a line: a name or a picture Discord wouldn't take. */
  notes: string[];
  /** The link that adds the bot to a server. */
  installLink: string;
}

const VARIABLE_SET = { channel: 'discord', variables: CONTEXT_VARIABLES, tools: [] };

export async function connectDiscord(options: ConnectDiscordOptions): Promise<ConnectResult> {
  const api = createDiscordApi(options.discord);
  const say = options.onProgress ?? (() => {});
  const app = await readApp(api);
  const project = await checkProject(options.voiceflow);
  const wantsVariables = options.variables !== false;
  // No tools to keep track of, so nothing is recorded on disk.
  const voiceflow = { ...options.voiceflow, record: memoryRecordStore() };
  const dry = wantsVariables ? await installTools(VARIABLE_SET, { ...voiceflow, dryRun: true }) : undefined;
  const newVariables = dry?.steps.filter((s) => s.kind === 'variable' && s.action === 'create').map((s) => (s as { name: string }).name) ?? [];

  const name = options.command === false ? undefined : commandName(options.command ?? DEFAULT_COMMAND);
  const wanted = name ? askCommand(name, project.name) : undefined;
  const commands = (await api<any[]>('GET', `/applications/${app.id}/commands`)) ?? [];
  const existing = wanted ? commands.find((c) => c?.name === wanted.name && (c.type ?? 1) === 1) : undefined;
  const commandAction = !wanted ? 'none' : !existing ? 'add' : sameCommand(existing, wanted) ? 'same' : 'update';
  const intent = readsMessages(app);
  const url = options.interactionsUrl;

  // A name you give goes on any bot; the agent's only on a new app's, so a name set in Discord since stays.
  // An app is new until it has a slash command: connect gives it one.
  if (typeof options.name === 'string' && !options.name.trim()) throw new TypeError('connectDiscord: the name is empty');
  const named = typeof options.name === 'string' ? options.name.trim() : options.name !== false && commands.length === 0 ? botNameOf(project.name) : '';
  const rename = named && named !== app.botUsername ? named : undefined;
  // A picture you name goes on any bot; the agent's avatar (or Voiceflow's icon) only on a bot that has none.
  if (typeof options.icon === 'string' && !iconUrl(options.icon))
    throw new TypeError(`connectDiscord: the icon must be an image's http(s) URL, not "${options.icon}"`);
  const agentIcon = project.image ? iconUrl(project.image) : undefined;
  const picture: Picture | undefined =
    typeof options.icon === 'string'
      ? { from: 'option', url: iconUrl(options.icon)! }
      : options.icon !== false && !app.hasAvatar
        ? agentIcon
          ? { from: 'agent', url: agentIcon }
          : { from: 'default' }
        : undefined;

  const lines = [
    `Discord: app "${app.name}" (${app.id}), bot ${app.botName}`,
    ...(rename
      ? [
          typeof options.name === 'string'
            ? `  ~ name the bot "${rename}" (it is "${app.botUsername}" now)`
            : `  ~ name the bot "${rename}", your agent's name in Voiceflow (it is "${app.botUsername}" now; --name keep leaves it)`,
        ]
      : []),
    ...(picture
      ? [
          picture.from === 'agent'
            ? `  + set the bot's picture to the agent's avatar in Voiceflow (${VOICEFLOW_ICON_NAME} if Discord won't take it): ${picture.url}`
            : picture.from === 'option'
              ? `  + set the bot's picture to the image: ${picture.url}`
              : `  + set the bot's picture to ${VOICEFLOW_ICON_NAME} (the agent has no avatar in Voiceflow)`,
        ]
      : []),
    intent
      ? '  = the Message Content intent is on: the bot is sent what people write'
      : '  + turn on the Message Content intent, so the bot is sent what people write',
    ...(commandAction === 'none'
      ? []
      : [
          commandAction === 'add'
            ? `  + add the /${wanted!.name} command`
            : commandAction === 'update'
              ? `  ~ update the /${wanted!.name} command`
              : `  = the /${wanted!.name} command is there`,
        ]),
    !url
      ? `  · slash commands and buttons need your server's address: \`voiceflow-channelkit dev\` gives it to Discord each time it starts`
      : app.endpoint === url
        ? `  = slash commands and buttons go to ${url}`
        : `  ~ send slash commands and buttons to ${url} (Discord checks your server answers there${app.endpoint ? `; it sends them to ${app.endpoint} now` : ''})`,
    `Voiceflow: project "${project.name}" (${project.id}) in workspace ${project.workspaceID}, environment ${options.voiceflow.environment}${wantsVariables ? ': the variables go on its draft' : ''}`,
    !wantsVariables
      ? '  · no variables (then pass context: false to discord() on your server)'
      : newVariables.length
        ? `  + ${count(newVariables.length, 'variable')} for your agent's prompts (${newVariables.slice(0, 2).join(', ')}${newVariables.length > 2 ? ', …' : ''})\n  ~ compile the environment's draft`
        : `  = ${count(Object.keys(CONTEXT_VARIABLES).length, 'variable')}: there already`,
  ];
  const plan: ConnectPlan = { app, project, lines, installs: newVariables.length > 0, ...(wanted ? { command: wanted.name } : {}) };
  if (options.server !== undefined && !isSnowflake(options.server))
    throw new TypeError(`connectDiscord: "${options.server}" isn't a server's ID (17 to 20 digits)`);
  const link = installLink(app.id, options.server ? { server: options.server } : {});
  if (options.confirm && !(await options.confirm(plan)))
    return { applied: false, plan, endpoint: url ? 'unchanged' : 'local', problems: [], notes: [], installLink: link };

  const problems: string[] = [];
  // A name or a picture Discord won't take is said, and nothing more: the bot works under any.
  const notes: string[] = [];
  const note = (line: string) => {
    notes.push(line);
    say(`! ${line}`);
  };
  const portal = `${DEVELOPER_PORTAL}/${app.id}`;
  if (rename) {
    try {
      await api('PATCH', '/users/@me', { username: rename });
      say(`~ named the bot "${rename}"`);
      app.botName = rename;
      app.botUsername = rename;
    } catch (error) {
      if (!(error instanceof DiscordApiError)) throw error;
      note(`Discord didn't take "${rename}" as the bot's name: ${error.message}. It is still "${app.botUsername}"; name it in ${portal}/bot`);
    }
  }
  if (picture) {
    const doFetch = options.discord.fetch ?? fetch;
    const what = picture.from === 'agent' ? "the agent's avatar" : picture.from === 'option' ? 'the image' : VOICEFLOW_ICON_NAME;
    // The application's icon is what the page that adds the bot shows: it gets the same picture where it has none, or where you named one.
    const icon = picture.from === 'option' || !app.hasIcon;
    let set = await setPicture(api, picture.from === 'default' ? voiceflowIcon() : downloadIcon(picture.url, doFetch), icon);
    const refused = set.avatar;
    // An avatar Discord won't take leaves the bot with Discord's blank picture: Voiceflow's stands in. A picture you named is yours to fix.
    if (refused && picture.from === 'agent') set = await setPicture(api, voiceflowIcon(), icon);
    if (!refused) say(`+ set the bot's picture to ${what}`);
    else if (picture.from !== 'agent') note(`Discord didn't take ${what} as the bot's picture: ${refused}. Set one in ${portal}/bot`);
    else if (set.avatar)
      note(`Discord didn't take the agent's avatar (${refused}) or ${VOICEFLOW_ICON_NAME} (${set.avatar}) as the bot's picture. Set one in ${portal}/bot`);
    else note(`Discord didn't take the agent's avatar as the bot's picture: ${refused}. It has ${VOICEFLOW_ICON_NAME} instead; set another in ${portal}/bot`);
    if (set.icon) note(`The bot has its picture, but Discord didn't take it as the application's icon: ${set.icon}. Set one in ${portal}/information`);
  }
  if (!intent) {
    try {
      await api('PATCH', '/applications/@me', { flags: app.flags | APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED });
      say('+ turned on the Message Content intent');
    } catch (error) {
      problems.push(
        `Discord didn't turn on the Message Content intent (${message(error)}). Turn it on yourself: ${DEVELOPER_PORTAL}/${app.id}/bot → Privileged Gateway Intents → Message Content Intent. Without it the bot can't connect.`,
      );
    }
  }
  if (wanted && commandAction !== 'same') {
    // Sent by name: Discord replaces a command of the same name and leaves the app's others alone.
    await api('POST', `/applications/${app.id}/commands`, wanted);
    say(`${commandAction === 'add' ? '+ added' : '~ updated'} the /${wanted.name} command`);
  }
  let install: InstallResult | undefined;
  if (wantsVariables) {
    install = await installTools(VARIABLE_SET, voiceflow);
    if (newVariables.length) say(`+ ${count(newVariables.length, 'variable')} on ${project.name}\n~ compiled the environment's draft`);
  }
  // Last: Discord asks your server a signed question as it takes the address, and that's the step most likely to wait on you.
  let endpoint: ConnectResult['endpoint'] = url ? 'unchanged' : 'local';
  if (url && app.endpoint !== url) {
    try {
      await setEndpoint(api, url);
      endpoint = 'set';
      say(`~ Discord sends slash commands and buttons to ${url}`);
    } catch (error) {
      if (!(error instanceof EndpointRefused)) throw error;
      endpoint = 'refused';
      problems.push(error.message);
    }
  }
  return { applied: true, plan, ...(install ? { install } : {}), endpoint, problems, notes, installLink: link };
}

// ── Point ───────────────────────────────────────────────────────────────────

/** Discord asked the address a signed question and didn't take the answer. */
export class EndpointRefused extends Error {
  constructor(url: string, said: string) {
    super(
      `Discord couldn't verify ${url}: it sends a signed request there, and your server has to answer it (${said}). ` +
        `Check your server is running at that address with this app's DISCORD_PUBLIC_KEY, then run point again.`,
    );
    this.name = 'EndpointRefused';
  }
}

async function setEndpoint(api: DiscordApi, url: string): Promise<void> {
  try {
    await api('PATCH', '/applications/@me', { interactions_endpoint_url: url });
  } catch (error) {
    // Discord's "Invalid Form Body" on this field is its check of the address failing.
    if (error instanceof DiscordApiError && error.status === 400 && /interactions_endpoint_url/.test(error.message))
      throw new EndpointRefused(url, error.message);
    throw error;
  }
}

export interface PointDiscordOptions {
  discord: DiscordApiOptions;
  /** Your server's Discord route as Discord reaches it (`https://…/api/discord`). */
  interactionsUrl: string;
  onProgress?: (line: string) => void;
}

/**
 * Gives Discord another address for slash commands and button clicks, and
 * changes nothing else. Discord checks the address as it takes it, so your
 * server has to be answering there.
 */
export async function pointDiscord(options: PointDiscordOptions): Promise<{ app: DiscordApp; changed: boolean; was: string }> {
  const api = createDiscordApi(options.discord);
  const say = options.onProgress ?? (() => {});
  const app = await readApp(api);
  const url = options.interactionsUrl;
  if (app.endpoint === url) {
    say(`= Discord sends slash commands and buttons to ${url}`);
    return { app, changed: false, was: app.endpoint };
  }
  await setEndpoint(api, url);
  say(`~ Discord sends slash commands and buttons to ${url} (${app.endpoint ? `it sent them to ${app.endpoint}` : 'it had no address for them'})`);
  return { app, changed: true, was: app.endpoint };
}

/**
 * Asks your server, on this machine, what Discord's Gateway events will ask
 * it: an event passed on with the bot's token, which it takes only if it runs
 * with the same one. So a server that's down, has no Discord route, or reads
 * another token is said before anything is pointed at it.
 *
 * The token goes with the request, so this asks only an address on this machine.
 */
export async function checkServer(options: { url: string; token: string; fetch?: typeof fetch; envFile?: string }): Promise<void> {
  const { url } = options;
  if (!isLoopback(url)) throw new Error(`${url} isn't on this machine: --local-url is your server here (http://127.0.0.1:3000).`);
  const from = options.envFile ? ` in ${options.envFile}` : '';
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-discord-gateway-token': options.token },
      // A type the adapter has no handler for: it checks who sent it, and does nothing.
      body: JSON.stringify({ type: 'GATEWAY_CHANNELKIT_CHECK', timestamp: Date.now(), data: {} }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Nothing answers at ${url} (${message(error)}). Is your server running, and is that its port? Nothing was changed.`);
  }
  if (res.ok) return;
  if (res.status === 401)
    throw new Error(
      `Your server at ${url} runs with another DISCORD_BOT_TOKEN than the one${from || ' here'}. Restart it so it reads the same one. Nothing was changed.`,
    );
  if (res.status === 404 || res.status === 405) throw new Error(`Your server has no Discord route at ${url} (it answered ${res.status}). Nothing was changed.`);
  throw new Error(
    `Your server at ${url} answered ${res.status}. Its own output says why: DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY or DISCORD_APPLICATION_ID may be missing where it runs. Nothing was changed.`,
  );
}

export function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

// ── Disconnect ──────────────────────────────────────────────────────────────

export interface DisconnectDiscordOptions {
  discord: DiscordApiOptions;
  /** The slash command connect added. Default: `ask`. */
  command?: string | false;
  confirm?: (lines: string[]) => boolean | Promise<boolean>;
  onProgress?: (line: string) => void;
}

/**
 * Takes back what connect did in Discord: the slash command, and the address
 * for slash commands and buttons. The application and its bot are yours to
 * remove: a bot token can't delete its own application, or leave a server it
 * was added to by someone else. The agent's variables stay: they're its own now.
 */
export async function disconnectDiscord(options: DisconnectDiscordOptions): Promise<{ applied: boolean; lines: string[] }> {
  const api = createDiscordApi(options.discord);
  const say = options.onProgress ?? (() => {});
  const app = await readApp(api);
  const name = options.command === false ? undefined : commandName(options.command ?? DEFAULT_COMMAND);
  const command = name ? ((await api<any[]>('GET', `/applications/${app.id}/commands`)) ?? []).find((c) => c?.name === name && (c.type ?? 1) === 1) : undefined;
  const lines = [
    `Discord: app "${app.name}" (${app.id})`,
    command ? `  - delete the /${name} command` : `  = no /${name ?? DEFAULT_COMMAND} command to delete`,
    app.endpoint ? `  - stop sending slash commands and buttons to ${app.endpoint}` : '  = no address for slash commands and buttons to clear',
    `  · the app and its bot stay: take the bot out of a server in Discord (Server Settings → Integrations), or delete the app at ${DEVELOPER_PORTAL}/${app.id}`,
    'Voiceflow: the discord_* variables stay on the agent (they are its own now)',
  ];
  if (options.confirm && !(await options.confirm(lines))) return { applied: false, lines };
  if (command) {
    await api('DELETE', `/applications/${app.id}/commands/${command.id}`);
    say(`- deleted the /${name} command`);
  }
  if (app.endpoint) {
    await api('PATCH', '/applications/@me', { interactions_endpoint_url: null });
    say('- Discord has no address for slash commands and buttons now');
  }
  return { applied: true, lines };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
