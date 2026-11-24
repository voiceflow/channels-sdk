// Slack's workspace tools: what the agent can do in Slack beyond answering
// (post, message someone, read a channel, schedule, pin, bookmark, write a
// canvas, send a file). They are server tools: the agent calls them from
// Voiceflow, and they run here, in your app, through the Slack adapter's own
// client. The bot token never leaves your server.
//
// The bot can reach more than the person it's talking to, so every tool acts
// only where that person could: it reads and writes only channels the person
// is a member of, shows what it reads only where everyone could read it, and
// leaves the directory to full members. And anything that leaves the
// conversation (a post in another channel, a message to someone else) waits
// for that person's approval. Who the person is, and which conversation this
// is, come from the turn's pass, which the server made from Slack's verified
// event: the model chooses neither.
import { askFirst, quoted, type ServerTool, type ToolOutcome, type ToolResult, type ToolTurn } from '@voiceflow/channelkit';
import type { Thread } from 'chat';
import { slackAdapter, where } from './adapter.js';

type AnyThread = Thread<any, any>;
/** One Slack Web API call. Answers Slack's JSON, or `{ ok: false, error }`: it never throws. */
type Slack = (method: string, params?: Record<string, unknown>) => Promise<any>;

export interface WorkspaceToolsOptions {
  /** In the assistant panel: the channel the person has open beside it. */
  viewing?: (thread: AnyThread) => string | undefined | Promise<string | undefined>;
  /** For the one request that doesn't go through Slack's client: a file's upload. */
  fetch?: typeof fetch;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Slack's Web API through the adapter's client, which holds the bot token. Empty arguments are left out. */
function slackOf(thread: AnyThread): Slack {
  return async (method, params = {}) => {
    const sent = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    let client: ReturnType<typeof slackAdapter>['webClient'];
    try {
      // Outside a webhook, the adapter has a client only when its bot token is a plain value (one workspace).
      client = slackAdapter(thread).webClient;
    } catch {
      return { ok: false, error: 'no_client' };
    }
    try {
      const data = await client.apiCall(method, sent);
      return data && typeof data === 'object' ? data : { ok: false, error: 'no_answer' };
    } catch (error: any) {
      // Slack's client throws what Slack refuses, with Slack's answer as `data`.
      const data = error?.data;
      if (data && typeof data === 'object' && typeof data.error === 'string') return { ...data, ok: false };
      if (error?.code === 'slack_webapi_rate_limited_error') return { ok: false, error: 'ratelimited' };
      return { ok: false, error: 'request_failed', detail: String(error?.message ?? error) };
    }
  };
}

/** Slack's error, said so the agent can tell the person what to do. */
export function slackProblem(data: any): string {
  const error = data?.error || 'unknown_error';
  const known: Record<string, string> = {
    not_in_channel: "I'm not in that channel. Add me to it first (type /invite @ and my name there).",
    channel_not_found: "I can't find that channel. It may be private and I'm not in it, or the name is wrong.",
    is_archived: 'That channel is archived.',
    user_not_found: "I can't find that person in this workspace.",
    users_not_found: "I can't find that person in this workspace.",
    cannot_dm_bot: "I can't message a bot.",
    restricted_action: "Slack's settings don't let me do that here.",
    no_client: "The server has no Slack token to act with here: Slack's tools need the app's bot token as SLACK_BOT_TOKEN.",
    invalid_auth: "The Slack app's token is missing or wrong on the server: check SLACK_BOT_TOKEN.",
    not_authed: "The Slack app's token is missing on the server: set SLACK_BOT_TOKEN.",
    token_revoked: "The Slack app's token was revoked: reinstall the app and update SLACK_BOT_TOKEN on the server.",
    account_inactive: 'The Slack app was uninstalled: reinstall it and update SLACK_BOT_TOKEN on the server.',
    ratelimited: 'Slack is limiting how fast I can do this. Try again in a minute.',
    time_in_past: 'That time is in the past.',
    time_too_far: 'Slack can only schedule up to 120 days ahead.',
    already_pinned: 'That message is already pinned.',
    message_not_found: "I can't find that message.",
    msg_too_long: 'The message is too long for Slack.',
  };
  if (error === 'missing_scope') return `The Slack app lacks the ${data.needed || 'needed'} permission. Add it to the app and reinstall it.`;
  return known[error] || `Slack refused: ${error}.`;
}

function refused(result: string): ToolResult {
  return { ok: false, result };
}

/** A Slack user ID, or '' for anything else. */
function personOf(value: unknown): string {
  const id = String(value || '').trim();
  return /^[UW][A-Z0-9]+$/.test(id) ? id : '';
}

const NOT_SHARED = "I can only act in a channel you and I are both in. If you're in that one, add me to it first: type /invite @ and my name there.";

/**
 * A channel the model named (#name, <#C123|name>, C123) or, when it named none,
 * the fallback. A name is looked up among the channels the bot is in, the only
 * ones it can read or post in: one short list, where every channel in the
 * workspace would be many slow pages.
 */
async function resolveChannel(slack: Slack, input: string, fallback: string): Promise<{ id: string; name?: string } | { error: string }> {
  const value = input.trim();
  // An input the model left out can arrive as 0.
  if (!value || value === '0') return /^[CGD][A-Z0-9]+$/.test(fallback) ? { id: fallback } : { error: 'Say which channel.' };
  const mention = value.match(/^<#([CG][A-Z0-9]+)(\|[^>]*)?>$/);
  if (mention) return { id: mention[1]! };
  // Channel names are lower case, so an upper-case C, G or D followed by letters and digits is an ID.
  if (/^[CGD][A-Z0-9]+$/.test(value)) return { id: value };
  const name = value.replace(/^#/, '').trim().toLowerCase();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const data = await slack('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor });
    if (!data.ok) return { error: slackProblem(data) };
    const found = (data.channels || []).find((c: any) => c.name === name);
    if (found) return { id: found.id, name: found.name };
    cursor = data.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  // The same answer as for a channel the person isn't in, so it doesn't say which channels exist.
  return { error: NOT_SHARED };
}

/**
 * Whether the person may act in a channel: they are a member. The conversation
 * they're talking in is theirs by definition. A channel the person isn't in
 * gets the answer a channel the bot isn't in gets, so it says nothing about it.
 */
async function mayUse(slack: Slack, channel: string, user: string, here: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  if (channel === here) return { ok: true };
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const data = await slack('conversations.members', { channel, limit: 1000, cursor });
    if (!data.ok) return { ok: false, problem: data.error === 'channel_not_found' ? NOT_SHARED : slackProblem(data) };
    if ((data.members || []).includes(user)) return { ok: true };
    cursor = data.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  return { ok: false, problem: NOT_SHARED };
}

/**
 * Whether the person is a full member of this workspace, or of its Enterprise
 * Grid organization. Slack shows a guest, or someone from another organization
 * in a shared channel, far less of the workspace than the bot can see, so the
 * directory tools are for full members only: people, never another app.
 */
async function fullMember(slack: Slack, user: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  const [asker, bot] = await Promise.all([slack('users.info', { user }), slack('auth.test')]);
  if (!asker.ok) return { ok: false, problem: slackProblem(asker) };
  if (!bot.ok) return { ok: false, problem: slackProblem(bot) };
  const u = asker.user || {};
  const org = bot.enterprise_id && u.enterprise_user?.enterprise_id === bot.enterprise_id;
  // Another app's message can start a turn too, and it is no one's membership.
  if (u.is_bot || u.is_app_user || u.is_restricted || u.is_ultra_restricted || (u.team_id !== bot.team_id && !org)) {
    return { ok: false, problem: 'Only full members of this workspace can look people up or message them through me.' };
  }
  return { ok: true };
}

/** Who someone is, for a request or a result: their real name, as the workspace has it, and their mention. */
function nameOf(user: any): string {
  return `${user.real_name || user.profile?.real_name || user.name} (<@${user.id}>)`;
}

/**
 * A person the model named (<@U123>, U123, an email, or a name) as their Slack
 * user. A name picks someone only when it can mean no one else: a full name
 * that is one person's, or the only match of any kind. A display name is
 * whatever its owner typed, so one that equals the query while other people
 * match it too is a question, never an answer.
 */
async function resolvePerson(slack: Slack, input: string): Promise<{ user: any } | { error: string }> {
  const value = input.trim().slice(0, 200);
  if (!value) return { error: 'Say who.' };
  const mention = value.match(/^<@([UW][A-Z0-9]+)(\|[^>]*)?>$/);
  const id = mention ? mention[1]! : /^[UW][A-Z0-9]{6,}$/.test(value) ? value : '';
  if (id) {
    const data = await slack('users.info', { user: id });
    return data.ok ? { user: data.user } : { error: slackProblem(data) };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    const data = await slack('users.lookupByEmail', { email: value });
    return data.ok
      ? { user: data.user }
      : { error: data.error === 'users_not_found' ? `No one in this workspace has the email ${value}.` : slackProblem(data) };
  }
  const name = value.replace(/^@/, '').trim().toLowerCase();
  const fullName: any[] = [];
  const all: any[] = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const data = await slack('users.list', { limit: 1000, cursor });
    if (!data.ok) return { error: slackProblem(data) };
    for (const u of data.members || []) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      const real = [u.real_name, u.profile?.real_name].filter(Boolean).map((n: string) => n.toLowerCase());
      const chosen = [u.name, u.profile?.display_name].filter(Boolean).map((n: string) => n.toLowerCase());
      if (real.includes(name)) fullName.push(u);
      if ([...real, ...chosen].some((n) => n.includes(name))) all.push(u);
    }
    cursor = data.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  if (fullName.length === 1) return { user: fullName[0] };
  if (all.length === 1) return { user: all[0] };
  if (!all.length) return { error: `I can't find anyone called ${value}.` };
  const names = (fullName.length ? fullName : all).slice(0, 5).map(nameOf).join(', ');
  return { error: `More than one person matches ${value}: ${names}. Ask which one.` };
}

/** A message's blocks: its text in sections Slack accepts, then who it was sent for. */
function messageBlocks(text: string, note: string) {
  const blocks: any[] = [];
  for (let i = 0; i < text.length && blocks.length < 45; i += 3000) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(i, i + 3000) } });
  if (note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: note }] });
  return blocks;
}

/**
 * A post this tool made in the last two minutes with the same text and note, so
 * a call the agent repeats (it retries when a call is slow) doesn't post twice.
 * Its timestamp, or '' when there is none or the history can't be read.
 */
async function alreadySent(slack: Slack, channel: string, text: string, note: string): Promise<string> {
  const plain = (s: unknown) =>
    String(s || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  const history = await slack('conversations.history', { channel, oldest: String(Math.floor(Date.now() / 1000) - 120), limit: 20 });
  if (!history.ok) return '';
  const same = (history.messages || []).find((m: any) => {
    if (!m.bot_id || plain(m.text) !== plain(text)) return false;
    if (!note) return true;
    return (m.blocks || []).some((b: any) => b.type === 'context' && (b.elements || []).some((e: any) => e.text === note));
  });
  return same ? String(same.ts) : '';
}

/**
 * A time the model gave, as Unix seconds. A relative time (`in 10 minutes`,
 * `+2h`, `in a day`) counts from now, so the agent needn't know the time. A
 * date and time is ISO 8601 (`2026-12-01T09:00`), read in the person's time
 * zone when it has no offset.
 */
export function unixTime(value: unknown, timeZone: unknown): number {
  const text = String(value || '').trim();
  const rel = text.toLowerCase().match(/^(?:in\s+)?\+?\s*(\d+(?:\.\d+)?|an?|one)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)(?:\s+from\s+now)?$/);
  if (rel) {
    const count = /^\d/.test(rel[1]!) ? Number(rel[1]) : 1;
    const unit = rel[2]![0] === 'm' ? 60 : rel[2]![0] === 'h' ? 3600 : rel[2]![0] === 'd' ? 86400 : 604800;
    return Math.round(Date.now() / 1000 + count * unit);
  }
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return Number.NaN;
  const [, y, mo, d, h = '9', mi = '0', s = '0', zone] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (zone) {
    if (zone.toUpperCase() === 'Z') return asUtc / 1000;
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    return (asUtc - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000) / 1000;
  }
  const tz = String(timeZone || '').trim();
  if (!tz || tz === '0') return asUtc / 1000;
  // The zone's offset at that moment, from how Intl writes the same instant there.
  try {
    const parts: Record<string, string> = {};
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    for (const p of format.formatToParts(new Date(asUtc))) parts[p.type] = p.value;
    const there = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return (asUtc - (there - asUtc)) / 1000;
  } catch {
    return asUtc / 1000;
  }
}

/** A message the model pointed at: a Slack link to it, its timestamp in this conversation, or the conversation's first message. */
function messageOf(value: string, here: string, thread: string): { channel: string; ts: string } {
  const text = value.trim();
  const link = text.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (link) return { channel: link[1]!, ts: `${link[2]}.${link[3]}` };
  if (/^\d{10}\.\d{6}$/.test(text)) return { channel: here, ts: text };
  return { channel: here, ts: thread };
}

/** A model's input, cut to the most its kind can be: a name is not a page of text. */
function short(value: string | undefined, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

// ── The tools ───────────────────────────────────────────────────────────────

/** What every tool starts from: Slack, who is asking, and where. `null` when no Slack person is asking. */
function callOf(turn: ToolTurn): { slack: Slack; user: string; here: string; threadTs: string } | null {
  const user = personOf(turn.userId);
  if (!user) return null;
  const { channel, threadTs } = where(turn.thread);
  return { slack: slackOf(turn.thread), user, here: channel, threadTs };
}

type Run = (input: Record<string, string>, turn: ToolTurn) => Promise<ToolOutcome>;

const postToChannel: Run = async (input, turn) => {
  const call = callOf(turn);
  if (!call) return refused("I can't tell who's asking, so I won't post in Slack for them.");
  const { slack, user, here } = call;
  const text = input.text!.trim();
  if (!text) return refused('The message is empty.');
  const channel = await resolveChannel(slack, short(input.channel, 200), '');
  if ('error' in channel) return refused(channel.error);
  const allowed = await mayUse(slack, channel.id, user, here);
  if (!allowed.ok) return refused(allowed.problem);
  // All of it is shown, and what runs is this channel by its ID: a name can't come to mean another one meanwhile.
  if (!turn.approved) return askFirst('Post this message?', `In <#${channel.id}>:\n\n${quoted(text)}`, { ...input, channel: channel.id });
  const note = `Posted for <@${user}>`;
  const earlier = await alreadySent(slack, channel.id, text, note);
  let ts = earlier;
  if (!ts) {
    const sent = await slack('chat.postMessage', { channel: channel.id, text, blocks: messageBlocks(text, note), unfurl_links: false });
    if (!sent.ok) return refused(slackProblem(sent));
    ts = String(sent.ts);
  }
  const link = await slack('chat.getPermalink', { channel: channel.id, message_ts: ts });
  const url = link.ok ? String(link.permalink) : '';
  return {
    ok: true,
    result: `${earlier ? 'Already posted' : 'Posted'} in <#${channel.id}>${url ? `: ${url}` : '.'}${earlier ? " (it went up a moment ago, so I didn't post it twice)" : ''}`,
    channel_id: channel.id,
    message_ts: ts,
    link: url,
  };
};

const messagePerson: Run = async (input, turn) => {
  const call = callOf(turn);
  if (!call) return refused("I can't tell who's asking, so I won't message anyone for them.");
  const { slack, user } = call;
  const text = input.text!.trim();
  if (!text) return refused('The message is empty.');
  const member = await fullMember(slack, user);
  if (!member.ok) return refused(member.problem);
  const found = await resolvePerson(slack, input.person!);
  if ('error' in found) return refused(found.error);
  if (found.user.is_bot || found.user.deleted) return refused("That account can't receive messages.");
  const self = found.user.id === user;
  // A note to themselves reaches no one else. Anyone else is named as the workspace has them, with their title, and it goes to that account.
  if (!turn.approved && !self) {
    const title = found.user.profile?.title ? `, ${found.user.profile.title}` : '';
    return askFirst('Send this direct message?', `To ${nameOf(found.user)}${title}:\n\n${quoted(text)}`, { ...input, person: `<@${found.user.id}>` });
  }
  const opened = await slack('conversations.open', { users: found.user.id });
  if (!opened.ok) return refused(slackProblem(opened));
  const note = self ? '' : `Sent for <@${user}>`;
  const earlier = await alreadySent(slack, opened.channel.id, text, note);
  if (!earlier) {
    const sent = await slack('chat.postMessage', { channel: opened.channel.id, text, blocks: messageBlocks(text, note), unfurl_links: false });
    if (!sent.ok) return refused(slackProblem(sent));
  }
  const who = nameOf(found.user);
  return {
    ok: true,
    result: earlier ? `Already sent to ${who} a moment ago, so I didn't send it twice.` : `Sent to ${who}.`,
    person_id: String(found.user.id),
  };
};

function readChannel(options: WorkspaceToolsOptions): Run {
  return async (input, turn) => {
    const call = callOf(turn);
    if (!call) return refused("I can't tell who's asking, so I won't read Slack for them.");
    const { slack, user, here } = call;
    // Asked in the assistant panel with no channel named: the one they have open beside it.
    const viewing = String((await options.viewing?.(turn.thread)) ?? '').trim();
    const channel = await resolveChannel(slack, short(input.channel, 200), /^[CG]/.test(viewing) ? viewing : here);
    if ('error' in channel) return refused(channel.error);
    // Everyone in this conversation sees what's read, so another channel is read only in a direct message (the assistant panel is one).
    if (channel.id !== here && !here.startsWith('D')) {
      return refused('Everyone here would see what I read, so in a channel I read only that channel. Ask me in a direct message to read another one.');
    }
    const allowed = await mayUse(slack, channel.id, user, here);
    if (!allowed.ok) return refused(allowed.problem);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 20)));
    const history = await slack('conversations.history', { channel: channel.id, limit });
    if (!history.ok) return refused(slackProblem(history));
    const messages = (history.messages || []).filter((m: any) => !m.subtype || m.subtype === 'thread_broadcast' || m.subtype === 'bot_message').reverse();
    const names: Record<string, string> = {};
    for (const m of messages) {
      if (!m.user || names[m.user] !== undefined || Object.keys(names).length >= 25) continue;
      const info = await slack('users.info', { user: m.user });
      names[m.user] = info.ok ? info.user.real_name || info.user.name : m.user;
    }
    const lines = messages.map((m: any) => {
      const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const who = m.user ? names[m.user] || m.user : m.username || m.bot_profile?.name || 'a bot';
      const replies = m.reply_count ? ` [${m.reply_count} replies]` : '';
      return `${when} UTC ${who}: ${String(m.text || '')
        .replace(/\s+/g, ' ')
        .slice(0, 1000)}${replies}`;
    });
    return {
      ok: true,
      result: lines.length ? `The last ${lines.length} messages in <#${channel.id}>, oldest first.` : `<#${channel.id}> has no messages.`,
      channel_id: channel.id,
      messages: lines.join('\n').slice(0, 30000),
    };
  };
}

const findPerson: Run = async (input, turn) => {
  const call = callOf(turn);
  if (!call) return refused("I can't tell who's asking, so I won't search Slack for them.");
  const { slack, user, here } = call;
  const query = short(input.query, 200).toLowerCase();
  if (!query) return refused('Say who to look for.');
  const member = await fullMember(slack, user);
  if (!member.ok) return refused(member.problem);
  const matches: any[] = [];
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) {
    const data = await slack('users.lookupByEmail', { email: query });
    if (data.ok) matches.push(data.user);
    else if (data.error !== 'users_not_found') return refused(slackProblem(data));
  } else {
    let cursor = '';
    for (let page = 0; page < 20 && matches.length < 10; page++) {
      const data = await slack('users.list', { limit: 1000, cursor });
      if (!data.ok) return refused(slackProblem(data));
      for (const u of data.members || []) {
        if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
        const p = u.profile || {};
        const text = [u.name, u.real_name, p.display_name, p.title].filter(Boolean).join(' ').toLowerCase();
        if (text.includes(query) && matches.length < 10) matches.push(u);
      }
      cursor = data.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
  }
  // In a channel the answer is read by everyone there, guests included, so it is the name and mention a message would show.
  // A title and a time zone are for the person alone, in a direct message. Never an email: a workspace can hide those, and the bot sees them all.
  const alone = here.startsWith('D');
  const people = matches.map((u: any) => {
    const parts = [nameOf(u)];
    if (alone && u.profile?.title) parts.push(u.profile.title);
    if (alone && u.tz) parts.push(`time zone ${u.tz}`);
    return parts.join(', ');
  });
  const more = !alone && people.length ? ' For their titles and time zones, ask me in a direct message.' : '';
  return { ok: true, result: people.length ? `Found ${people.length}.${more}` : `No one matches ${query}.`, people: people.join('\n') };
};

const scheduleMessage: Run = async (input, turn) => {
  const call = callOf(turn);
  if (!call) return refused("I can't tell who's asking, so I won't schedule anything for them.");
  const { slack, user, here, threadTs } = call;
  const text = input.text!.trim();
  if (!text) return refused('The message is empty.');
  // A date without an offset is in the person's own time zone.
  const profile = await slack('users.info', { user });
  const when = unixTime(short(input.post_at, 64), profile.ok ? profile.user?.tz : '');
  if (!Number.isFinite(when)) return refused('Give the time as a relative time, like in 10 minutes, or as a date and time, like 2026-12-01T09:00.');
  const named = short(input.channel, 200);
  const channel = await resolveChannel(slack, named, here);
  if ('error' in channel) return refused(channel.error);
  const allowed = await mayUse(slack, channel.id, user, here);
  if (!allowed.ok) return refused(allowed.problem);
  const at = `<!date^${Math.round(when)}^{date_short_pretty} at {time}|${new Date(when * 1000).toISOString()}>`;
  // With no channel named, it goes in this conversation's thread.
  const thread = (!named || named === '0') && channel.id === here && /^\d+\.\d+$/.test(threadTs) ? threadTs : '';
  // A reply in this thread, or a message in a direct message, stays in the conversation. A channel named, this one included, means a post at its top, for everyone in it.
  const stays = channel.id === here && (Boolean(thread) || here.startsWith('D'));
  if (!turn.approved && !stays) {
    return askFirst('Schedule this message?', `In <#${channel.id}>, ${at}:\n\n${quoted(text)}`, { ...input, channel: channel.id });
  }
  const scheduled = await slack('chat.scheduleMessage', {
    channel: channel.id,
    post_at: Math.round(when),
    text,
    blocks: messageBlocks(text, `Scheduled by <@${user}>`),
    thread_ts: thread,
  });
  if (!scheduled.ok) return refused(slackProblem(scheduled));
  return { ok: true, result: `Scheduled in <#${channel.id}> for ${at}.`, scheduled_message_id: String(scheduled.scheduled_message_id) };
};

const pinMessage: Run = async (input, turn) => {
  const call = callOf(turn);
  if (!call) return refused("I can't tell who's asking, so I won't pin anything for them.");
  const { slack, user, here, threadTs } = call;
  const target = messageOf(short(input.message, 500), here, threadTs);
  if (!/^[CGD][A-Z0-9]+$/.test(target.channel) || !/^\d+\.\d+$/.test(target.ts)) return refused('Say which message: paste its link.');
  const allowed = await mayUse(slack, target.channel, user, here);
  if (!allowed.ok) return refused(allowed.problem);
  if (!turn.approved && target.channel !== here) {
    // The link is Slack's own for the message that will be pinned, never the text the model gave.
    const link = await slack('chat.getPermalink', { channel: target.channel, message_ts: target.ts });
    if (!link.ok) return refused(slackProblem(link));
    return askFirst('Pin this message?', `In <#${target.channel}>: ${link.permalink}`, {
      message: `https://slack.com/archives/${target.channel}/p${target.ts.replace('.', '')}`,
    });
  }
  const pinned = await slack('pins.add', { channel: target.channel, timestamp: target.ts });
  if (!pinned.ok) return refused(slackProblem(pinned));
  return { ok: true, result: `Pinned in <#${target.channel}>.` };
};

const addBookmark: Run = async (input, turn) => {
  const call = callOf(turn);
  if (!call) return refused("I can't tell who's asking, so I won't add a bookmark for them.");
  const { slack, user, here } = call;
  const title = short(input.title, 150);
  const link = short(input.link, 2000);
  if (!title || !/^https?:\/\/\S+$/.test(link)) return refused('A bookmark needs a title and a link starting with https://.');
  const channel = await resolveChannel(slack, short(input.channel, 200), here);
  if ('error' in channel) return refused(channel.error);
  const allowed = await mayUse(slack, channel.id, user, here);
  if (!allowed.ok) return refused(allowed.problem);
  // A bookmark sits on the channel's bar for everyone in it, with no name on it: only in a direct message does it stay with the person.
  const stays = channel.id === here && here.startsWith('D');
  if (!turn.approved && !stays) {
    return askFirst('Add this bookmark?', `To the bookmarks bar of <#${channel.id}>:\n\n${quoted(`${title}\n${link}`)}`, { ...input, channel: channel.id });
  }
  const emoji = short(input.emoji, 64).replace(/^:+|:+$/g, '');
  const added = await slack('bookmarks.add', {
    channel_id: channel.id,
    title,
    type: 'link',
    link,
    emoji: emoji && emoji !== '0' ? `:${emoji}:` : '',
  });
  if (!added.ok) return refused(slackProblem(added));
  return { ok: true, result: `Bookmarked ${title} in <#${channel.id}>.` };
};

const createCanvas: Run = async (input, turn) => {
  const call = callOf(turn);
  if (!call) return refused("I can't tell who's asking, so I won't write a canvas for them.");
  const { slack, user, here } = call;
  const title = input.title!.trim();
  const content = input.content!.trim();
  if (!title || !content) return refused('A canvas needs a title and content.');
  const created = await slack('canvases.create', { title: title.slice(0, 255), document_content: { type: 'markdown', markdown: content } });
  if (!created.ok) return refused(slackProblem(created));
  const id = String(created.canvas_id);
  // The person can edit it; the conversation it was asked in can read it (a DM can't be shared to).
  const forPerson = await slack('canvases.access.set', { canvas_id: id, access_level: 'write', user_ids: [user] });
  const shared = /^[CG]/.test(here) ? await slack('canvases.access.set', { canvas_id: id, access_level: 'read', channel_ids: [here] }) : { ok: true };
  const team = await slack('auth.test');
  const link = team.ok && team.url && team.team_id ? `${String(team.url).replace(/\/$/, '')}/docs/${team.team_id}/${id}` : '';
  const notes = [
    !forPerson.ok ? `I couldn't give you edit access (${slackProblem(forPerson)})` : '',
    !shared.ok ? `I couldn't share it here (${slackProblem(shared)})` : '',
  ].filter(Boolean);
  return { ok: true, result: `Created the canvas ${title}${link ? `: ${link}` : '.'}${notes.length ? ` ${notes.join('. ')}.` : ''}`, canvas_id: id, link };
};

function sendFile(options: WorkspaceToolsOptions): Run {
  return async (input, turn) => {
    const call = callOf(turn);
    if (!call) return refused("I can't tell who's asking, so I won't send a file for them.");
    const { slack, here, threadTs } = call;
    const filename = input.filename!.trim().replace(/[\\/:*?"<>|]+/g, '-');
    const content = input.content!;
    if (!filename || !content) return refused('A file needs a name and content.');
    const length = Buffer.byteLength(content, 'utf8');
    if (length > 900_000) return refused('That file is too big to send from here (about 900 KB at most).');
    const slot = await slack('files.getUploadURLExternal', { filename, length });
    if (!slot.ok) return refused(slackProblem(slot));
    let status: number;
    try {
      // Slack's own upload address, from the call above: the one request that carries no token.
      const uploaded = await (options.fetch ?? fetch)(slot.upload_url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
      });
      status = uploaded.ok ? 0 : uploaded.status;
    } catch {
      status = -1;
    }
    if (status) return refused(status > 0 ? `The upload failed (${status}).` : "The upload didn't reach Slack.");
    const title = input.title!.trim();
    const done = await slack('files.completeUploadExternal', {
      files: [{ id: slot.file_id, title: (title && title !== '0' ? title : filename).slice(0, 250) }],
      channel_id: here,
      thread_ts: /^\d+\.\d+$/.test(threadTs) ? threadTs : '',
      initial_comment: input.comment!.trim() === '0' ? '' : input.comment!.trim(),
    });
    if (!done.ok) return refused(slackProblem(done));
    return { ok: true, result: `Sent ${filename} here.`, file_id: String(slot.file_id) };
  };
}

// ── Definitions ─────────────────────────────────────────────────────────────

/**
 * Slack's workspace tools, to run on your server. `slack()` offers them on its
 * own; the definitions the installer puts on the agent come from the same list
 * (`workspaceTools`).
 */
export function createWorkspaceTools(options: WorkspaceToolsOptions = {}): ServerTool[] {
  return [
    {
      name: 'slack_post_to_channel',
      version: 4,
      description:
        'Post a message in a Slack channel for the person, when they ask you to share or announce something there. Only in channels they are a member of and you have been added to; the post says who it was for. They are asked to approve it first, with buttons, so tell them it is waiting for their approval until the tool says it was posted.',
      inputs: { channel: 'The channel: #name or its ID.', text: 'The message, in Slack markdown.' },
      outputs: { channel_id: 'The channel posted in.', message_ts: "The post's timestamp.", link: 'A link to the post.' },
      requires: ['chat:write', 'channels:read', 'groups:read', 'channels:history', 'groups:history'],
      run: postToChannel,
    },
    {
      name: 'slack_message_person',
      version: 4,
      description:
        'Send someone in the workspace a direct message from you, for the person, when they ask you to tell or remind someone something. The message says who it was for. Only for full members of the workspace, not guests. They are asked to approve it first, with buttons, unless it is a note to themselves.',
      inputs: { person: 'Who: their @mention, user ID, email, or full name.', text: 'The message, in Slack markdown.' },
      outputs: { person_id: 'Their Slack user ID.' },
      requires: ['chat:write', 'im:write', 'im:history', 'users:read', 'users:read.email'],
      run: messagePerson,
    },
    {
      name: 'slack_read_channel',
      version: 4,
      description:
        "Read a Slack channel's recent messages, to summarize or answer questions about what was said. With no channel named it reads this conversation, or in the assistant panel the channel the person has open. Only channels they are a member of, and another channel only in a direct message, where no one else sees what it read.",
      inputs: {
        channel: 'The channel: #name or its ID. Empty for the one the person is in or looking at.',
        limit: 'How many recent messages, up to 100. Empty for 20.',
      },
      outputs: { channel_id: 'The channel read.', messages: 'The messages, oldest first, one per line.' },
      requires: ['channels:history', 'groups:history', 'channels:read', 'groups:read', 'users:read'],
      // It only reads, and only what the person could.
      approval: false,
      run: readChannel(options),
    },
    {
      name: 'slack_find_person',
      version: 3,
      description:
        'Look people up in the Slack workspace by name, title or email: who someone is and their @mention, and in a direct message their title and time zone too (never their email). Use it before messaging or mentioning someone you only know by name. Only for full members of the workspace, not guests.',
      inputs: { query: 'A name, part of a name, a title (designer), or an email.' },
      outputs: { people: 'Up to 10 matches, one per line.' },
      requires: ['users:read', 'users:read.email'],
      approval: false,
      run: findPerson,
    },
    {
      name: 'slack_schedule_message',
      version: 4,
      description:
        "Schedule a Slack message for later: a reminder in this thread, or a post in a channel at a set time. Pass a relative time as the person said it (in 10 minutes, in 2 hours): you don't need to know the current time. Dates without an offset are in the person's time zone. Only in channels they are a member of. A reminder in this thread needs nothing more; a post in a channel waits for their approval first.",
      inputs: {
        text: 'The message, in Slack markdown.',
        post_at: 'When: a relative time (in 10 minutes, in 2 hours, in 3 days), or a date and time, 2026-12-01T09:00 (their time zone) or with an offset.',
        channel: 'The channel: #name or its ID. Empty for this thread.',
      },
      outputs: { scheduled_message_id: "Slack's ID for the scheduled message." },
      requires: ['chat:write', 'channels:read', 'groups:read', 'users:read'],
      run: scheduleMessage,
    },
    {
      name: 'slack_pin_message',
      version: 3,
      description:
        "Pin a message so the channel keeps it at hand: by default this thread's first message, or a message the person links to. Only in channels they are a member of; for a message in another channel they are asked to approve it first.",
      inputs: { message: "The message's Slack link, or empty for this thread's first message." },
      requires: ['pins:write', 'channels:read', 'groups:read'],
      run: pinMessage,
    },
    {
      name: 'slack_add_bookmark',
      version: 4,
      description:
        "Add a link to a channel's bookmarks bar, by default this one's. Only in channels the person is a member of. They are asked to approve it first, except in a direct message.",
      inputs: {
        title: "The bookmark's title.",
        link: 'The URL, starting with https://.',
        emoji: 'An emoji name for it, or empty.',
        channel: 'The channel: #name or its ID. Empty for this one.',
      },
      requires: ['bookmarks:write', 'channels:read', 'groups:read'],
      run: addBookmark,
    },
    {
      name: 'slack_create_canvas',
      version: 3,
      description:
        'Write a Slack canvas: a document for anything longer than a message (a summary, plan, meeting notes, a how-to). The person can edit it and this conversation can read it; share its link in your reply.',
      inputs: { title: "The canvas's title.", content: 'The canvas, in markdown: headings, lists, tables and links.' },
      outputs: { canvas_id: "The canvas's ID, for other Slack calls. Give people the link, not this.", link: 'A link to the canvas, to share in your reply.' },
      requires: ['canvases:write'],
      run: createCanvas,
    },
    {
      name: 'slack_send_file',
      version: 2,
      description:
        'Send a text file in this conversation: a CSV export, a markdown or code file, a log. Use it for content people will download or open elsewhere, rather than pasting it.',
      inputs: {
        filename: 'The file name with its extension: report.csv, notes.md.',
        content: "The file's text.",
        title: 'A title for the file, or empty for its name.',
        comment: 'A message to go with it, or empty.',
      },
      outputs: { file_id: "Slack's ID for the file." },
      requires: ['files:write'],
      run: sendFile(options),
    },
  ];
}
