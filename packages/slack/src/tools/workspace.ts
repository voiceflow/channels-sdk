// Slack's workspace tools: Voiceflow functions that do things in Slack (post,
// message someone, read a channel, schedule, pin, bookmark, write a canvas,
// send a file) by calling Slack's Web API from Voiceflow with the app's bot
// token, kept as the `slack_bot_token` secret.
//
// The bot can reach more than the person it's talking to, so every tool acts
// only where that person could: it reads and writes only channels the person
// is a member of, shows what it reads only where everyone could read it, and
// leaves the directory to full members. Who the person is comes from the `slack_user_id` variable
// this package sets from Slack's verified event, wired so the model can't
// change it. Without it (a turn that didn't come through Slack) the tools refuse.
//
// Like the presentation tools, each function is sent to Voiceflow as its text,
// so it is self-contained and uses nothing Voiceflow's sandbox lacks.
import { functionSource, type ToolDefinition, type ToolInput } from '@voiceflow/channels-sdk';

// ── Helpers (each becomes part of the functions that use it) ────────────────

/**
 * One Slack Web API call. Arguments that are objects or arrays (blocks, a
 * canvas, files) go as JSON, which Slack's write methods take; the rest
 * form-encoded, which every method takes. Answers Slack's JSON, or `{ ok: false, error }`.
 */
export async function slackCall(token: string, method: string, params: Record<string, unknown>) {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '');
  const json = keys.some((k) => typeof params[k] === 'object');
  const body = json
    ? JSON.stringify(keys.reduce((o: Record<string, unknown>, k) => ((o[k] = params[k]), o), {}))
    : keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
  try {
    const res: any = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded; charset=utf-8', authorization: `Bearer ${token}` },
      body,
    });
    // Voiceflow's fetch carries `json` as a property; a standard one, as a method.
    let data = typeof res.json === 'function' ? await res.json() : res.json;
    if (data === undefined && typeof res.text === 'string') {
      try {
        data = JSON.parse(res.text);
      } catch (e) {
        data = undefined;
      }
    }
    if (!data || typeof data !== 'object') return { ok: false, error: `http_${res.status}` };
    return data;
  } catch (error: any) {
    return { ok: false, error: 'request_failed', detail: String((error && error.message) || error) };
  }
}

/** Slack's error, said so the agent can tell the person what to do. */
export function slackProblem(data: any): string {
  const error = (data && data.error) || 'unknown_error';
  const known: Record<string, string> = {
    not_in_channel: "I'm not in that channel. Add me to it first (type /invite @ and my name there).",
    channel_not_found: "I can't find that channel. It may be private and I'm not in it, or the name is wrong.",
    is_archived: 'That channel is archived.',
    user_not_found: "I can't find that person in this workspace.",
    users_not_found: "I can't find that person in this workspace.",
    cannot_dm_bot: "I can't message a bot.",
    restricted_action: "Slack's settings don't let me do that here.",
    invalid_auth: 'The Slack token is missing or wrong: check the slack_bot_token secret.',
    not_authed: 'The Slack token is missing: set the slack_bot_token secret.',
    token_revoked: 'The Slack token was revoked: reinstall the Slack app and update the slack_bot_token secret.',
    account_inactive: 'The Slack app was uninstalled: reinstall it and update the slack_bot_token secret.',
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

/** The person asking, as this package set it. A turn that didn't come through Slack has none. */
export function personOf(value: unknown): string {
  const id = String(value || '').trim();
  return /^[UW][A-Z0-9]+$/.test(id) ? id : '';
}

/**
 * A channel the model named (#name, <#C123|name>, C123) or, when it named none,
 * the fallback. A name is looked up among the channels the bot is in, the only
 * ones it can read or post in: one short list, where every channel in the
 * workspace would be many slow pages.
 */
export async function resolveChannel(token: string, input: unknown, fallback: unknown) {
  const value = String(input || '').trim();
  const here = String(fallback || '').trim();
  if (!value || value === '0') return /^[CGD][A-Z0-9]+$/.test(here) ? { id: here } : { error: 'Say which channel.' };
  const mention = value.match(/^<#([CG][A-Z0-9]+)(\|[^>]*)?>$/);
  if (mention) return { id: mention[1] };
  // Channel names are lower case, so an upper-case C, G or D followed by letters and digits is an ID.
  if (/^[CGD][A-Z0-9]+$/.test(value)) return { id: value };
  const name = value.replace(/^#/, '').trim().toLowerCase();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const data = await slackCall(token, 'users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor });
    if (!data.ok) return { error: slackProblem(data) };
    const found = (data.channels || []).find((c: any) => c.name === name);
    if (found) return { id: found.id, name: found.name };
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  // The same answer as for a channel the person isn't in, so it doesn't say which channels exist.
  return { error: "I can only act in a channel you and I are both in. If you're in that one, add me to it first: type /invite @ and my name there." };
}

/**
 * Whether the person may act in a channel: they are a member. The conversation
 * they're talking in is theirs by definition. A channel the person isn't in
 * gets the answer a channel the bot isn't in gets, so it says nothing about it.
 */
export async function mayUse(token: string, channel: string, user: string, here: unknown) {
  if (channel === String(here || '')) return { ok: true };
  const notShared = "I can only act in a channel you and I are both in. If you're in that one, add me to it first: type /invite @ and my name there.";
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const data = await slackCall(token, 'conversations.members', { channel, limit: 1000, cursor });
    if (!data.ok) return { ok: false, problem: data.error === 'channel_not_found' ? notShared : slackProblem(data) };
    if ((data.members || []).indexOf(user) !== -1) return { ok: true };
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  return { ok: false, problem: notShared };
}

/**
 * Whether the person is a full member of this workspace, or of its Enterprise
 * Grid organization. Slack shows a guest, or someone from another organization
 * in a shared channel, far less of the workspace than the bot can see, so the
 * directory tools are for full members only.
 */
export async function fullMember(token: string, user: string) {
  const [asker, bot] = await Promise.all([slackCall(token, 'users.info', { user }), slackCall(token, 'auth.test', {})]);
  if (!asker.ok) return { ok: false, problem: slackProblem(asker) };
  if (!bot.ok) return { ok: false, problem: slackProblem(bot) };
  const u = asker.user || {};
  const org = bot.enterprise_id && u.enterprise_user && u.enterprise_user.enterprise_id === bot.enterprise_id;
  if (u.is_restricted || u.is_ultra_restricted || (u.team_id !== bot.team_id && !org)) {
    return { ok: false, problem: 'Only full members of this workspace can look people up or message them through me.' };
  }
  return { ok: true };
}

/** A person the model named (<@U123>, U123, an email, or a name) as their Slack user. */
export async function resolvePerson(token: string, input: unknown) {
  const value = String(input || '').trim();
  if (!value) return { error: 'Say who.' };
  const mention = value.match(/^<@([UW][A-Z0-9]+)(\|[^>]*)?>$/);
  const id = mention ? mention[1] : /^[UW][A-Z0-9]{6,}$/.test(value) ? value : '';
  if (id) {
    const data = await slackCall(token, 'users.info', { user: id });
    return data.ok ? { user: data.user } : { error: slackProblem(data) };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    const data = await slackCall(token, 'users.lookupByEmail', { email: value });
    return data.ok ? { user: data.user } : { error: data.error === 'users_not_found' ? `No one in this workspace has the email ${value}.` : slackProblem(data) };
  }
  const name = value.replace(/^@/, '').trim().toLowerCase();
  const exact: any[] = [];
  const partial: any[] = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const data = await slackCall(token, 'users.list', { limit: 1000, cursor });
    if (!data.ok) return { error: slackProblem(data) };
    for (const u of data.members || []) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      const names = [u.name, u.real_name, u.profile && u.profile.display_name, u.profile && u.profile.real_name].filter(Boolean).map((n: string) => n.toLowerCase());
      if (names.indexOf(name) !== -1) exact.push(u);
      else if (names.some((n: string) => n.indexOf(name) !== -1)) partial.push(u);
    }
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  const found = exact.length ? exact : partial;
  if (found.length === 1) return { user: found[0] };
  if (!found.length) return { error: `I can't find anyone called ${value}.` };
  const names = found.slice(0, 5).map((u: any) => `${u.real_name || u.name} (<@${u.id}>)`).join(', ');
  return { error: `More than one person matches ${value}: ${names}. Ask which one.` };
}

/** A message's blocks: its text in sections Slack accepts, then who it was sent for. */
export function messageBlocks(text: string, note: string) {
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
export async function alreadySent(token: string, channel: string, text: string, note: string) {
  const plain = (s: unknown) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const history = await slackCall(token, 'conversations.history', { channel, oldest: String(Math.floor(Date.now() / 1000) - 120), limit: 20 });
  if (!history.ok) return '';
  const same = (history.messages || []).find((m: any) => {
    if (!m.bot_id || plain(m.text) !== plain(text)) return false;
    if (!note) return true;
    return (m.blocks || []).some((b: any) => b.type === 'context' && (b.elements || []).some((e: any) => e.text === note));
  });
  return same ? String(same.ts) : '';
}

/** A failed result the agent can relay. */
export function refused(result: string) {
  return { outputVars: { ok: false, result }, next: { path: 'error' } };
}

/** The bytes of a string in UTF-8, without Buffer or TextEncoder. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
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
    const count = /^\d/.test(rel[1]) ? Number(rel[1]) : 1;
    const unit = rel[2][0] === 'm' ? 60 : rel[2][0] === 'h' ? 3600 : rel[2][0] === 'd' ? 86400 : 604800;
    return Math.round(Date.now() / 1000 + count * unit);
  }
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return NaN;
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
    const parts: any = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(asUtc))) {
      parts[p.type] = p.value;
    }
    const there = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return (asUtc - (there - asUtc)) / 1000;
  } catch (e) {
    return asUtc / 1000;
  }
}

// ── The tools ───────────────────────────────────────────────────────────────

export async function slackPostToChannel(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  const text = String(input.text || '').trim();
  if (!user) return refused("I can't tell who's asking, so I won't post in Slack for them.");
  if (!text) return refused('The message is empty.');
  const channel: any = await resolveChannel(token, input.channel, '');
  if (channel.error) return refused(channel.error);
  const allowed: any = await mayUse(token, channel.id, user, input.current_channel);
  if (!allowed.ok) return refused(allowed.problem);
  const note = `Posted for <@${user}>`;
  const earlier = await alreadySent(token, channel.id, text, note);
  let ts = earlier;
  if (!ts) {
    const sent = await slackCall(token, 'chat.postMessage', { channel: channel.id, text, blocks: messageBlocks(text, note), unfurl_links: false });
    if (!sent.ok) return refused(slackProblem(sent));
    ts = String(sent.ts);
  }
  const link = await slackCall(token, 'chat.getPermalink', { channel: channel.id, message_ts: ts });
  const url = link.ok ? String(link.permalink) : '';
  return {
    outputVars: {
      ok: true,
      result: `${earlier ? 'Already posted' : 'Posted'} in <#${channel.id}>${url ? `: ${url}` : '.'}${earlier ? " (it went up a moment ago, so I didn't post it twice)" : ''}`,
      channel_id: channel.id,
      message_ts: ts,
      link: url,
    },
    next: { path: 'success' },
  };
}

export async function slackMessagePerson(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  const text = String(input.text || '').trim();
  if (!user) return refused("I can't tell who's asking, so I won't message anyone for them.");
  if (!text) return refused('The message is empty.');
  const member: any = await fullMember(token, user);
  if (!member.ok) return refused(member.problem);
  const found: any = await resolvePerson(token, input.person);
  if (found.error) return refused(found.error);
  if (found.user.is_bot || found.user.deleted) return refused("That account can't receive messages.");
  const opened = await slackCall(token, 'conversations.open', { users: found.user.id });
  if (!opened.ok) return refused(slackProblem(opened));
  const note = found.user.id === user ? '' : `Sent for <@${user}>`;
  const earlier = await alreadySent(token, opened.channel.id, text, note);
  if (!earlier) {
    const sent = await slackCall(token, 'chat.postMessage', { channel: opened.channel.id, text, blocks: messageBlocks(text, note), unfurl_links: false });
    if (!sent.ok) return refused(slackProblem(sent));
  }
  const who = `${found.user.real_name || found.user.name} (<@${found.user.id}>)`;
  return {
    outputVars: { ok: true, result: earlier ? `Already sent to ${who} a moment ago, so I didn't send it twice.` : `Sent to ${who}.`, person_id: String(found.user.id) },
    next: { path: 'success' },
  };
}

export async function slackReadChannel(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  if (!user) return refused("I can't tell who's asking, so I won't read Slack for them.");
  // Asked in the assistant panel with no channel named: the one they have open beside it.
  const viewing = String(input.viewing_channel || '').trim();
  const channel: any = await resolveChannel(token, input.channel, /^[CG]/.test(viewing) ? viewing : input.current_channel);
  if (channel.error) return refused(channel.error);
  // Everyone in this conversation sees what's read, so another channel is read only in a direct message (the assistant panel is one).
  const here = String(input.current_channel || '');
  if (channel.id !== here && !here.startsWith('D')) {
    return refused('Everyone here would see what I read, so in a channel I read only that channel. Ask me in a direct message to read another one.');
  }
  const allowed: any = await mayUse(token, channel.id, user, input.current_channel);
  if (!allowed.ok) return refused(allowed.problem);
  const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 20)));
  const history = await slackCall(token, 'conversations.history', { channel: channel.id, limit });
  if (!history.ok) return refused(slackProblem(history));
  const messages = (history.messages || []).filter((m: any) => !m.subtype || m.subtype === 'thread_broadcast' || m.subtype === 'bot_message').reverse();
  const names: Record<string, string> = {};
  for (const m of messages) {
    if (!m.user || names[m.user] !== undefined || Object.keys(names).length >= 25) continue;
    const info = await slackCall(token, 'users.info', { user: m.user });
    names[m.user] = info.ok ? info.user.real_name || info.user.name : m.user;
  }
  const lines = messages.map((m: any) => {
    const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const who = m.user ? names[m.user] || m.user : m.username || (m.bot_profile && m.bot_profile.name) || 'a bot';
    const replies = m.reply_count ? ` [${m.reply_count} replies]` : '';
    return `${when} UTC ${who}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 1000)}${replies}`;
  });
  return {
    outputVars: {
      ok: true,
      result: lines.length ? `The last ${lines.length} messages in <#${channel.id}>, oldest first.` : `<#${channel.id}> has no messages.`,
      channel_id: channel.id,
      messages: lines.join('\n').slice(0, 30000),
    },
    next: { path: 'success' },
  };
}

export async function slackFindPerson(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  if (!user) return refused("I can't tell who's asking, so I won't search Slack for them.");
  const query = String(input.query || '').trim().toLowerCase();
  if (!query) return refused('Say who to look for.');
  const member: any = await fullMember(token, user);
  if (!member.ok) return refused(member.problem);
  const matches: any[] = [];
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) {
    const data = await slackCall(token, 'users.lookupByEmail', { email: query });
    if (data.ok) matches.push(data.user);
    else if (data.error !== 'users_not_found') return refused(slackProblem(data));
  } else {
    let cursor = '';
    for (let page = 0; page < 20 && matches.length < 10; page++) {
      const data = await slackCall(token, 'users.list', { limit: 1000, cursor });
      if (!data.ok) return refused(slackProblem(data));
      for (const u of data.members || []) {
        if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
        const p = u.profile || {};
        const text = [u.name, u.real_name, p.display_name, p.title].filter(Boolean).join(' ').toLowerCase();
        if (text.indexOf(query) !== -1 && matches.length < 10) matches.push(u);
      }
      cursor = (data.response_metadata && data.response_metadata.next_cursor) || '';
      if (!cursor) break;
    }
  }
  const people = matches.map((u: any) => {
    const p = u.profile || {};
    const parts = [`${u.real_name || u.name} (<@${u.id}>)`];
    if (p.title) parts.push(p.title);
    // No email: a workspace can hide its members' emails from each other, and the bot sees them all.
    if (u.tz) parts.push(`time zone ${u.tz}`);
    return parts.join(', ');
  });
  return {
    outputVars: { ok: true, result: people.length ? `Found ${people.length}.` : `No one matches ${query}.`, people: people.join('\n') },
    next: { path: 'success' },
  };
}

export async function slackScheduleMessage(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  const text = String(input.text || '').trim();
  if (!user) return refused("I can't tell who's asking, so I won't schedule anything for them.");
  if (!text) return refused('The message is empty.');
  const when = unixTime(input.post_at, input.user_timezone);
  if (!isFinite(when)) return refused('Give the time as a relative time, like in 10 minutes, or as a date and time, like 2026-12-01T09:00.');
  const named = String(input.channel || '').trim();
  const channel: any = await resolveChannel(token, named, input.current_channel);
  if (channel.error) return refused(channel.error);
  const allowed: any = await mayUse(token, channel.id, user, input.current_channel);
  if (!allowed.ok) return refused(allowed.problem);
  // With no channel named, it goes in this conversation's thread.
  const thread = !named && channel.id === String(input.current_channel || '') ? String(input.current_thread || '') : '';
  const scheduled = await slackCall(token, 'chat.scheduleMessage', {
    channel: channel.id,
    post_at: Math.round(when),
    text,
    blocks: messageBlocks(text, `Scheduled by <@${user}>`),
    thread_ts: /^\d+\.\d+$/.test(thread) ? thread : '',
  });
  if (!scheduled.ok) return refused(slackProblem(scheduled));
  return {
    outputVars: { ok: true, result: `Scheduled in <#${channel.id}> for <!date^${Math.round(when)}^{date_short_pretty} at {time}|${new Date(when * 1000).toISOString()}>.`, scheduled_message_id: String(scheduled.scheduled_message_id) },
    next: { path: 'success' },
  };
}

/** A message the model pointed at: a Slack link to it, its timestamp in this conversation, or the conversation's first message. */
export function messageOf(value: unknown, here: unknown, thread: unknown) {
  const text = String(value || '').trim();
  const link = text.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (link) return { channel: link[1], ts: `${link[2]}.${link[3]}` };
  if (/^\d{10}\.\d{6}$/.test(text)) return { channel: String(here || ''), ts: text };
  return { channel: String(here || ''), ts: String(thread || '') };
}

export async function slackPinMessage(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  if (!user) return refused("I can't tell who's asking, so I won't pin anything for them.");
  const target = messageOf(input.message, input.current_channel, input.current_thread);
  if (!/^[CGD][A-Z0-9]+$/.test(target.channel) || !/^\d+\.\d+$/.test(target.ts)) return refused('Say which message: paste its link.');
  const allowed: any = await mayUse(token, target.channel, user, input.current_channel);
  if (!allowed.ok) return refused(allowed.problem);
  const pinned = await slackCall(token, 'pins.add', { channel: target.channel, timestamp: target.ts });
  if (!pinned.ok) return refused(slackProblem(pinned));
  return { outputVars: { ok: true, result: `Pinned in <#${target.channel}>.` }, next: { path: 'success' } };
}

export async function slackAddBookmark(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  const title = String(input.title || '').trim();
  const link = String(input.link || '').trim();
  if (!user) return refused("I can't tell who's asking, so I won't add a bookmark for them.");
  if (!title || !/^https?:\/\/\S+$/.test(link)) return refused('A bookmark needs a title and a link starting with https://.');
  const channel: any = await resolveChannel(token, input.channel, input.current_channel);
  if (channel.error) return refused(channel.error);
  const allowed: any = await mayUse(token, channel.id, user, input.current_channel);
  if (!allowed.ok) return refused(allowed.problem);
  const emoji = String(input.emoji || '').trim().replace(/^:+|:+$/g, '');
  const added = await slackCall(token, 'bookmarks.add', { channel_id: channel.id, title: title.slice(0, 150), type: 'link', link, emoji: emoji ? `:${emoji}:` : '' });
  if (!added.ok) return refused(slackProblem(added));
  return { outputVars: { ok: true, result: `Bookmarked ${title} in <#${channel.id}>.` }, next: { path: 'success' } };
}

export async function slackCreateCanvas(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  const title = String(input.title || '').trim();
  const content = String(input.content || '').trim();
  if (!user) return refused("I can't tell who's asking, so I won't write a canvas for them.");
  if (!title || !content) return refused('A canvas needs a title and content.');
  const created = await slackCall(token, 'canvases.create', { title: title.slice(0, 255), document_content: { type: 'markdown', markdown: content } });
  if (!created.ok) return refused(slackProblem(created));
  const id = String(created.canvas_id);
  const here = String(input.current_channel || '');
  // The person can edit it; the conversation it was asked in can read it (a DM can't be shared to).
  const forPerson = await slackCall(token, 'canvases.access.set', { canvas_id: id, access_level: 'write', user_ids: [user] });
  const shared = /^[CG]/.test(here) ? await slackCall(token, 'canvases.access.set', { canvas_id: id, access_level: 'read', channel_ids: [here] }) : { ok: true };
  const team = await slackCall(token, 'auth.test', {});
  const link = team.ok && team.url && team.team_id ? `${String(team.url).replace(/\/$/, '')}/docs/${team.team_id}/${id}` : '';
  const notes = [!forPerson.ok ? `I couldn't give you edit access (${slackProblem(forPerson)})` : '', !shared.ok ? `I couldn't share it here (${slackProblem(shared)})` : ''].filter(Boolean);
  return {
    outputVars: { ok: true, result: `Created the canvas ${title}${link ? `: ${link}` : '.'}${notes.length ? ` ${notes.join('. ')}.` : ''}`, canvas_id: id, link },
    next: { path: 'success' },
  };
}

export async function slackSendFile(args: any) {
  const input = args.inputVars || {};
  const token = String(input.token || '');
  const user = personOf(input.user_id);
  const filename = String(input.filename || '').trim().replace(/[\\/:*?"<>|]+/g, '-');
  const content = String(input.content || '');
  const channel = String(input.current_channel || '');
  if (!user) return refused("I can't tell who's asking, so I won't send a file for them.");
  if (!filename || !content) return refused('A file needs a name and content.');
  if (!/^[CGD][A-Z0-9]+$/.test(channel)) return refused('Files can only be sent in a Slack conversation.');
  const length = utf8Length(content);
  if (length > 900000) return refused('That file is too big to send from here (about 900 KB at most).');
  const slot = await slackCall(token, 'files.getUploadURLExternal', { filename, length });
  if (!slot.ok) return refused(slackProblem(slot));
  const uploaded: any = await fetch(slot.upload_url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: content });
  if (!uploaded.ok) return refused(`The upload failed (${uploaded.status}).`);
  const thread = String(input.current_thread || '');
  const done = await slackCall(token, 'files.completeUploadExternal', {
    files: [{ id: slot.file_id, title: String(input.title || filename).slice(0, 250) }],
    channel_id: channel,
    thread_ts: /^\d+\.\d+$/.test(thread) ? thread : '',
    initial_comment: String(input.comment || '').trim(),
  });
  if (!done.ok) return refused(slackProblem(done));
  return { outputVars: { ok: true, result: `Sent ${filename} here.`, file_id: String(slot.file_id) }, next: { path: 'success' } };
}

// ── Definitions ─────────────────────────────────────────────────────────────

const TOKEN: ToolInput = { description: "The Slack app's bot token, from the slack_bot_token secret.", from: 'slack_bot_token' };
const USER: ToolInput = { description: 'The Slack user asking, from the slack_user_id variable. The tool acts only where they could.', from: 'slack_user_id' };
const HERE: ToolInput = { description: 'The conversation this is happening in, from the slack_channel_id variable.', from: 'slack_channel_id' };
const THREAD: ToolInput = { description: 'The thread this is happening in, from the slack_thread_ts variable.', from: 'slack_thread_ts' };
const RESULT = { ok: 'Whether it worked.', result: 'What happened, to tell the person.' };

const BASE = [slackCall, slackProblem, personOf, refused];
const CHANNELS = [resolveChannel, mayUse];

export const workspaceTools: ToolDefinition[] = [
  {
    name: 'slack_post_to_channel',
    kind: 'workspace',
    version: 3,
    description:
      'Post a message in a Slack channel for the person, when they ask you to share or announce something there. Only in channels they are a member of and you have been added to; the post says who it was for.',
    get code() {
      return functionSource(slackPostToChannel, [...BASE, ...CHANNELS, messageBlocks, alreadySent]);
    },
    inputs: {
      channel: { description: 'The channel: #name or its ID.' },
      text: { description: 'The message, in Slack markdown.' },
      token: TOKEN,
      user_id: USER,
      current_channel: HERE,
    },
    outputs: { ...RESULT, channel_id: 'The channel posted in.', message_ts: "The post's timestamp.", link: 'A link to the post.' },
    requires: ['chat:write', 'channels:read', 'groups:read', 'channels:history', 'groups:history'],
  },
  {
    name: 'slack_message_person',
    kind: 'workspace',
    version: 3,
    description:
      'Send someone in the workspace a direct message from you, for the person, when they ask you to tell or remind someone something. The message says who it was for. Only for full members of the workspace, not guests.',
    get code() {
      return functionSource(slackMessagePerson, [...BASE, fullMember, resolvePerson, messageBlocks, alreadySent]);
    },
    inputs: {
      person: { description: 'Who: their @mention, user ID, email, or full name.' },
      text: { description: 'The message, in Slack markdown.' },
      token: TOKEN,
      user_id: USER,
    },
    outputs: { ...RESULT, person_id: 'Their Slack user ID.' },
    requires: ['chat:write', 'im:write', 'im:history', 'users:read', 'users:read.email'],
  },
  {
    name: 'slack_read_channel',
    kind: 'workspace',
    version: 3,
    description:
      "Read a Slack channel's recent messages, to summarize or answer questions about what was said. With no channel named it reads this conversation, or in the assistant panel the channel the person has open. Only channels they are a member of, and another channel only in a direct message, where no one else sees what it read.",
    get code() {
      return functionSource(slackReadChannel, [...BASE, ...CHANNELS]);
    },
    inputs: {
      channel: { description: 'The channel: #name or its ID. Empty for the one the person is in or looking at.' },
      limit: { description: 'How many recent messages, up to 100. Empty for 20.' },
      token: TOKEN,
      user_id: USER,
      current_channel: HERE,
      viewing_channel: { description: 'In the assistant panel, the channel the person has open, from slack_viewing_channel_id.', from: 'slack_viewing_channel_id' },
    },
    outputs: { ...RESULT, channel_id: 'The channel read.', messages: 'The messages, oldest first, one per line.' },
    requires: ['channels:history', 'groups:history', 'channels:read', 'groups:read', 'users:read'],
  },
  {
    name: 'slack_find_person',
    kind: 'workspace',
    version: 2,
    description:
      'Look people up in the Slack workspace by name, title or email: who someone is, their title, time zone and @mention (never their email). Use it before messaging or mentioning someone you only know by name. Only for full members of the workspace, not guests.',
    get code() {
      return functionSource(slackFindPerson, [...BASE, fullMember]);
    },
    inputs: {
      query: { description: 'A name, part of a name, a title (designer), or an email.' },
      token: TOKEN,
      user_id: USER,
    },
    outputs: { ...RESULT, people: 'Up to 10 matches, one per line.' },
    requires: ['users:read', 'users:read.email'],
  },
  {
    name: 'slack_schedule_message',
    kind: 'workspace',
    version: 3,
    description:
      "Schedule a Slack message for later: a reminder in this thread, or a post in a channel at a set time. Pass a relative time as the person said it (in 10 minutes, in 2 hours): you don't need to know the current time. Dates without an offset are in the person's time zone. Only in channels they are a member of.",
    get code() {
      return functionSource(slackScheduleMessage, [...BASE, ...CHANNELS, messageBlocks, unixTime]);
    },
    inputs: {
      text: { description: 'The message, in Slack markdown.' },
      post_at: { description: 'When: a relative time (in 10 minutes, in 2 hours, in 3 days), or a date and time, 2026-12-01T09:00 (their time zone) or with an offset.' },
      channel: { description: 'The channel: #name or its ID. Empty for this thread.' },
      token: TOKEN,
      user_id: USER,
      current_channel: HERE,
      current_thread: THREAD,
      user_timezone: { description: "The person's time zone, from slack_user_timezone.", from: 'slack_user_timezone' },
    },
    outputs: { ...RESULT, scheduled_message_id: "Slack's ID for the scheduled message." },
    requires: ['chat:write', 'channels:read', 'groups:read'],
  },
  {
    name: 'slack_pin_message',
    kind: 'workspace',
    version: 2,
    description:
      "Pin a message so the channel keeps it at hand: by default this thread's first message, or a message the person links to. Only in channels they are a member of.",
    get code() {
      return functionSource(slackPinMessage, [...BASE, mayUse, messageOf]);
    },
    inputs: {
      message: { description: "The message's Slack link, or empty for this thread's first message." },
      token: TOKEN,
      user_id: USER,
      current_channel: HERE,
      current_thread: THREAD,
    },
    outputs: RESULT,
    requires: ['pins:write', 'channels:read', 'groups:read'],
  },
  {
    name: 'slack_add_bookmark',
    kind: 'workspace',
    version: 3,
    description: "Add a link to a channel's bookmarks bar, by default this one's. Only in channels the person is a member of.",
    get code() {
      return functionSource(slackAddBookmark, [...BASE, ...CHANNELS]);
    },
    inputs: {
      title: { description: "The bookmark's title." },
      link: { description: 'The URL, starting with https://.' },
      emoji: { description: 'An emoji name for it, or empty.' },
      channel: { description: 'The channel: #name or its ID. Empty for this one.' },
      token: TOKEN,
      user_id: USER,
      current_channel: HERE,
    },
    outputs: RESULT,
    requires: ['bookmarks:write', 'channels:read', 'groups:read'],
  },
  {
    name: 'slack_create_canvas',
    kind: 'workspace',
    version: 2,
    description:
      'Write a Slack canvas: a document for anything longer than a message (a summary, plan, meeting notes, a how-to). The person can edit it and this conversation can read it; share its link in your reply.',
    get code() {
      return functionSource(slackCreateCanvas, [...BASE]);
    },
    inputs: {
      title: { description: "The canvas's title." },
      content: { description: 'The canvas, in markdown: headings, lists, tables and links.' },
      token: TOKEN,
      user_id: USER,
      current_channel: HERE,
    },
    outputs: { ...RESULT, canvas_id: "The canvas's ID, for other Slack calls. Give people the link, not this.", link: 'A link to the canvas, to share in your reply.' },
    requires: ['canvases:write'],
  },
  {
    name: 'slack_send_file',
    kind: 'workspace',
    version: 1,
    description:
      'Send a text file in this conversation: a CSV export, a markdown or code file, a log. Use it for content people will download or open elsewhere, rather than pasting it.',
    get code() {
      return functionSource(slackSendFile, [...BASE, utf8Length]);
    },
    inputs: {
      filename: { description: 'The file name with its extension: report.csv, notes.md.' },
      content: { description: "The file's text." },
      title: { description: 'A title for the file, or empty for its name.' },
      comment: { description: 'A message to go with it, or empty.' },
      token: TOKEN,
      user_id: USER,
      current_channel: HERE,
      current_thread: THREAD,
    },
    outputs: { ...RESULT, file_id: "Slack's ID for the file." },
    requires: ['files:write'],
  },
];
