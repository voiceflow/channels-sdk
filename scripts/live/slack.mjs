// Live Slack check: this package against a real Slack app and a real Voiceflow
// agent. No secret is printed or written to disk:
// - the bot token comes back from installing the app with the Slack CLI's login;
// - the signing secret comes back from creating the app (--create), or is typed
//   into a hidden prompt (or SLACK_SIGNING_SECRET) for an app that already exists;
// - the Voiceflow key is read from a file you name.
//
//   node scripts/live/slack.mjs --create --team <id> --project <id> --environment <alias> \
//     --key-file <path> --public-url https://<tunnel> [--port 8788]
//   node scripts/live/slack.mjs --delete --team <id>
//
// --create makes a new app for the test, with the assistant panel and every scope and
// event this package uses, and installs it. Slack returns an app's signing secret only
// when it creates the app, so it lives in this process's memory: a new run means a new
// app. The app's ID (no secret) is kept in .run/slack-sdk-app.json; --delete removes it.
//
// Or use an app that already exists: --app <id> instead of --create. --configure then
// points its event and interactivity URLs at --public-url, turns on the assistant panel
// and the scopes this package uses, and reinstalls it. The manifest it replaced is saved
// to .run/slack-manifest.before.json; --restore puts it back.
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createChannels } from '../../dist/index.js';

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    team: { type: 'string' },
    project: { type: 'string' },
    environment: { type: 'string', default: 'production' },
    'key-file': { type: 'string' },
    'public-url': { type: 'string' },
    port: { type: 'string', default: '8788' },
    configure: { type: 'boolean', default: false },
    restore: { type: 'boolean', default: false },
    create: { type: 'boolean', default: false },
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
const SDK_APP = '.run/slack-sdk-app.json';
const ADD_SCOPES = ['assistant:write', 'users:read', 'channels:read', 'groups:read', 'im:read'];
const ADD_EVENTS = ['assistant_thread_started', 'assistant_thread_context_changed'];

/** The test app --create makes: mentions, thread replies, DMs, buttons and the assistant panel. */
function newManifest(requestUrl) {
  return {
    display_information: { name: 'Channels SDK test', description: 'Test of the Voiceflow Channels SDK. Temporary.' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'channels-sdk-test', always_online: true },
      assistant_view: { assistant_description: 'Test of the Voiceflow Channels SDK.' },
    },
    oauth_config: {
      scopes: { bot: ['app_mentions:read', 'chat:write', 'channels:history', 'groups:history', 'im:history', ...ADD_SCOPES] },
    },
    settings: {
      event_subscriptions: { request_url: requestUrl, bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', ...ADD_EVENTS] },
      interactivity: { is_enabled: true, request_url: requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

const cli = JSON.parse(fs.readFileSync(`${process.env.HOME}/.slack/credentials.json`, 'utf8'))[need('team')];
if (!cli?.token) die(`No Slack CLI login for team ${args.team}. Run: slack login`);

async function slack(method, body, { form = false, token = cli.token } = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.error} ${JSON.stringify(json.errors ?? '').slice(0, 300)}`);
  return json;
}

if (args.restore) {
  const before = JSON.parse(fs.readFileSync(BEFORE, 'utf8'));
  await slack('apps.manifest.update', { app_id: need('app'), manifest: JSON.stringify(before) });
  log(`restored the manifest from ${BEFORE}`);
  process.exit(0);
}

if (args.delete) {
  const app = JSON.parse(fs.readFileSync(SDK_APP, 'utf8'));
  await slack('apps.manifest.delete', { app_id: app.app_id });
  fs.rmSync(SDK_APP);
  log(`deleted app ${app.app_id}`);
  process.exit(0);
}
if (args.create && args.app) die('Use --create or --app, not both.');
if (args.create && fs.existsSync(SDK_APP)) {
  die(`${SDK_APP} names an app from an earlier run, and its signing secret was never saved. Run --delete, then --create again.`);
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
const apiKey = fs.readFileSync(need('key-file'), 'utf8').trim();
// A new app's signing secret comes back from Slack below; an existing app's is typed here.
let signingSecret = args.create ? null : process.env.SLACK_SIGNING_SECRET || (await hiddenInput('Slack signing secret (Basic Information > App Credentials): '));
if (!args.create && !signingSecret) die('No signing secret entered.');

// One server for the whole run. Until the bot is ready it answers only Slack's URL
// challenge, so the manifest update below can verify the new request URL.
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

let appId = args.app;
let manifest;
if (args.create) {
  // Slack checks the request URL while it creates the app; the server above answers it.
  manifest = newManifest(requestUrl);
  const created = await slack('apps.manifest.create', { manifest: JSON.stringify(manifest) });
  appId = created.app_id;
  fs.writeFileSync(SDK_APP, JSON.stringify({ app_id: appId, team_id: args.team, created: new Date().toISOString() }, null, 2), { mode: 0o600 });
  signingSecret = created.credentials?.signing_secret ?? die('Created the app, but no signing secret came back.');
  log(`created app ${appId} (remove it with --delete)`);
} else {
  manifest = (await slack('apps.manifest.export', { app_id: need('app') })).manifest;
}
const exported = manifest;
if (args.configure && !args.create) {
  if (!fs.existsSync(BEFORE)) fs.writeFileSync(BEFORE, JSON.stringify(exported, null, 2), { mode: 0o600 });
  manifest = structuredClone(exported);
  manifest.features = { ...manifest.features, assistant_view: { assistant_description: 'Test of the Voiceflow Channels SDK.' } };
  const scopes = new Set([...(manifest.oauth_config?.scopes?.bot ?? []), ...ADD_SCOPES]);
  manifest.oauth_config = { ...manifest.oauth_config, scopes: { ...manifest.oauth_config?.scopes, bot: [...scopes] } };
  const events = new Set([...(manifest.settings?.event_subscriptions?.bot_events ?? []), ...ADD_EVENTS]);
  manifest.settings = {
    ...manifest.settings,
    event_subscriptions: { request_url: requestUrl, bot_events: [...events] },
    interactivity: { is_enabled: true, request_url: requestUrl },
  };
  await slack('apps.manifest.update', { app_id: appId, manifest: JSON.stringify(manifest) });
  log(`manifest updated (the one it replaced is in ${BEFORE})`);
}

const installed = await slack(
  'apps.developerInstall',
  { app_id: appId, bot_scopes: manifest.oauth_config.scopes.bot.join(','), outgoing_domains: '[]' },
  { form: true },
);
const botToken = installed.api_access_tokens?.bot ?? die('Installed, but no bot token came back.');
const me = await slack('auth.test', {}, { token: botToken });
const userName = manifest.features?.bot_user?.display_name ?? 'voiceflow';
log(`installed: bot @${userName} (${me.user_id}) in ${me.team}`);

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
  })().catch(() => {});
  return new Response(theirs, { status: res.status, headers: res.headers });
};

const channels = await createChannels({
  voiceflow: { apiKey, projectID: need('project'), environment: args.environment, fetch: vfFetch },
  channels: [{ slug: 'slack', options: { botToken, signingSecret, botUserId: me.user_id, feedbackButtons: true } }],
  state: createMemoryState(),
  userName,
  chat: { logger: 'warn' },
  onTurn: (t) => log(`turn: replies ${t.replies.map((r) => r.type).join(', ') || '(none)'}${t.skipped.length ? `; skipped ${t.skipped.join(', ')}` : ''}${t.ended ? '; ended' : ''}`),
  onError: (error) => log('turn failed:', error?.code ?? '', error?.message ?? error),
  onFeedback: (f) => log(`feedback: ${f.positive ? '👍' : '👎'} (${f.value}) from ${f.user.userId} on ${f.messageId}`),
});

handle = (request) =>
  channels.webhook('slack', request, {
    waitUntil: (task) => {
      pending.add(task);
      task.catch((error) => log('background task failed:', error?.message ?? error)).finally(() => pending.delete(task));
    },
  });
log('ready: mention the bot in a channel it is in, or open its assistant panel');
