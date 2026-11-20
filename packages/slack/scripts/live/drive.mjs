// Runs the live Slack test as you, through the harness's driver (slack.mjs
// --drive): it posts in your DM with the bot and in #vf-sdk-test, waits for each
// turn, and checks what the bot did with Slack's API and the harness's events.
// Every result carries its evidence. What only a person can do in Slack (the
// assistant panel, the Home tab, a slash command, a form's dialog, seeing a
// private reply) is listed at the end, not faked.
//
//   node packages/slack/scripts/live/drive.mjs [--only name,name] [--out .run/drive-results.json]
import fs from 'node:fs';
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { only: { type: 'string' }, out: { type: 'string', default: '.run/drive-results.json' }, socket: { type: 'string', default: '.run/drive.sock' } },
});
const only = args.only ? new Set(args.only.split(',')) : null;
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function driver(path, body = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: args.socket, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        const json = JSON.parse(text || '{}');
        res.statusCode === 200 ? resolve(json) : reject(new Error(`${path}: ${json.error ?? res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const call = (as, method, params) => driver('/call', { as, method, params });
const info = await driver('/info');
const BOT = `<@${info.botUserId}>`;
const ME = `<@${info.userId}>`;
log(`driving as ${info.userId}; bot ${info.botUserId}; DM ${info.dm}; #${info.channelName} ${info.channel}`);

let cursor = (await driver('/events')).next;

/**
 * Posts as you and, unless told not to, waits for the bot's turn to finish.
 * While it waits it watches your message's reactions, to see the working one come and go.
 */
async function send(channel, text, { thread, turn = true, timeout = 150_000 } = {}) {
  const since = cursor;
  const posted = await call('user', 'chat.postMessage', { channel, text, ...(thread ? { thread_ts: thread } : {}) });
  const ts = posted.ts;
  const seen = new Set();
  const started = Date.now();
  let done = [];
  for (;;) {
    const { events, next } = await driver('/events', { since });
    done = events;
    const finished = events.some((e) => e.kind === 'turn' || (e.kind === 'error' && e.code !== 'background'));
    const r = await call('user', 'reactions.get', { channel, timestamp: ts }).catch(() => null);
    for (const x of r?.message?.reactions ?? []) if (x.users?.includes(info.botUserId)) seen.add(x.name);
    if (!turn && Date.now() - started > 8000) {
      cursor = next;
      break;
    }
    if (turn && finished) {
      await pause(2500); // the working reaction comes off after the turn is reported
      cursor = (await driver('/events', { since })).next;
      done = (await driver('/events', { since })).events;
      break;
    }
    if (Date.now() - started > timeout) throw new Error(`no turn within ${timeout / 1000}s`);
    await pause(700);
  }
  const after = (await call('user', 'reactions.get', { channel, timestamp: ts }).catch(() => null))?.message?.reactions ?? [];
  const root = thread ?? (channel === info.dm ? null : ts);
  const replies = await botMessages(channel, ts, root);
  return {
    ts,
    root,
    seconds: Math.round((Date.now() - started) / 1000),
    replies,
    text: replies.map((m) => m.text ?? '').join('\n'),
    events: done,
    traces: done.filter((e) => e.kind === 'traces').flatMap((e) => e.types),
    errors: done.filter((e) => e.kind === 'error'),
    reactionsSeen: [...seen],
    reactionsAfter: after.filter((x) => x.users?.includes(info.botUserId)).map((x) => x.name),
  };
}

async function botMessages(channel, after, root) {
  const all = root
    ? (await call('user', 'conversations.replies', { channel, ts: root, limit: 100 })).messages
    : (await call('user', 'conversations.history', { channel, oldest: after, limit: 100 })).messages;
  return all.filter((m) => m.user === info.botUserId && Number(m.ts) > Number(after)).sort((a, b) => Number(a.ts) - Number(b.ts));
}

// A function tool's call leaves no trace in the turn's stream (only custom
// traces do), so each workspace check passes on what the tool alone could have
// produced: data the agent can't otherwise know, or the change in Slack.
const declined = (text) => /don't have|do not have|can't|cannot|unable|not able|isn't something/i.test(text);
const blockTypes = (messages) => messages.flatMap((m) => (m.blocks ?? []).map((b) => b.type));
const short = (text, n = 160) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, n);

const results = [];
const state = {};
async function check(name, run) {
  if (only && !only.has(name)) return;
  log(`▶ ${name}`);
  try {
    const { pass, evidence } = await run();
    results.push({ name, result: pass ? 'pass' : 'fail', evidence });
    log(`${pass ? '✓' : '✗'} ${name}: ${evidence}`);
  } catch (error) {
    results.push({ name, result: 'fail', evidence: `error: ${error.message}` });
    log(`✗ ${name}: error: ${error.message}`);
  }
  fs.writeFileSync(args.out, JSON.stringify({ info: { ...info }, results }, null, 2));
}
/** Trace types without the noise: debug dropped, repeats counted (completion:content×24). */
const traceList = (types) => {
  const runs = [];
  for (const x of types) {
    if (x === 'debug') continue;
    if (runs.at(-1)?.[0] === x) runs.at(-1)[1]++;
    else runs.push([x, 1]);
  }
  return runs.map(([x, n]) => (n > 1 ? `${x}×${n}` : x)).join(' ');
};
const summary = (t) =>
  `replies ${t.replies.length}; traces [${traceList(t.traces)}]${t.errors.length ? `; errors ${t.errors.map((e) => `${e.code} ${short(e.message, 80)}`).join(' | ')}` : ''}; said "${short(t.text)}"`;

// ── The bot's own behaviours ────────────────────────────────────────────────

await check('dm-reply', async () => {
  const t = await send(info.dm, 'Hi! In one short sentence, what can you help with?');
  state.dm = t;
  return { pass: t.replies.length > 0 && !t.errors.length, evidence: summary(t) };
});

await check('working-reaction', async () => {
  const t = state.dm ?? (await send(info.dm, 'Hello again, one short sentence please.'));
  return {
    pass: t.reactionsSeen.includes('eyes') && !t.reactionsAfter.includes('eyes'),
    evidence: `bot's reactions on your message while it worked [${t.reactionsSeen.join(' ')}], after [${t.reactionsAfter.join(' ')}]`,
  };
});

await check('mention-thread', async () => {
  const t = await send(info.channel, `${BOT} In one sentence, who are you?`);
  state.mention = t;
  const inThread = t.replies.every((m) => m.thread_ts === t.ts);
  return {
    pass: t.replies.length > 0 && inThread && !t.errors.length,
    evidence: `${inThread ? 'answered in your thread' : 'NOT in your thread'}; ${summary(t)}`,
  };
});

await check('thread-follow-up', async () => {
  const root = state.mention?.ts ?? (await send(info.channel, `${BOT} Hi, one sentence please.`)).ts;
  const t = await send(info.channel, 'And what is 12 times 12? Answer with just the number.', { thread: root });
  return { pass: /144/.test(t.text), evidence: `no mention needed; ${summary(t)}` };
});

await check('catch-up', async () => {
  const seed = await send(info.channel, 'Planning note: the launch date is March 3.', { turn: false });
  const seed2 = await send(info.channel, 'And the launch budget is $40,000.', { thread: seed.ts, turn: false });
  const quiet = [...seed.events, ...seed2.events].filter((e) => e.kind === 'turn').length === 0;
  const t = await send(info.channel, `${BOT} Per this thread, what's the launch date and the budget?`, { thread: seed.ts });
  state.planning = seed.ts;
  return {
    pass: quiet && /march\s*3|3\s*march/i.test(t.text) && /40[,.]?000|40k/i.test(t.text),
    evidence: `${quiet ? 'stayed quiet until mentioned' : 'ANSWERED UNMENTIONED MESSAGES'}; ${summary(t)}`,
  };
});

await check('feedback-reaction', async () => {
  const target = state.mention?.replies.at(-1) ?? state.dm?.replies.at(-1);
  if (!target) return { pass: false, evidence: 'no bot message to react to' };
  const channel = state.mention?.replies.length ? info.channel : info.dm;
  const since = cursor;
  await call('user', 'reactions.add', { channel, timestamp: target.ts, name: '+1' });
  for (let i = 0; i < 20; i++) {
    const { events, next } = await driver('/events', { since });
    const f = events.find((e) => e.kind === 'feedback');
    if (f) {
      cursor = next;
      return {
        pass: f.positive === true && f.messageId === target.ts,
        evidence: `onFeedback got ${f.positive ? '👍' : '👎'} (${f.value}) via ${f.via} on ${f.messageId}`,
      };
    }
    await pause(750);
  }
  return { pass: false, evidence: 'no feedback event within 15s' };
});

// ── Presentation tools ──────────────────────────────────────────────────────

await check('slack_react', async () => {
  const t = await send(info.channel, `${BOT} Use your reaction tool to react to this message with :tada:, then reply with the word done.`);
  const kept = t.reactionsAfter.filter((r) => r !== 'eyes');
  return {
    pass: t.traces.includes('slack_react') && kept.length > 0,
    evidence: `bot's reactions after the turn [${t.reactionsAfter.join(' ')}]; ${summary(t)}`,
  };
});

await check('slack_show_table', async () => {
  const t = await send(info.channel, `${BOT} Use your table tool to show a table of 3 fruits with the columns Fruit and Color.`);
  const types = blockTypes(t.replies);
  return { pass: t.traces.includes('slack_show_table') && types.some((x) => /table/.test(x)), evidence: `block types [${types.join(' ')}]; ${summary(t)}` };
});

await check('slack_show_chart', async () => {
  const t = await send(info.channel, `${BOT} Use your chart tool to show a bar chart titled Sales with Q1 10, Q2 15 and Q3 12.`);
  const types = blockTypes(t.replies);
  return {
    pass: t.traces.includes('slack_show_chart') && types.some((x) => /visual|chart/.test(x)),
    evidence: `block types [${types.join(' ')}]; ${summary(t)}`,
  };
});

// The message is given, so the check tests the tool alone: the agent sees a slack_* value (your time zone, say)
// only where its instructions reference it, and an agent asked for one it can't see rightly declines.
await check('slack_reply_privately', async () => {
  const t = await send(info.channel, `${BOT} Use your private reply tool to send me "just for you", so only I can see it.`);
  return {
    pass: t.traces.includes('slack_reply_privately') && !t.errors.length,
    evidence: `sent without error (a script can't read an ephemeral message: look for it in the thread); ${summary(t)}`,
  };
});

await check('slack_ask_form', async () => {
  const t = await send(info.channel, `${BOT} Use your form tool to ask me for a demo booking: my name, a date, and my team size.`);
  const buttons = t.replies.flatMap((m) => (m.blocks ?? []).flatMap((b) => b.elements ?? [])).filter((e) => e.type === 'button');
  state.formThread = t.ts;
  return {
    pass: t.traces.includes('slack_ask_form') && buttons.some((b) => b.action_id === 'vf-form'),
    evidence: `buttons [${buttons.map((b) => `${b.text?.text} (${b.action_id})`).join(', ')}]; ${summary(t)}`,
  };
});

// ── Workspace tools ─────────────────────────────────────────────────────────

await check('slack_find_person', async () => {
  const t = await send(info.channel, `${BOT} Use your find person tool to look up ${ME} and tell me their title and time zone.`);
  // The time zone comes from Slack's profile (America/New_York), which only the tool returns.
  const zone = t.text.match(/\b[A-Z][a-z]+\/[A-Za-z_]+\b|\b(eastern|pacific|central|mountain) time\b/i);
  return { pass: Boolean(zone) && !t.errors.length && !declined(t.text), evidence: `time zone ${zone ? `"${zone[0]}"` : 'NOT IN THE REPLY'}; ${summary(t)}` };
});

await check('slack_read_channel', async () => {
  const t = await send(
    info.channel,
    `${BOT} Use your read channel tool to read the recent messages in this channel, and tell me the launch date someone mentioned.`,
  );
  // "March 3" is in an earlier top-level message: only reading the channel finds it.
  const found = /march\s*3|3\s*march/i.test(t.text);
  return { pass: found && !t.errors.length, evidence: `launch date ${found ? 'found' : 'NOT FOUND'}; ${summary(t)}` };
});

await check('slack_post_to_channel', async () => {
  const before = Date.now() / 1000;
  const t = await send(info.channel, `${BOT} Post exactly "SDK test post" in #${info.channelName} as a new message, not in this thread.`);
  const top = (await call('user', 'conversations.history', { channel: info.channel, oldest: String(before), limit: 50 })).messages.filter(
    (m) => m.user === info.botUserId && !m.thread_ts && /SDK test post/.test(m.text ?? ''),
  );
  const context = top.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'context').flatMap((b) => b.elements.map((e) => e.text)));
  return {
    pass: top.length === 1 && context.some((c) => /Posted for/.test(c)) && !t.errors.length,
    evidence: `top-level posts ${top.length}; note "${context.join(' ')}"; turn ${t.seconds}s; ${summary(t)}`,
  };
});

await check('refuses-channel-you-are-not-in', async () => {
  const mine = new Set();
  for (let c = ''; ; ) {
    const page = await call('user', 'users.conversations', { types: 'public_channel', limit: 200, ...(c ? { cursor: c } : {}) });
    for (const ch of page.channels) mine.add(ch.id);
    c = page.response_metadata?.next_cursor;
    if (!c) break;
  }
  const all = (await call('user', 'conversations.list', { types: 'public_channel', exclude_archived: true, limit: 200 })).channels;
  const target = all.find((ch) => !mine.has(ch.id) && !ch.is_general);
  if (!target) return { pass: false, evidence: 'found no public channel you are not in' };
  const t = await send(info.channel, `${BOT} Post "hello" in <#${target.id}>.`);
  // Named by ID, so the tool's own check runs: Slack lists a public channel's members to the bot without it joining.
  const refusedIt = /aren't a member|are not a member|not a member/i.test(t.text);
  return {
    pass: refusedIt && !t.errors.length,
    evidence: `asked for #${target.name}, which you're not in; ${refusedIt ? "refused: you're not a member" : 'NO MEMBERSHIP REFUSAL'}; ${summary(t)}`,
  };
});

await check('slack_message_person', async () => {
  const before = Date.now() / 1000;
  const t = await send(info.channel, `${BOT} Send me (${ME}) a direct message saying "hi from the SDK test".`);
  const dm = (await call('user', 'conversations.history', { channel: info.dm, oldest: String(before), limit: 20 })).messages.filter(
    (m) => m.user === info.botUserId && /hi from the SDK test/i.test(m.text ?? ''),
  );
  return { pass: dm.length > 0, evidence: `DMs with the text ${dm.length}; ${summary(t)}` };
});

await check('slack_schedule_message', async () => {
  const before = Math.floor(Date.now() / 1000);
  const t = await send(info.channel, `${BOT} Use your schedule tool to schedule a reminder in this thread for 3 minutes from now, saying "check the oven".`);
  const list = (await call('bot', 'chat.scheduledMessages.list', { channel: info.channel })).scheduled_messages ?? [];
  // Scheduled for about three minutes after the ask (the turn itself takes some of them).
  const mine = list.filter((m) => /oven/i.test(m.text ?? '') && m.post_at >= before + 120 && m.post_at <= before + 420);
  return {
    pass: mine.length === 1 && !t.errors.length,
    evidence: `scheduled ${mine.map((m) => `${new Date(m.post_at * 1000).toISOString().slice(11, 16)}Z "${short(m.text, 60)}"`).join(', ') || 'none'}; ${summary(t)}`,
  };
});

await check('slack_pin_message', async () => {
  const t = await send(info.channel, `${BOT} Pin this thread's first message.`);
  const pins = (await call('user', 'pins.list', { channel: info.channel })).items ?? [];
  return {
    pass: pins.some((p) => p.message?.ts === t.ts),
    evidence: `pinned [${pins.map((p) => p.message?.ts).join(' ')}], your message ${t.ts}; ${summary(t)}`,
  };
});

await check('slack_add_bookmark', async () => {
  const t = await send(info.channel, `${BOT} Add a bookmark to this channel for https://www.voiceflow.com titled Voiceflow.`);
  const marks = (await call('user', 'bookmarks.list', { channel_id: info.channel })).bookmarks ?? [];
  return {
    pass: marks.some((b) => /voiceflow\.com/.test(b.link ?? '')),
    evidence: `bookmarks [${marks.map((b) => `${b.title} ${b.link}`).join(', ')}]; ${summary(t)}`,
  };
});

await check('slack_create_canvas', async () => {
  const t = await send(info.channel, `${BOT} Create a canvas titled "SDK test notes" with three short bullet points about this test, and give me its link.`);
  // Slack turns a canvas link into its own element (a canvas chip carrying the url); the text fallback keeps only the ID.
  const urls = t.replies
    .flatMap((m) => (m.blocks ?? []).flatMap((b) => (b.elements ?? []).flatMap((s) => s.elements ?? [])))
    .map((e) => e.url)
    .filter(Boolean);
  const link = urls.find((u) => /slack\.com\/docs\//.test(u)) ?? t.text.match(/https:\/\/\S+slack\.com\/docs\/\S+/)?.[0];
  return { pass: Boolean(link) && !t.errors.length, evidence: `canvas link ${link ?? 'NOT IN THE REPLY'}; ${summary(t)}` };
});

await check('slack_send_file', async () => {
  const t = await send(info.channel, `${BOT} Send me a CSV file named fruits.csv with 3 fruits and their colors, here in this thread.`);
  const files = t.replies.flatMap((m) => m.files ?? []);
  return {
    pass: files.some((f) => /fruits/i.test(f.name ?? f.title ?? '')),
    evidence: `files [${files.map((f) => `${f.name} ${f.filetype}`).join(', ')}]; ${summary(t)}`,
  };
});

const failed = results.filter((r) => r.result === 'fail');
log(`done: ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(', ')}` : ''}`);
log('needs a person in Slack: the assistant panel, the Home tab, /ask, the form dialog, and seeing the private reply');
