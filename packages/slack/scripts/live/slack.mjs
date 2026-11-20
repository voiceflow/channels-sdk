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
const voiceflowTarget = { apiKey, projectID: need('project'), environment: need('environment'), ...(args.workspace ? { expectWorkspace: args.workspace } : {}), record };

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
  app: { name: 'Channels SDK test', description: 'Test of the Voiceflow Channels SDK. Temporary.', botName: 'channels-sdk-test' },
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
  })().catch(() => {});
  return new Response(theirs, { status: res.status, headers: res.headers });
};

const channels = await createChannels({
  voiceflow: { apiKey, projectID: args.project, environment: args.environment, fetch: vfFetch },
  channels: [slack({ adapter: { botToken, signingSecret, botUserId: connected.botUserId } })],
  state: createMemoryState(),
  userName,
  chat: { logger: 'warn' },
  onTurn: (t) => log(`turn: replies ${t.replies.map((r) => r.type).join(', ') || '(none)'}${t.skipped.length ? `; skipped ${t.skipped.join(', ')}` : ''}${t.ended ? '; ended' : ''}`),
  onError: (error) => log('turn failed:', error?.code ?? '', error?.message ?? error),
  onFeedback: (f) => log(`feedback: ${f.positive ? '👍' : '👎'} (${f.value}) via ${f.via ?? '?'} from ${f.user.userId} on ${f.messageId}`),
});

handle = (request) =>
  channels.webhook('slack', request, {
    waitUntil: (task) => {
      pending.add(task);
      task.catch((error) => log('background task failed:', error?.message ?? error)).finally(() => pending.delete(task));
    },
  });
log('ready: mention the bot in a channel it is in, DM it, open its assistant panel or Home tab, or use its slash command');
