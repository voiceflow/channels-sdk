// `connect slack`, against fakes of Slack's app API and Voiceflow's API: the
// manifest it makes, the plan it shows before changing anything, where it
// stops, and where the app's secrets go (memory and the file you name, never
// a log line).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryRecordStore } from '@voiceflow/channels-sdk/install';
import { fakeVoiceflowApi } from '@voiceflow/channels-sdk/testing';
import {
  BOT_EVENTS,
  BOT_SCOPES,
  connectSlack,
  disconnectSlack,
  memoryAppRecordStore,
  mergeManifest,
  requiredScopes,
  slackManifest,
} from '../dist/connect/index.js';
import { urlChecker, writeEnvFile } from '../dist/connect/cli.js';
import { slackTools, slackToolScopes } from '../dist/index.js';

const URL_ = 'https://bot.example.com/api/slack';
const PROJECT = { id: 'proj1', name: 'Spike', workspaceID: 'ws1' };
const VF_KEY = 'VF.DM.connect-test';
const CLI_TOKEN = 'xoxp-cli-login-never-printed';
const BOT_TOKEN = 'xoxb-bot-token-never-printed';
const SIGNING = 'signing-secret-never-printed';

/** Slack's app API as a `fetch`: apps made from manifests, installs, and every call recorded. */
function fakeSlack({ team = 'T1', invalid, apps: existing = {} } = {}) {
  const apps = new Map(Object.entries(existing).map(([id, manifest]) => [id, structuredClone(manifest)]));
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    const auth = new Headers(init.headers).get('authorization');
    const form = String(new Headers(init.headers).get('content-type')).startsWith('application/x-www-form-urlencoded');
    const body = form ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body || '{}');
    calls.push({ method, body, form, token: auth?.replace('Bearer ', '') });
    const ok = (more = {}) => Response.json({ ok: true, ...more });
    const no = (error, more = {}) => Response.json({ ok: false, error, ...more });
    if (method === 'auth.test') {
      if (auth === `Bearer ${CLI_TOKEN}`) return ok({ team_id: team, team: 'Example', user_id: 'UME' });
      if (auth === `Bearer ${BOT_TOKEN}`) return ok({ team_id: team, team: 'Example', user_id: 'UBOT', bot_id: 'B1' });
      return no('invalid_auth');
    }
    if (auth !== `Bearer ${CLI_TOKEN}`) return no('invalid_auth');
    switch (method) {
      case 'apps.manifest.validate':
        return invalid ? no('invalid_manifest', { errors: [{ message: invalid, pointer: '/features' }] }) : ok();
      case 'apps.manifest.create': {
        const id = `A${++n}`;
        apps.set(id, JSON.parse(body.manifest));
        return ok({ app_id: id, credentials: { signing_secret: SIGNING, client_id: 'c', client_secret: 'cs' } });
      }
      case 'apps.manifest.export':
        return apps.has(body.app_id) ? ok({ manifest: apps.get(body.app_id) }) : no('app_not_found');
      case 'apps.manifest.update':
        if (!apps.has(body.app_id)) return no('app_not_found');
        apps.set(body.app_id, JSON.parse(body.manifest));
        return ok({ app_id: body.app_id });
      case 'apps.manifest.delete':
        return apps.delete(body.app_id) ? ok() : no('app_not_found');
      case 'apps.developerInstall':
        if (!form) return no('invalid_arguments');
        return apps.has(body.app_id) ? ok({ api_access_tokens: { bot: BOT_TOKEN, app_level: null, user: null } }) : no('app_not_found');
      default:
        return no('unknown_method');
    }
  };
  const writes = () => calls.filter((c) => /create|update|delete|developerInstall/.test(c.method));
  return { fetch, calls, apps, writes };
}

function setup({ slack: slackOptions, voiceflow: vfOptions = {}, more = {} } = {}) {
  const slack = fakeSlack(slackOptions);
  const vf = fakeVoiceflowApi({ project: PROJECT, apiKey: VF_KEY });
  const record = memoryRecordStore();
  const appRecords = memoryAppRecordStore();
  const progress = [];
  const options = (extra = {}) => ({
    slack: { token: CLI_TOKEN, teamId: 'T1', fetch: slack.fetch },
    voiceflow: { apiKey: VF_KEY, projectID: PROJECT.id, environment: 'sdk-test', expectWorkspace: 'ws1', fetch: vf.fetch, record, ...vfOptions },
    requestUrl: URL_,
    appRecords,
    onProgress: (line) => progress.push(line),
    ...more,
    ...extra,
  });
  return { slack, vf, record, appRecords, progress, options };
}

const noSecrets = (text) => {
  for (const secret of [CLI_TOKEN, BOT_TOKEN, SIGNING, VF_KEY]) assert.ok(!String(text).includes(secret), `a secret leaked into: ${String(text).slice(0, 200)}`);
};

// ── The manifest ────────────────────────────────────────────────────────────

test('the manifest asks for every scope and event the package and its tools use', () => {
  const m = slackManifest({ requestUrl: URL_ });
  const scopes = m.oauth_config.scopes.bot;
  for (const s of [...BOT_SCOPES, ...slackToolScopes()]) assert.ok(scopes.includes(s), `missing scope ${s}`);
  assert.deepEqual(scopes, [...new Set(scopes)].sort(), 'sorted, no repeats');
  assert.deepEqual(m.settings.event_subscriptions.bot_events, [...BOT_EVENTS]);
  assert.equal(m.settings.event_subscriptions.request_url, URL_);
  assert.equal(m.settings.interactivity.request_url, URL_);
  assert.equal(m.settings.socket_mode_enabled, false);
  assert.equal(m.features.app_home.home_tab_enabled, true);
  assert.ok(m.features.assistant_view, 'the assistant panel');
  assert.deepEqual(m.features.slash_commands.map((c) => [c.command, c.url]), [['/ask', URL_]]);
  // What the bot's own behaviours need, each for a reason.
  for (const s of ['reactions:write', 'reactions:read', 'commands', 'assistant:write', 'users:read.email', 'mpim:history']) assert.ok(scopes.includes(s), s);
});

test('the manifest follows the options: name, command, which tools', () => {
  const m = slackManifest({ requestUrl: URL_, name: 'Support Bot', command: false, tools: { workspace: false } });
  assert.equal(m.display_information.name, 'Support Bot');
  assert.equal(m.features.bot_user.display_name, 'support-bot');
  assert.equal(m.features.slash_commands, undefined);
  assert.ok(!m.oauth_config.scopes.bot.includes('canvases:write'), 'no workspace tools, no canvas scope');
  assert.ok(m.oauth_config.scopes.bot.includes('reactions:write'));
  assert.deepEqual(requiredScopes(false), [...BOT_SCOPES].sort());
  assert.ok(slackManifest({ requestUrl: URL_, command: '/helpdesk' }).features.slash_commands[0].command === '/helpdesk');
  assert.throws(() => slackManifest({ requestUrl: 'http://bot.example.com/api/slack' }), /https/);
  assert.throws(() => slackManifest({ requestUrl: 'not a url' }), /isn't a URL/);
  assert.throws(() => slackManifest({ requestUrl: URL_, command: 'ask' }), /slash command/);
});

test('merging into an app you have only adds, and points it at the request URL', () => {
  const existing = {
    display_information: { name: 'Ours' },
    features: { bot_user: { display_name: 'ours' }, slash_commands: [{ command: '/ask', url: 'https://old.example.com/x' }, { command: '/other', url: 'https://old.example.com/y' }] },
    oauth_config: { scopes: { bot: ['chat:write', 'files:read'] } },
    settings: { event_subscriptions: { request_url: 'https://old.example.com/x', bot_events: ['app_mention', 'team_join'] }, interactivity: { is_enabled: false } },
  };
  const { manifest, changes } = mergeManifest(existing, slackManifest({ requestUrl: URL_ }));
  assert.ok(manifest.oauth_config.scopes.bot.includes('files:read'), 'a scope of yours stays');
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('team_join'), 'an event of yours stays');
  assert.ok(!changes.scopesAdded.includes('chat:write'));
  assert.ok(changes.scopesAdded.includes('reactions:write'));
  assert.ok(changes.eventsAdded.includes('reaction_added'));
  assert.equal(changes.urlFrom, 'https://old.example.com/x');
  assert.equal(changes.commandAdded, undefined, '/ask was there already');
  assert.equal(manifest.features.slash_commands.find((c) => c.command === '/ask').url, URL_);
  assert.equal(manifest.features.slash_commands.find((c) => c.command === '/other').url, 'https://old.example.com/y', 'your other command is left alone');
  assert.equal(manifest.settings.interactivity.is_enabled, true);
  assert.equal(manifest.display_information.name, 'Ours');
  assert.equal(existing.oauth_config.scopes.bot.length, 2, 'the original is not changed');
  // Merging again changes nothing.
  const again = mergeManifest(manifest, slackManifest({ requestUrl: URL_ }));
  assert.deepEqual(again.manifest, manifest);
  assert.deepEqual([again.changes.scopesAdded, again.changes.eventsAdded, again.changes.urlFrom], [[], [], undefined]);
});

// ── Connecting ──────────────────────────────────────────────────────────────

test('the plan comes first, and saying no changes nothing anywhere', async () => {
  const { slack, vf, options, appRecords } = setup();
  let shown;
  const result = await connectSlack(options({ confirm: (plan) => ((shown = plan), false) }));
  assert.equal(result.applied, false);
  assert.deepEqual(slack.writes(), [], 'no Slack writes');
  assert.deepEqual(vf.writes(), [], 'no Voiceflow writes');
  assert.equal(appRecords.apps.size, 0);
  assert.equal(shown.app.action, 'create');
  const text = shown.lines.join('\n');
  assert.match(text, /\+ create app "Voiceflow agent" from the manifest: \d+ bot scopes, 10 events/);
  assert.match(text, /\+ install it in Example/);
  assert.match(text, /environment sdk-test \(nothing is published\)/);
  assert.match(text, /\+ secret slack_bot_token \(new, restricted; value: the app's bot token\)/);
  assert.match(text, /\+ tool slack_post_to_channel: create and attach/);
  assert.match(text, /~ compile the environment/);
  assert.ok(slack.calls.some((c) => c.method === 'apps.manifest.validate'), 'Slack checked the manifest');
  noSecrets(text);
});

test('connect makes the app, installs it, and puts the bot token on the agent as a secret', async () => {
  const { slack, vf, options, appRecords, progress } = setup();
  const credentials = [];
  const result = await connectSlack(options({ onCredentials: (c) => credentials.push(c) }));
  assert.equal(result.applied, true);
  assert.equal(result.created, true);
  assert.equal(result.appId, 'A1');
  assert.equal(result.botToken, BOT_TOKEN);
  assert.equal(result.signingSecret, SIGNING);
  assert.equal(result.botUserId, 'UBOT');

  // Slack: made from the manifest, then installed with every scope in it.
  assert.deepEqual(slack.writes().map((c) => c.method), ['apps.manifest.create', 'apps.developerInstall']);
  const install = slack.calls.find((c) => c.method === 'apps.developerInstall');
  assert.equal(install.form, true);
  assert.deepEqual(install.body.bot_scopes.split(','), slack.apps.get('A1').oauth_config.scopes.bot);

  // The credentials reach the caller as soon as each exists: the signing secret before the install can fail.
  assert.deepEqual(credentials, [{ appId: 'A1', signingSecret: SIGNING }, { appId: 'A1', botToken: BOT_TOKEN, botUserId: 'UBOT' }]);

  // Voiceflow: the token as the secret's value on the environment (draft and published), tools attached, compiled, never published.
  const secret = vf.state.secrets.find((s) => s.name === 'slack_bot_token');
  assert.equal(secret.visibility, 'restricted');
  const values = vf.state.secretValues.filter((v) => v.secretID === secret.id);
  assert.deepEqual(values.map((v) => [v.value, v.environmentAlias, v.versionVariant]), [[BOT_TOKEN, 'sdk-test', 'draft'], [BOT_TOKEN, 'sdk-test', 'published']]);
  assert.equal(vf.state.functions.length, slackTools().tools.length);
  assert.equal(vf.state.tools.length, slackTools().tools.length);
  assert.deepEqual(vf.state.compiles, ['sdk-test']);
  assert.ok(!vf.state.calls.some((c) => /publish/.test(c.path)), 'never published');

  // What's remembered names the app and nothing secret.
  const recorded = appRecords.apps.get('T1/proj1/sdk-test');
  assert.equal(recorded.appId, 'A1');
  assert.equal(recorded.requestUrl, URL_);
  noSecrets(JSON.stringify(recorded));
  noSecrets(progress.join('\n'));
  noSecrets(JSON.stringify(result.plan));
  noSecrets(JSON.stringify(result.install));
});

test('a project in another Voiceflow workspace stops connect before it reads or writes Slack', async () => {
  const { slack, vf, options } = setup({ voiceflow: { expectWorkspace: 'ws-other' } });
  await assert.rejects(connectSlack(options()), (e) => e.code === 'wrong_workspace' && /Nothing was changed/.test(e.message));
  assert.deepEqual(slack.calls, [], 'Slack was never called');
  assert.deepEqual(vf.writes(), []);
});

test('a Slack login for another workspace stops connect, changing nothing', async () => {
  const { slack, vf, options } = setup({ slack: { team: 'T9' } });
  await assert.rejects(connectSlack(options()), /workspace T9, not T1\. Nothing was changed/);
  assert.deepEqual(slack.writes(), []);
  assert.deepEqual(vf.writes(), []);
});

test('a manifest Slack refuses stops connect with Slack\'s reasons, changing nothing', async () => {
  const { slack, vf, options } = setup({ slack: { invalid: 'assistant_view requires assistant:write' } });
  await assert.rejects(connectSlack(options()), /Slack refused the manifest, so nothing was changed:\n\s+\/features assistant_view requires/);
  assert.deepEqual(slack.writes(), []);
  assert.deepEqual(vf.writes(), []);
});

test('running connect again reuses the app, changing only what is missing', async () => {
  const { slack, vf, options } = setup();
  await connectSlack(options());
  const writesBefore = { slack: slack.writes().length, vf: vf.writes().length };
  let plan;
  const again = await connectSlack(options({ confirm: (p) => ((plan = p), true) }));
  assert.equal(plan.app.action, 'unchanged');
  assert.match(plan.lines.join('\n'), /= app A1 "Voiceflow agent" has everything this package uses/);
  assert.equal(again.created, false);
  assert.equal(again.signingSecret, undefined, 'Slack gives the signing secret once');
  const slackWrites = slack.writes().slice(writesBefore.slack).map((c) => c.method);
  assert.deepEqual(slackWrites, ['apps.developerInstall'], 'no new app, no update');
  assert.equal(slack.apps.size, 1);
  for (const s of plan.voiceflow.steps.filter((s) => s.kind === 'tool')) assert.equal(s.action, 'current', s.name);
  const vfWrites = vf.writes().slice(writesBefore.vf);
  assert.ok(vfWrites.every((w) => /secret|compile/.test(w.path)), `only the token is written again: ${vfWrites.map((w) => w.path)}`);
});

test('an app that was deleted in Slack is made again, and the plan says why', async () => {
  const { slack, options } = setup();
  await connectSlack(options());
  slack.apps.delete('A1');
  let plan;
  const again = await connectSlack(options({ confirm: (p) => ((plan = p), true) }));
  assert.equal(plan.app.action, 'create');
  assert.match(plan.lines.join('\n'), /the app connect made before \(A1\) no longer exists/);
  assert.equal(again.appId, 'A2');
});

test('an app you name is updated with what is missing, and its old manifest is returned', async () => {
  const theirs = {
    display_information: { name: 'Theirs' },
    features: { bot_user: { display_name: 'theirs' } },
    oauth_config: { scopes: { bot: ['chat:write', 'files:read'] } },
    settings: { event_subscriptions: { request_url: 'https://old.example.com/slack', bot_events: ['app_mention'] } },
  };
  const { slack, options } = setup({ slack: { apps: { A77: theirs } } });
  let plan;
  const result = await connectSlack(options({ appId: 'A77', tools: false, confirm: (p) => ((plan = p), true) }));
  assert.equal(plan.app.action, 'update');
  const line = plan.lines.find((l) => l.includes('update app A77'));
  assert.match(line, /add scopes .*reactions:write/);
  assert.match(line, /requests go to https:\/\/bot\.example\.com\/api\/slack instead of https:\/\/old\.example\.com\/slack/);
  assert.match(line, /nothing is taken away/);
  assert.deepEqual(result.plan.app.previous, theirs);
  assert.ok(slack.apps.get('A77').oauth_config.scopes.bot.includes('files:read'));
  assert.deepEqual(slack.writes().map((c) => c.method), ['apps.manifest.update', 'apps.developerInstall']);
});

test('an app you name that does not exist is an error, not a new app', async () => {
  const { slack, options } = setup();
  await assert.rejects(connectSlack(options({ appId: 'A404' })), /app_not_found/);
  assert.deepEqual(slack.writes(), []);
});

test('with tools: false the app is made and the agent is left alone', async () => {
  const { vf, options } = setup();
  const result = await connectSlack(options({ tools: false }));
  assert.equal(result.applied, true);
  assert.equal(result.install, undefined);
  assert.deepEqual(vf.writes(), []);
  assert.match(result.plan.lines.join('\n'), /no tools installed/);
  assert.ok(!result.plan.lines.join('\n').includes('slack_bot_token secret'));
});

test('an expired Slack CLI login says how to refresh it', async () => {
  const { options } = setup();
  await assert.rejects(connectSlack(options({ slack: { token: 'xoxp-expired', fetch: fakeSlack().fetch } })), /slack auth list/);
});

// ── Disconnecting ───────────────────────────────────────────────────────────

test('disconnect deletes the app and leaves the tools, which are the agent\'s now', async () => {
  const { slack, vf, options, appRecords } = setup();
  await connectSlack(options());
  const before = vf.writes().length;
  let lines;
  const result = await disconnectSlack({ ...options(), confirm: (l) => ((lines = l), true) });
  assert.equal(result.applied, true);
  assert.match(lines.join('\n'), /- delete app A1/);
  assert.match(lines.join('\n'), /the tools stay on the agent/);
  assert.equal(slack.apps.size, 0);
  assert.equal(appRecords.apps.size, 0);
  assert.equal(vf.writes().length, before, 'nothing on the agent changed');
});

test('disconnect with removeTools also takes the tools off; saying no changes nothing', async () => {
  const { slack, vf, options } = setup();
  await connectSlack(options());
  const before = { slack: slack.writes().length, vf: vf.writes().length };
  const no = await disconnectSlack({ ...options(), removeTools: true, confirm: () => false });
  assert.equal(no.applied, false);
  assert.equal(slack.writes().length, before.slack);
  assert.equal(vf.writes().length, before.vf);
  await disconnectSlack({ ...options(), removeTools: true });
  assert.equal(vf.state.tools.length, 0);
  assert.equal(vf.state.functions.length, 0);
  assert.equal(vf.state.secrets.length, 1, 'the secret stays: other parts of the agent may use it');
});

// ── The command line's helpers ──────────────────────────────────────────────

test('the env file gets the keys, keeps its other lines, and is readable only by you', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vf-connect-'));
  const file = join(dir, '.env');
  await writeFile(file, 'OTHER=1\nexport SLACK_BOT_TOKEN=old\n', { mode: 0o644 });
  await writeEnvFile(file, { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_SIGNING_SECRET: undefined });
  await writeEnvFile(file, { SLACK_SIGNING_SECRET: SIGNING });
  assert.equal(await readFile(file, 'utf8'), `OTHER=1\nSLACK_BOT_TOKEN=${BOT_TOKEN}\nSLACK_SIGNING_SECRET=${SIGNING}\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("the URL checker answers Slack's challenge and nothing else", async () => {
  const port = 38000 + Math.floor(Math.random() * 1000);
  const checker = await urlChecker(port);
  try {
    const challenge = await fetch(`http://127.0.0.1:${port}/api/slack`, { method: 'POST', body: JSON.stringify({ type: 'url_verification', challenge: 'abc' }) });
    assert.deepEqual(await challenge.json(), { challenge: 'abc' });
    const event = await fetch(`http://127.0.0.1:${port}/api/slack`, { method: 'POST', body: JSON.stringify({ type: 'event_callback' }) });
    assert.equal(event.status, 503);
    // A second checker on the same port steps aside for whatever holds it.
    const second = await urlChecker(port);
    await second.close();
  } finally {
    await checker.close();
  }
});
