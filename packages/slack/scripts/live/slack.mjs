// Live Slack check: this package against a real Slack app and a real Voiceflow
// agent, through the same connect code `voiceflow-channels connect slack` runs.
// No secret is printed or written to disk:
// - the bot token comes back from installing the app with the Slack CLI's login;
// - a new app's signing secret comes back from creating it; an existing app's is
//   typed into a hidden prompt (or SLACK_SIGNING_SECRET);
// - the Voiceflow key is read from a file you name.
//
//   node packages/slack/scripts/live/slack.mjs --team <id> --project <id> --environment <alias> \
//     --key-file <path> --public-url https://<tunnel> [--workspace <id>] [--install-tools] [--dry-run | --yes]
//   node packages/slack/scripts/live/slack.mjs --delete --team <id> --project <id> --environment <alias> --key-file <path> [--remove-tools]
//
// The first run makes a new app (one is recorded per agent in .run/, no secrets);
// later runs reuse it, adding anything missing, and ask for its signing secret.
// --app <id> uses an app you have instead: the manifest it had is saved to
// .run/slack-manifest.before.json, and --restore puts it back. --install-tools
// installs Slack's tools on the environment's draft (never published), with the
// app's bot token as the slack_bot_token secret. The plan is shown first; --dry-run
// stops there, and without --yes it asks.
//
// --drive lets a script run the test as you: the app also gets user scopes, and a
// driver on a Unix socket (.run/drive.sock, yours only; never a port, so nothing
// forwards it) posts as you in your DM with the bot and in a private #vf-sdk-test
// channel, and nowhere else. scripts/live/drive.mjs is that script. The user token
// stays in this process's memory, and deleting the app revokes it.
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels } from '@voiceflow/channels-sdk';
import { fileRecordStore } from '@voiceflow/channels-sdk/install';
import { slack } from '@voiceflow/channels-slack';
import { connectSlack, createSlackApi, disconnectSlack, fileAppRecordStore, slackCliLogin } from '@voiceflow/channels-slack/connect';

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    team: { type: 'string' },
    project: { type: 'string' },
    environment: { type: 'string' },
    workspace: { type: 'string' },
    'key-file': { type: 'string' },
    'public-url': { type: 'string' },
    port: { type: 'string', default: '8788' },
    'install-tools': { type: 'boolean', default: false },
    'remove-tools': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    drive: { type: 'boolean', default: false },
    restore: { type: 'boolean', default: false },
    delete: { type: 'boolean', default: false },
  },
});
const need = (name) => args[name] ?? die(`--${name} is required`);
function die(message) {
  console.error(message);
  process.exit(2);
}
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

const BEFORE = '.run/slack-manifest.before.json';
const DRIVE_SOCKET = '.run/drive.sock';
const DRIVE_CHANNEL = 'vf-sdk-test';
// What the driver may do as you: post and react (in the DM and the test channel only), make the test channel, and read.
const DRIVE_USER_SCOPES = [
  'bookmarks:read',
  'channels:read',
  'chat:write',
  'files:read',
  'groups:history',
  'groups:read',
  'groups:write',
  'im:history',
  'im:write',
  'pins:read',
  'reactions:read',
  'reactions:write',
  'users:read',
];
/** What happened, for the driver: turns, failures, feedback and each streamed turn's trace types. */
const events = [];
const note = (event) => events.push({ at: Date.now(), ...event });
const appRecords = fileAppRecordStore('.run/slack-sdk-apps.json');
const record = fileRecordStore('.run/channels-install.json');
const login = slackCliLogin(need('team'));
const slackApi = createSlackApi({ token: login.token });

if (args.restore) {
  const before = JSON.parse(fs.readFileSync(BEFORE, 'utf8'));
  await slackApi('apps.manifest.update', { app_id: need('app'), manifest: JSON.stringify(before) });
  log(`restored the manifest from ${BEFORE}`);
  process.exit(0);
}

const apiKey = fs.readFileSync(need('key-file'), 'utf8').trim();
const voiceflowTarget = {
  apiKey,
  projectID: need('project'),
  environment: need('environment'),
  ...(args.workspace ? { expectWorkspace: args.workspace } : {}),
  record,
};

async function confirm(lines) {
  console.log(lines.join('\n'));
  if (args['dry-run']) return false;
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    console.log('\nNothing was changed: run it again with --yes to go ahead.');
    return false;
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nGo ahead? [y/N] ', (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

if (args.delete) {
  const result = await disconnectSlack({
    slack: { token: login.token, teamId: login.teamId },
    voiceflow: voiceflowTarget,
    ...(args.app ? { appId: args.app } : {}),
    removeTools: args['remove-tools'],
    appRecords,
    confirm,
    onProgress: (line) => log(line),
  });
  process.exit(result.applied ? 0 : 1);
}

function hiddenInput(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(s);
    };
    rl.question(prompt, (value) => {
      rl.close();
      process.stdout.write('\n');
      resolve(value.trim());
    });
  });
}

const publicUrl = need('public-url').replace(/\/+$/, '');
const requestUrl = `${publicUrl}/api/slack`;

// One server for the whole run. Until the bot is ready it answers only Slack's URL
// challenge, so Slack can check the request URL while connect makes or updates the app.
let handle = async (request) => {
  const body = await request.json().catch(() => ({}));
  return body?.type === 'url_verification' ? Response.json({ challenge: body.challenge }) : new Response('starting', { status: 503 });
};
const pending = new Set();
const server = http.createServer(async (req, res) => {
  // Slack signs the exact bytes, so the body is joined as bytes before it's decoded.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const request = new Request(`${publicUrl}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? raw : undefined });
  try {
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    log('webhook error:', error?.message ?? error);
    res.writeHead(500);
    res.end();
  }
});
await new Promise((resolve) => server.listen(Number(args.port), '127.0.0.1', resolve));
log(`listening on http://127.0.0.1:${args.port}, public ${requestUrl}`);

const connected = await connectSlack({
  slack: { token: login.token, teamId: login.teamId },
  voiceflow: voiceflowTarget,
  requestUrl,
  ...(args.app ? { appId: args.app } : {}),
  app: {
    name: 'Channels SDK test',
    description: 'Test of the Voiceflow Channels SDK. Temporary.',
    botName: 'channels-sdk-test',
    ...(args.drive ? { userScopes: DRIVE_USER_SCOPES } : {}),
  },
  tools: args['install-tools'] ? {} : false,
  appRecords,
  confirm: (plan) => confirm(plan.lines),
  onProgress: (line) => log(line),
});
if (!connected.applied) {
  server.close();
  process.exit(0);
}
if (args.app && connected.plan.app.previous && !fs.existsSync(BEFORE)) {
  fs.writeFileSync(BEFORE, JSON.stringify(connected.plan.app.previous, null, 2), { mode: 0o600 });
  log(`the manifest it had is in ${BEFORE} (--restore puts it back)`);
}
for (const problem of connected.install?.problems ?? []) log('install problem:', problem);
const signingSecret =
  connected.signingSecret ?? process.env.SLACK_SIGNING_SECRET ?? (await hiddenInput('Slack signing secret (Basic Information > App Credentials): '));
if (!signingSecret) die('No signing secret.');
const botToken = connected.botToken;
const userName = connected.plan.app.manifest.features?.bot_user?.display_name ?? 'voiceflow';
log(`ready to run: app ${connected.appId}, bot @${userName} (${connected.botUserId})`);

// Every Voiceflow call, by path and status, and a streamed turn's trace types. Never headers.
const vfFetch = async (url, init) => {
  const res = await fetch(url, init);
  const path = new URL(url).pathname;
  log(`voiceflow ${path} -> ${res.status}`);
  if (!path.endsWith('/stream') || !res.body) return res;
  const [mine, theirs] = res.body.tee();
  (async () => {
    const reader = mine.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) text += r.value;
    const types = [...text.matchAll(/^data: (.*)$/gm)].map((m) => {
      try {
        const t = JSON.parse(m[1]);
        return t.type ? `${t.type}${t.payload?.state ? `:${t.payload.state}` : ''}` : null;
      } catch {
        return null;
      }
    });
    log('  traces:', types.filter(Boolean).join(' '));
    note({ kind: 'traces', types: types.filter(Boolean) });
  })().catch(() => {});
  return new Response(theirs, { status: res.status, headers: res.headers });
};

const channels = await createChannels({
  voiceflow: { apiKey, projectID: args.project, environment: args.environment, fetch: vfFetch },
  channels: [slack({ adapter: { botToken, signingSecret, botUserId: connected.botUserId } })],
  state: createMemoryState(),
  userName,
  chat: { logger: 'warn' },
  onTurn: (t) => {
    log(
      `turn: replies ${t.replies.map((r) => r.type).join(', ') || '(none)'}${t.skipped.length ? `; skipped ${t.skipped.join(', ')}` : ''}${t.ended ? '; ended' : ''}`,
    );
    note({ kind: 'turn', replies: t.replies.map((r) => r.type), skipped: t.skipped, ended: Boolean(t.ended) });
  },
  onError: (error) => {
    log('turn failed:', error?.code ?? '', error?.message ?? error);
    note({ kind: 'error', code: error?.code ?? '', message: String(error?.message ?? error).slice(0, 300) });
  },
  onFeedback: (f) => {
    log(`feedback: ${f.positive ? '👍' : '👎'} (${f.value}) via ${f.via ?? '?'} from ${f.user.userId} on ${f.messageId}`);
    note({ kind: 'feedback', positive: f.positive, value: f.value, via: f.via, userId: f.user.userId, messageId: f.messageId });
  },
});

handle = (request) =>
  channels.webhook('slack', request, {
    waitUntil: (task) => {
      pending.add(task);
      task
        .catch((error) => {
          log('background task failed:', error?.message ?? error);
          note({ kind: 'error', code: 'background', message: String(error?.message ?? error).slice(0, 300) });
        })
        .finally(() => pending.delete(task));
    },
  });
log('ready: mention the bot in a channel it is in, DM it, open its assistant panel or Home tab, or use its slash command');
if (args.drive) await startDriver();

/**
 * The test driver: acts as you, through the user token only this process holds.
 * It posts and reacts only in your DM with the bot and in #vf-sdk-test, and
 * otherwise only reads. It never returns a token.
 */
async function startDriver() {
  const userToken = connected.userToken ?? die('--drive: Slack returned no user token.');
  const slackAs = (who, method, params = {}) => slackApi(method, params, { form: true, token: who === 'user' ? userToken : botToken });
  const me = await slackAs('user', 'auth.test');
  const dm = (await slackAs('user', 'conversations.open', { users: connected.botUserId })).channel.id;
  let channel;
  try {
    channel = (await slackAs('user', 'conversations.create', { name: DRIVE_CHANNEL, is_private: true })).channel.id;
    log(`driver: made private channel #${DRIVE_CHANNEL} (${channel})`);
  } catch (error) {
    if (!String(error.message).includes('name_taken')) throw error;
    for (let cursor = ''; !channel; ) {
      const page = await slackAs('user', 'conversations.list', { types: 'private_channel', limit: 200, ...(cursor ? { cursor } : {}) });
      channel = page.channels.find((c) => c.name === DRIVE_CHANNEL)?.id;
      cursor = page.response_metadata?.next_cursor;
      if (!cursor && !channel) die(`#${DRIVE_CHANNEL} exists, but not among your private channels: rename it or pick another name.`);
    }
    log(`driver: using private channel #${DRIVE_CHANNEL} (${channel})`);
  }
  await slackAs('user', 'conversations.invite', { channel, users: connected.botUserId }).catch((error) => {
    if (!String(error.message).includes('already_in_channel')) throw error;
  });
  const writable = new Set([dm, channel]);
  const allowed = {
    user: new Set([
      'chat.postMessage',
      'reactions.add',
      'reactions.get',
      'conversations.replies',
      'conversations.history',
      'conversations.list',
      'users.conversations',
      'pins.list',
      'bookmarks.list',
      'files.info',
    ]),
    bot: new Set(['conversations.replies', 'conversations.history', 'chat.scheduledMessages.list', 'reactions.get', 'files.info', 'conversations.members']),
  };
  const writes = new Set(['chat.postMessage', 'reactions.add']);
  const info = { userId: me.user_id, botUserId: connected.botUserId, appId: connected.appId, dm, channel, channelName: DRIVE_CHANNEL };

  fs.rmSync(DRIVE_SOCKET, { force: true });
  const driver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (req.url === '/info') return send(200, info);
      if (req.url === '/events') return send(200, { events: events.slice(Number(body.since ?? 0)), next: events.length });
      if (req.url === '/call') {
        const who = body.as === 'bot' ? 'bot' : 'user';
        if (!allowed[who].has(body.method)) return send(403, { error: `the driver doesn't call ${body.method} as ${who}` });
        if (writes.has(body.method) && !writable.has(body.params?.channel))
          return send(403, { error: `the driver writes only in the DM and #${DRIVE_CHANNEL}` });
        if (writes.has(body.method)) log(`driver: ${body.method} as you in ${body.params.channel === dm ? 'the DM' : `#${DRIVE_CHANNEL}`}`);
        return send(200, await slackAs(who, body.method, body.params ?? {}));
      }
      send(404, { error: 'unknown' });
    } catch (error) {
      send(500, { error: String(error?.message ?? error).slice(0, 300) });
    }
  });
  await new Promise((resolve) => driver.listen(DRIVE_SOCKET, resolve));
  fs.chmodSync(DRIVE_SOCKET, 0o600);
  log(`driver: listening on ${DRIVE_SOCKET} (you ${me.user_id}; DM ${dm}; #${DRIVE_CHANNEL} ${channel})`);
}
