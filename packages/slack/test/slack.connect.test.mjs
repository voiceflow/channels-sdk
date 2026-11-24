// `connect slack`, against fakes of Slack's app API and Voiceflow's API: the
// manifest it makes, the plan it shows before changing anything, where it
// stops, and where the app's secrets go (memory and the file you name, never
// a log line).

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { memoryRecordStore } from '@voiceflow/channelkit/install';
import { fakeVoiceflowApi } from '@voiceflow/channelkit/testing';
import { cli, hidden, readEnvFile, urlChecker, writeEnvFile } from '../dist/connect/cli.js';
import {
  appNameOf,
  BOT_EVENTS,
  BOT_SCOPES,
  connectSlack,
  createSlackApi,
  disconnectSlack,
  memoryAppRecordStore,
  mergeManifest,
  repointManifest,
  requiredScopes,
  slackManifest,
} from '../dist/connect/index.js';
import { slackToolScopes, slackTools } from '../dist/index.js';

const URL_ = 'https://bot.example.com/api/slack';
const PROJECT = { id: 'proj1', name: 'Spike', workspaceID: 'ws1' };
const VF_KEY = 'VF.DM.connect-test';
const CLI_TOKEN = 'xoxp-cli-login-never-printed';
const BOT_TOKEN = 'xoxb-bot-token-never-printed';
const SIGNING = 'signing-secret-never-printed';
const USER_TOKEN = 'xoxp-user-token-never-printed';

/** Slack's app API as a `fetch`: apps made from manifests, installs, and every call recorded. */
function fakeSlack({ team = 'T1', invalid, apps: existing = {}, images = {}, iconError, botScopes, greetError } = {}) {
  const apps = new Map(Object.entries(existing).map(([id, manifest]) => [id, structuredClone(manifest)]));
  const calls = [];
  const downloads = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    // Images on the web, for the app's icon.
    if (!String(url).startsWith('https://slack.com/api/')) {
      downloads.push(String(url));
      const image = images[String(url)];
      return image ? new Response(image.bytes, { headers: { 'content-type': image.type } }) : new Response('not found', { status: 404 });
    }
    const method = String(url).split('/').pop();
    const auth = new Headers(init.headers).get('authorization');
    const form = String(new Headers(init.headers).get('content-type')).startsWith('application/x-www-form-urlencoded');
    const multipart = init.body instanceof FormData;
    const body = multipart
      ? Object.fromEntries(init.body.entries())
      : form
        ? Object.fromEntries(new URLSearchParams(init.body))
        : JSON.parse(init.body || '{}');
    calls.push({ method, body, form, multipart, token: auth?.replace('Bearer ', '') });
    const ok = (more = {}) => Response.json({ ok: true, ...more });
    const no = (error, more = {}) => Response.json({ ok: false, error, ...more });
    if (method === 'auth.test') {
      if (auth === `Bearer ${CLI_TOKEN}`) return ok({ team_id: team, team: 'Example', user_id: 'UME' });
      if (auth === `Bearer ${BOT_TOKEN}`) {
        const granted = botScopes ? { headers: { 'x-oauth-scopes': botScopes.join(',') } } : {};
        return Response.json({ ok: true, team_id: team, team: 'Example', user_id: 'UBOT', bot_id: 'B1' }, granted);
      }
      if (auth === `Bearer ${USER_TOKEN}`) return ok({ team_id: team, team: 'Example', user_id: 'UME2' });
      return no('invalid_auth');
    }
    // The bot's own message, with the bot's own token.
    if (method === 'chat.postMessage') {
      if (auth !== `Bearer ${BOT_TOKEN}`) return no('invalid_auth');
      return greetError ? no(greetError) : ok({ channel: 'D1', ts: '1.000001' });
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
      case 'apps.icon.set':
        if (!multipart || !(body.file instanceof File)) return no('invalid_arguments');
        if (!apps.has(body.app_id)) return no('app_not_found');
        {
          // A refusal for every image, or only for the ones a function names.
          const refused = typeof iconError === 'function' ? iconError(body.file) : iconError;
          return refused ? no(refused) : ok();
        }
      case 'apps.developerInstall':
        if (!form) return no('invalid_arguments');
        return apps.has(body.app_id)
          ? ok({ api_access_tokens: { bot: BOT_TOKEN, app_level: null, user: body.user_scopes ? USER_TOKEN : null } })
          : no('app_not_found');
      default:
        return no('unknown_method');
    }
  };
  const writes = () => calls.filter((c) => /create|update|delete|developerInstall|icon/.test(c.method));
  return { fetch, calls, apps, writes, downloads, of: (method) => calls.filter((c) => c.method === method) };
}

function setup({ slack: slackOptions, voiceflow: vfOptions = {}, more = {}, project = PROJECT } = {}) {
  const slack = fakeSlack(slackOptions);
  const vf = fakeVoiceflowApi({ project, apiKey: VF_KEY });
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
  for (const secret of [CLI_TOKEN, BOT_TOKEN, SIGNING, VF_KEY, USER_TOKEN])
    assert.ok(!String(text).includes(secret), `a secret leaked into: ${String(text).slice(0, 200)}`);
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
  assert.deepEqual(
    m.features.slash_commands.map((c) => [c.command, c.url]),
    [['/ask', URL_]],
  );
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
    features: {
      bot_user: { display_name: 'ours' },
      slash_commands: [
        { command: '/ask', url: 'https://old.example.com/x' },
        { command: '/other', url: 'https://old.example.com/y' },
      ],
    },
    oauth_config: { scopes: { bot: ['chat:write', 'files:read'] } },
    settings: {
      event_subscriptions: { request_url: 'https://old.example.com/x', bot_events: ['app_mention', 'team_join'] },
      interactivity: { is_enabled: false },
    },
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
  assert.match(text, /\+ create app "Spike" from the manifest: \d+ bot scopes, 10 events/, 'named after the agent');
  assert.match(text, /\+ install it in Example/);
  assert.match(text, /environment sdk-test: the tools go on its draft/);
  assert.match(text, /~ compile the environment's draft/);
  assert.doesNotMatch(text, /nothing is published/, 'whether it publishes is said after the plan, once');
  assert.match(text, /\+ install it in Example \(its bot token is for your server alone: it never goes to Voiceflow\)/);
  assert.match(text, /\+ secret channels_tools_url \(new, restricted; value: where your server runs the tools\)/);
  assert.match(text, /Slack's tools run on your server: the agent calls them at https:\/\/bot\.example\.com\/api\/slack/);
  assert.match(text, /\+ variable channels_turn_pass/);
  assert.doesNotMatch(text, /slack_bot_token/);
  assert.match(text, /\+ tool slack_post_to_channel: create and attach/);
  assert.match(text, /~ compile the environment/);
  assert.ok(
    slack.calls.some((c) => c.method === 'apps.manifest.validate'),
    'Slack checked the manifest',
  );
  noSecrets(text);
});

test("connect makes the app, installs it, and points the agent's tools at your server: the bot token never goes to Voiceflow", async () => {
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
  assert.deepEqual(
    slack.writes().map((c) => c.method),
    ['apps.manifest.create', 'apps.icon.set', 'apps.developerInstall'],
  );
  const install = slack.calls.find((c) => c.method === 'apps.developerInstall');
  assert.equal(install.form, true);
  assert.deepEqual(install.body.bot_scopes.split(','), slack.apps.get('A1').oauth_config.scopes.bot);

  // The credentials reach the caller as soon as each exists: the signing secret before the install can fail.
  assert.deepEqual(credentials, [
    { appId: 'A1', signingSecret: SIGNING },
    { appId: 'A1', botToken: BOT_TOKEN, botUserId: 'UBOT' },
  ]);

  // Voiceflow: where the tools call your server, on the environment (draft and published); tools attached, compiled, never published.
  assert.deepEqual(
    vf.state.secrets.map((s) => [s.name, s.visibility]),
    [['channels_tools_url', 'restricted']],
  );
  assert.deepEqual(
    vf.state.secretValues.map((v) => [v.value, v.environmentAlias, v.versionVariant]),
    [
      [URL_, 'sdk-test', 'draft'],
      [URL_, 'sdk-test', 'published'],
    ],
  );
  assert.equal(result.toolsUrl, URL_, "the webhook's own address, which answers tool calls too");
  // No call to Voiceflow, of any kind, carries the token.
  assert.ok(!JSON.stringify(vf.state.calls).includes(BOT_TOKEN), 'the bot token never reaches Voiceflow');
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

test('the tools can call a route of their own, and a tools URL that is not an address stops connect', async () => {
  const { vf, options } = setup();
  const result = await connectSlack(options({ toolsUrl: 'https://bot.example.com/api/tools' }));
  assert.equal(result.toolsUrl, 'https://bot.example.com/api/tools');
  assert.deepEqual([...new Set(vf.state.secretValues.map((v) => v.value))], ['https://bot.example.com/api/tools']);
  assert.match(result.plan.lines.join('\n'), /the agent calls them at https:\/\/bot\.example\.com\/api\/tools/);

  const bad = setup();
  await assert.rejects(connectSlack(bad.options({ toolsUrl: 'http://bot.example.com/api/tools' })), /tools URL must be an https address/);
  assert.deepEqual(bad.slack.writes(), []);
  assert.deepEqual(bad.vf.writes(), []);
});

test('an agent connected before keeps its old slack_bot_token secret, and connect says to delete it', async () => {
  const { vf, options, progress } = setup();
  vf.state.secrets.push({ id: 'old', name: 'slack_bot_token', visibility: 'restricted', hasValue: true });
  let plan;
  const result = await connectSlack(options({ confirm: (p) => ((plan = p), true) }));
  const note = /! The slack_bot_token secret is still on Spike\. .*they run on your server now.* Delete it in Voiceflow \(More → Secrets\)/;
  assert.match(plan.lines.join('\n'), note, 'in the plan, before anything changes');
  assert.match(result.notes.join('\n'), /slack_bot_token secret is still on Spike/);
  assert.ok(
    vf.state.secrets.some((s) => s.name === 'slack_bot_token'),
    'connect never deletes a secret',
  );
  assert.equal(vf.state.secretValues.filter((v) => v.secretID === 'old').length, 0, 'and writes nothing to it');
  noSecrets(progress.join('\n'));
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

test("a manifest Slack refuses stops connect with Slack's reasons, changing nothing", async () => {
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
  assert.match(plan.lines.join('\n'), /= app A1 "Spike" has everything this package uses/);
  assert.equal(again.created, false);
  assert.equal(again.signingSecret, undefined, 'Slack gives the signing secret once');
  const slackWrites = slack
    .writes()
    .slice(writesBefore.slack)
    .map((c) => c.method);
  assert.deepEqual(slackWrites, ['apps.developerInstall'], 'no new app, no update');
  assert.equal(slack.apps.size, 1);
  for (const s of plan.voiceflow.steps.filter((s) => s.kind === 'tool')) assert.equal(s.action, 'current', s.name);
  const vfWrites = vf.writes().slice(writesBefore.vf);
  assert.ok(
    vfWrites.every((w) => /secret|compile/.test(w.path)),
    `only the token is written again: ${vfWrites.map((w) => w.path)}`,
  );
});

// ── The app's name and icon ─────────────────────────────────────────────────

const AVATAR = 'https://assets.example.com/1768-agent%20face.png';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const VOICEFLOW_ICON = new Uint8Array(await readFile(new URL('../../core/assets/voiceflow-icon.png', import.meta.url)));
const isVoiceflowIcon = async (file) =>
  file.name === 'voiceflow-icon.png' && file.type === 'image/png' && Buffer.from(await file.arrayBuffer()).equals(VOICEFLOW_ICON);
const withAvatar = (slack = {}) => ({
  project: { ...PROJECT, name: 'Acme Support', image: AVATAR },
  slack: { images: { [AVATAR]: { bytes: PNG_BYTES, type: 'image/png' } }, ...slack },
});

test("an agent's name becomes an app name Slack takes", () => {
  // Each pair checked against Slack's apps.manifest.validate on 2026-11-20.
  for (const [agent, app] of [
    ['[SPIKE] Channel Relay', '(SPIKE) Channel Relay'],
    ['Inventables CX Agent', 'Inventables CX Agent'],
    ['Acme & Co: Support!', 'Acme and Co Support'],
    ['Agent #2 / EU', 'Agent 2 EU'],
    ['Café 🤖 Bot', 'Café Bot'],
    ['{beta} Help, Inc.', '(beta) Help Inc.'],
    ["Mr. A's (new) help_desk", "Mr. A's (new) help_desk"],
    ['🤖🤖', 'Voiceflow agent'],
    ['A very long agent name that goes well past the limit', 'A very long agent name that goes'],
    ['Supercalifragilisticexpialidociousagentname', 'Supercalifragilisticexpialidociousa'],
  ]) {
    assert.equal(appNameOf(agent), app, agent);
    assert.ok(appNameOf(agent).length <= 35);
  }
});

test("a new app takes the agent's name and avatar from Voiceflow", async () => {
  const { slack, progress, options } = setup({ ...withAvatar(), project: { ...PROJECT, name: '[BETA] Acme Support', image: AVATAR } });
  let plan;
  const result = await connectSlack(options({ confirm: (p) => ((plan = p), true) }));
  const app = slack.apps.get('A1');
  assert.equal(app.display_information.name, '(BETA) Acme Support', 'in the characters Slack takes');
  assert.equal(app.features.bot_user.display_name, 'beta-acme-support');
  assert.match(
    plan.lines.join('\n'),
    /\+ set its icon to the agent's avatar in Voiceflow \(Voiceflow's icon if Slack won't take it\): https:\/\/assets\.example\.com\/1768-agent%20face\.png/,
  );
  const [icon] = slack.of('apps.icon.set');
  assert.equal(icon.body.app_id, 'A1');
  assert.equal(icon.token, CLI_TOKEN, "set with the CLI login, like the app's manifest");
  assert.deepEqual(new Uint8Array(await icon.body.file.arrayBuffer()), PNG_BYTES, 'the avatar, as Voiceflow serves it');
  assert.equal(icon.body.file.type, 'image/png');
  assert.equal(icon.body.file.name, '1768-agent face.png');
  assert.ok(progress.includes("+ set the app's icon to the agent's avatar"));
  assert.equal(result.notes, undefined);
  noSecrets(progress.join('\n'));
});

test('a name or icon you give wins, and an app that exists keeps its icon unless you name one', async () => {
  const named = setup(withAvatar());
  await connectSlack(named.options({ app: { name: 'Help & Desk', icon: false } }));
  assert.equal(
    named.slack.apps.get('A1').display_information.name,
    'Help & Desk',
    "a name you give is used as you gave it (Slack's check says if it can't be)",
  );
  assert.equal(named.slack.of('apps.icon.set').length, 0, 'icon: false sets none');
  assert.equal(named.slack.downloads.length, 0);

  const { slack, options } = setup(
    withAvatar({
      images: { [AVATAR]: { bytes: PNG_BYTES, type: 'image/png' }, 'https://cdn.example.com/other.jpg': { bytes: PNG_BYTES, type: 'image/jpeg' } },
    }),
  );
  await connectSlack(options());
  await connectSlack(options());
  assert.equal(slack.of('apps.icon.set').length, 1, 'a second connect leaves the icon alone');
  let plan;
  await connectSlack(options({ app: { icon: 'https://cdn.example.com/other.jpg' }, confirm: (p) => ((plan = p), true) }));
  assert.match(plan.lines.join('\n'), /\+ set its icon to the image: https:\/\/cdn\.example\.com\/other\.jpg/);
  assert.equal(slack.of('apps.icon.set').at(-1).body.file.type, 'image/jpeg');

  const plain = setup({ project: { ...PROJECT, image: null } });
  let plainPlan;
  await connectSlack(plain.options({ confirm: (p) => ((plainPlan = p), true) }));
  assert.match(plainPlan.lines.join('\n'), /\+ set its icon to Voiceflow's icon \(the agent has no avatar in Voiceflow\)/);
  assert.deepEqual(plainPlan.app.icon, { from: 'default' });
  const [standIn] = plain.slack.of('apps.icon.set');
  assert.ok(await isVoiceflowIcon(standIn.body.file), "an agent without an avatar gets Voiceflow's icon");
  assert.equal(plain.slack.downloads.length, 0, 'from the package, not the web');
  assert.ok(plain.progress.includes("+ set the app's icon to Voiceflow's icon"));
  await connectSlack(plain.options());
  assert.equal(plain.slack.of('apps.icon.set').length, 1, 'and an app that exists keeps whatever icon it has');
  const none = setup({ project: { ...PROJECT, image: null } });
  await connectSlack(none.options({ app: { icon: false } }));
  assert.equal(none.slack.of('apps.icon.set').length, 0, "icon: false means none, not Voiceflow's");

  for (const icon of ['ftp://example.com/a.png', 'not a url']) {
    const bad = setup(withAvatar());
    await assert.rejects(connectSlack(bad.options({ app: { icon } })), /must be an image's http\(s\) URL/);
    assert.equal(bad.slack.writes().length, 0, 'nothing changed');
  }

  const dry = setup(withAvatar());
  await connectSlack(dry.options({ confirm: () => false }));
  assert.equal(dry.slack.downloads.length, 0, 'the plan downloads nothing');
});

test("an avatar Slack refuses, or one that won't download, gives way to Voiceflow's icon, and connect says why", async () => {
  // Slack refuses the avatar (too small) and takes Voiceflow's.
  const small = setup(withAvatar({ iconError: (file) => (file.name === 'voiceflow-icon.png' ? undefined : 'invalid_icon_size') }));
  const result = await connectSlack(small.options());
  assert.equal(result.applied, true);
  assert.ok(result.botToken && result.install, 'installed, with its tools');
  assert.equal(
    result.notes[0],
    "Slack didn't take the agent's avatar as the app's icon: Slack takes icons from 512 to 2000 pixels. It has Voiceflow's icon instead; set another in Basic Information, https://api.slack.com/apps/A1/general",
  );
  assert.ok(small.progress.includes(`! ${result.notes[0]}`));
  const tries = small.slack.of('apps.icon.set');
  assert.equal(tries.length, 2);
  assert.ok(await isVoiceflowIcon(tries[1].body.file), "the second try is Voiceflow's icon");

  // An avatar that won't download: Voiceflow's icon, and only that is sent to Slack.
  const gone = setup(withAvatar({ images: {} }));
  const missing = await connectSlack(gone.options());
  assert.match(
    missing.notes[0],
    /^Slack didn't take the agent's avatar as the app's icon: it couldn't be downloaded \(HTTP 404\)\. It has Voiceflow's icon instead/,
  );
  assert.equal(gone.slack.of('apps.icon.set').length, 1);
  assert.ok(await isVoiceflowIcon(gone.slack.of('apps.icon.set')[0].body.file));

  // Slack refuses both: connect still finishes and says so.
  const format = setup(withAvatar({ iconError: 'error_bad_format' }));
  const both = await connectSlack(format.options());
  assert.equal(both.applied, true);
  assert.equal(
    both.notes[0],
    "Slack didn't take the agent's avatar (Slack takes a PNG, JPG or GIF) or Voiceflow's icon (Slack takes a PNG, JPG or GIF) as the app's icon. Set one in Basic Information, https://api.slack.com/apps/A1/general",
  );

  // An icon you named isn't swapped for Voiceflow's: it's yours to fix.
  const named = setup(withAvatar({ images: {} }));
  const yours = await connectSlack(named.options({ app: { icon: 'https://cdn.example.com/mine.png' } }));
  assert.equal(
    yours.notes[0],
    "Slack didn't take the icon as the app's icon: it couldn't be downloaded (HTTP 404). Set one in Basic Information, https://api.slack.com/apps/A1/general",
  );
  assert.equal(named.slack.of('apps.icon.set').length, 0);
});

test("Voiceflow's icon is an image Slack takes", () => {
  // A PNG (Slack takes PNG, JPG or GIF), square, within Slack's 512 to 2000 pixels.
  assert.deepEqual([...VOICEFLOW_ICON.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'a PNG');
  const view = new DataView(VOICEFLOW_ICON.buffer, VOICEFLOW_ICON.byteOffset);
  const [width, height] = [view.getUint32(16), view.getUint32(20)];
  assert.equal(width, height, 'square, so Slack adds no white bars');
  assert.ok(width >= 512 && width <= 2000, `${width} pixels`);
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
  assert.deepEqual(
    slack.writes().map((c) => c.method),
    ['apps.manifest.update', 'apps.developerInstall'],
  );
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

test('user scopes are asked for only when named, and their token comes back in memory', async () => {
  assert.equal(slackManifest({ requestUrl: URL_ }).oauth_config.scopes.user, undefined, 'none by default');
  const { slack, options, progress } = setup();
  let plan;
  const result = await connectSlack(
    options({ tools: false, app: { userScopes: ['chat:write', 'im:history', 'chat:write'] }, confirm: (p) => ((plan = p), true) }),
  );
  assert.match(plan.lines.join('\n'), /and user scopes, so it can act as you: chat:write, im:history/);
  const install = slack.calls.find((c) => c.method === 'apps.developerInstall');
  assert.equal(install.body.user_scopes, 'chat:write,im:history');
  assert.equal(result.userToken, USER_TOKEN);
  noSecrets(progress.join('\n'));
  noSecrets(JSON.stringify(result.plan));
  // Without them, the install asks for none and no user token comes back.
  const plain = setup();
  const none = await connectSlack(plain.options({ tools: false }));
  assert.equal(plain.slack.calls.find((c) => c.method === 'apps.developerInstall').body.user_scopes, undefined);
  assert.equal(none.userToken, undefined);
  // Merging adds them to an app you have, and says so.
  const { manifest, changes } = mergeManifest(slackManifest({ requestUrl: URL_ }), slackManifest({ requestUrl: URL_, userScopes: ['chat:write'] }));
  assert.deepEqual(manifest.oauth_config.scopes.user, ['chat:write']);
  assert.deepEqual(changes.userScopesAdded, ['chat:write']);
});

test('an expired Slack CLI login says how to refresh it', async () => {
  const { options } = setup();
  await assert.rejects(connectSlack(options({ slack: { token: 'xoxp-expired', fetch: fakeSlack().fetch } })), /slack auth list/);
});

// ── Disconnecting ───────────────────────────────────────────────────────────

test("disconnect deletes the app and leaves the tools, which are the agent's now", async () => {
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

test('the secrets never go into a file someone else can read: the env file is replaced, not rewritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vf-connect-'));
  const file = join(dir, '.env.local');
  await writeFile(file, 'OTHER=1\n', { mode: 0o644 });
  const before = await stat(file);
  await writeEnvFile(file, { SLACK_BOT_TOKEN: BOT_TOKEN });
  const after = await stat(file);
  assert.notEqual(after.ino, before.ino, 'a new file, readable only by you from the start');
  assert.equal(after.mode & 0o777, 0o600);
  assert.equal(await readFile(file, 'utf8'), `OTHER=1\nSLACK_BOT_TOKEN=${BOT_TOKEN}\n`);
  assert.deepEqual(await readdir(dir), ['.env.local'], 'no temporary file is left behind');
});

/** A terminal: keystrokes in, what it would show out. */
function terminal(columns = 20) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.modes = [];
  input.setRawMode = (mode) => {
    input.modes.push(mode);
    input.isRaw = mode;
    return input;
  };
  const screen = { text: '' };
  const output = new Writable({
    write(chunk, _encoding, done) {
      screen.text += chunk;
      done();
    },
  });
  output.isTTY = true;
  output.columns = columns;
  return { input, output, screen };
}

test('the hidden prompt shows nothing typed, even when a backspace or a wrap would redraw the line', async () => {
  const { input, output, screen } = terminal(20);
  const key = 'VF.DM.0123456789abcdefghijklmnopqrstuvwxyz';
  const answer = hidden('API key: ', input, output);
  for (const ch of key) input.write(ch);
  input.write('\x7f'); // a backspace
  input.write('\x1b[D'); // the left arrow
  input.write('Z\r');
  assert.equal(await answer, `${key.slice(0, -1)}Z`);
  assert.equal(screen.text, 'API key: \n', 'the prompt, then the line ending: nothing typed');
  assert.deepEqual(input.modes, [true, false], 'the terminal is back as it was');
});

test('Ctrl-C at the hidden prompt cancels', async () => {
  const { input, output } = terminal();
  const answer = hidden('API key: ', input, output);
  input.write('abc\x03');
  await assert.rejects(answer, /Cancelled/);
  assert.deepEqual(input.modes, [true, false]);
});

test("the URL checker answers Slack's challenge and nothing else", async () => {
  const port = 38000 + Math.floor(Math.random() * 1000);
  const checker = await urlChecker(port);
  try {
    const challenge = await fetch(`http://127.0.0.1:${port}/api/slack`, {
      method: 'POST',
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc' }),
    });
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

// ── What the command prints ─────────────────────────────────────────────────

/**
 * Runs the command as a terminal would, against the fakes, in a folder of its
 * own. `voiceflow(url, init)` can answer a call itself; `files` are written
 * there first; `answers` are what a person types, by question, and with none
 * the command runs as a script does, where a question is a failure.
 */
async function runCli(
  t,
  argv,
  { slack = fakeSlack(), voiceflow, env = { VOICEFLOW_API_KEY: VF_KEY }, files = {}, answers, slackCli, draft = [], vf: given, tunnel } = {},
) {
  // `draft`: what the environment's draft holds already, that nobody published. `vf`: an agent from an earlier run.
  const vf = given ?? fakeVoiceflowApi({ project: PROJECT, apiKey: VF_KEY });
  vf.state.draft.push(...draft);
  const dir = await mkdtemp(join(tmpdir(), 'vf-cli-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, { mode: 0o644 });
  const before = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(before));
  const out = [];
  const err = [];
  const asked = [];
  const answer = (kind) => async (question) => {
    asked.push(`${kind}: ${question}`);
    const match = Object.entries(answers ?? {}).find(([part]) => question.includes(part));
    if (!match) throw new Error(`asked "${question}" with no answer to give`);
    return match[1];
  };
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://slack.com/api/')) return slack.fetch(url, init);
    return (await voiceflow?.(String(url), init)) ?? vf.fetch(url, init);
  };
  const code = await cli(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(slackCli ? { slackCli } : { login: () => ({ teamId: 'T1', token: CLI_TOKEN }) }),
    // No test opens a real tunnel: a machine without cloudflared, unless the test brings one.
    tunnel: tunnel ?? { platform: 'linux', find: () => undefined },
    env,
    fetch,
    interactive: Boolean(answers),
    ask: answer('asked'),
    secret: answer('asked unseen'),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), slack, vf, dir, asked };
}
/** The command with only the server's address and its env file: what the starter's connect script runs. */
const FROM_FILE = ['connect', '--public-url', 'https://bot.example.com', '--port', '0', '--yes', '--env-file', '.env.local'];
const CONNECT = ['connect', '--project', 'proj1', '--environment', 'sdk-test', '--public-url', 'https://bot.example.com', '--port', '0', '--yes'];
/** No part of a secret long enough to matter: a cut error could leave most of one. */
const noPartOf = (text, secret) => {
  for (let length = 8; length <= secret.length; length++)
    assert.ok(!text.includes(secret.slice(0, length)), `the first ${length} characters of a secret are in: ${text.slice(0, 200)}`);
};

test("Slack's app API repeating the login back never puts it in the error, even where the error is cut", async () => {
  for (const pad of [0, 560, 590]) {
    const api = createSlackApi({
      token: CLI_TOKEN,
      fetch: async () => Response.json({ ok: false, error: 'invalid_arguments', errors: [{ message: `${'x'.repeat(pad)} bad token ${CLI_TOKEN}` }] }),
    });
    await assert.rejects(api('apps.manifest.validate', {}), (error) => {
      assert.match(error.message, /^apps\.manifest\.validate: invalid_arguments/);
      noPartOf(error.message, CLI_TOKEN);
      noPartOf(JSON.stringify(error.details), CLI_TOKEN);
      return true;
    });
  }
  // A token given for one call is cleaned the same way.
  const api = createSlackApi({ token: CLI_TOKEN, fetch: async () => Response.json({ ok: false, error: `not_allowed_token_type ${BOT_TOKEN}` }) });
  await assert.rejects(api('auth.test', {}, { token: BOT_TOKEN }), (error) => (noPartOf(error.message, BOT_TOKEN), true));
});

test('the command prints its plan and its result without a secret, and saves the credentials only where asked', async (t) => {
  const { code, out, err, dir } = await runCli(t, [...CONNECT, '--env-file', '.env.local']);
  assert.equal(code, 0, err);
  assert.match(out, /\+ create app "Spike" from the manifest/);
  assert.match(out, /Connected: Slack app A1, bot user UBOT\./);
  assert.match(out, /SLACK_BOT_TOKEN {7}in \.env\.local/);
  noSecrets(out);
  noSecrets(err);
  const saved = await readFile(join(dir, '.env.local'), 'utf8');
  assert.match(saved, new RegExp(`^SLACK_SIGNING_SECRET=${SIGNING}$`, 'm'));
  assert.match(saved, new RegExp(`^SLACK_BOT_TOKEN=${BOT_TOKEN}$`, 'm'));
});

test('an error the command prints never carries a secret it holds, whichever server repeats one back', async (t) => {
  // Voiceflow refuses the first read, quoting the API key it was sent.
  const badKey = await runCli(t, CONNECT, {
    voiceflow: (url) =>
      url.includes('/v1/stable/project/') ? new Response(JSON.stringify({ message: `No access with key ${VF_KEY}` }), { status: 401 }) : undefined,
  });
  assert.equal(badKey.code, 1, 'it fails with an exit code, not a thrown error');
  assert.match(badKey.err, /answered 401: No access with key \[hidden\]/);
  noSecrets(badKey.err + badKey.out);
  assert.deepEqual(badKey.slack.writes(), [], 'and nothing was changed');

  // Slack refuses the manifest check, quoting the login.
  const slack = fakeSlack();
  const real = slack.fetch;
  slack.fetch = async (url, init) =>
    String(url).endsWith('/apps.manifest.validate')
      ? Response.json({ ok: false, error: 'not_allowed', errors: [{ message: `token ${CLI_TOKEN} can't do this` }] })
      : real(url, init);
  const badLogin = await runCli(t, CONNECT, { slack });
  assert.equal(badLogin.code, 1);
  assert.match(badLogin.err, /apps\.manifest\.validate: not_allowed/);
  noSecrets(badLogin.err + badLogin.out);

  // After the app is installed, a write to Voiceflow fails with text that holds the new app's
  // token and signing secret: the command has had them for a moment, and hides them already.
  const late = await runCli(t, CONNECT, {
    voiceflow: (url, init) =>
      url.includes('/v1/stable/function') && init.method === 'POST'
        ? new Response(JSON.stringify({ message: `rejected: ${BOT_TOKEN} / ${SIGNING} / ${encodeURIComponent(VF_KEY)}` }), { status: 500 })
        : undefined,
  });
  assert.equal(late.code, 1);
  assert.match(late.err, /answered 500: rejected: \[hidden\] \/ \[hidden\] \/ \[hidden\]/);
  noSecrets(late.err + late.out);
  assert.match(late.out, /\+ installed it in Example: bot user UBOT/, 'what it did before failing is still shown');
});

test('a mistake in the command line is an answer and an exit code, never a stack trace', async (t) => {
  // A script that doesn't say which environment is waiting on someone who knows: that's a 3, not a mistake.
  const missing = await runCli(t, ['connect', '--project', 'proj1']);
  assert.equal(missing.code, 3);
  assert.match(missing.err, /No Voiceflow environment: set VOICEFLOW_ENVIRONMENT or pass --environment \(development, say\)\./);
  // A person who was asked and answered nothing made a mistake.
  const blank = await runCli(t, ['connect', '--project', 'proj1'], { answers: { environment: '  ' } });
  assert.equal(blank.code, 2);
  assert.match(blank.err, /Missing --environment \(or VOICEFLOW_ENVIRONMENT\)\./);
  // An address is connect's to find, with a tunnel. To point, and for an app you made, it's yours to give.
  const nowhere = await runCli(t, ['point', '--project', 'proj1', '--environment', 'sdk-test']);
  assert.equal(nowhere.code, 2);
  assert.match(nowhere.err, /Missing --public-url: your server's public address/);
  const whose = await runCli(t, ['connect', '--manual', '--project', 'proj1', '--environment', 'sdk-test']);
  assert.equal(whose.code, 2);
  assert.match(whose.err, /Missing --public-url: the address your app's settings point at/);
  const unknown = await runCli(t, ['connect', '--no-such-flag']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no-such-flag/);
  const help = await runCli(t, ['connect', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /^Usage:/);
});

// ── The server's env file ───────────────────────────────────────────────────

test("connect takes the agent from the server's env file, so nothing is typed twice", async (t) => {
  const { code, out, err, dir, asked, vf } = await runCli(t, FROM_FILE, {
    env: {},
    files: { '.env.local': `# mine\nOTHER=1\nVOICEFLOW_API_KEY=${VF_KEY}\nexport VOICEFLOW_PROJECT_ID="proj1"\nVOICEFLOW_ENVIRONMENT=sdk-test # the draft\n` },
  });
  assert.equal(code, 0, err);
  assert.deepEqual(asked, [], 'nothing was asked');
  assert.match(out, /Voiceflow: project "Spike" \(proj1\) in workspace ws1, environment sdk-test/);
  assert.deepEqual(vf.state.compiles, ['sdk-test']);
  assert.match(out, /VOICEFLOW_API_KEY {5}in \.env\.local/);
  assert.doesNotMatch(out, /\+ saved/, "what's there already isn't written again");
  noSecrets(out + err);

  const saved = await readFile(join(dir, '.env.local'), 'utf8');
  assert.match(saved, /^# mine\nOTHER=1\n/, 'your own lines stay');
  assert.match(saved, /^export VOICEFLOW_PROJECT_ID="proj1"$/m, 'and so does how you wrote them');
  assert.match(saved, new RegExp(`^SLACK_BOT_TOKEN=${BOT_TOKEN}$`, 'm'));
  assert.match(saved, new RegExp(`^SLACK_SIGNING_SECRET=${SIGNING}$`, 'm'));
  assert.equal((await stat(join(dir, '.env.local'))).mode & 0o777, 0o600, 'readable only by you, once it holds a secret');
});

test("what the env file doesn't say is asked for, the key unseen, and saved there; what it says is never changed", async (t) => {
  const { code, out, err, dir, asked } = await runCli(t, [...FROM_FILE, '--no-publish'], {
    env: {},
    files: { '.env.local': 'VOICEFLOW_API_KEY=\nVOICEFLOW_PROJECT_ID=\nVOICEFLOW_ENVIRONMENT=sdk-test\n' },
    answers: { 'API key': VF_KEY, 'project ID': 'proj1' },
  });
  assert.equal(code, 0, err);
  assert.deepEqual(asked, ['asked: Voiceflow project ID: ', 'asked unseen: Voiceflow API key (hidden): ']);
  assert.match(out, /\+ saved VOICEFLOW_API_KEY, VOICEFLOW_PROJECT_ID to \.env\.local/);
  noSecrets(out + err);
  const saved = await readEnvFile(join(dir, '.env.local'));
  assert.deepEqual(
    { key: saved.VOICEFLOW_API_KEY, project: saved.VOICEFLOW_PROJECT_ID, environment: saved.VOICEFLOW_ENVIRONMENT, bot: saved.SLACK_BOT_TOKEN },
    { key: VF_KEY, project: 'proj1', environment: 'sdk-test', bot: BOT_TOKEN },
  );

  // A flag says which environment for this run. The file's own value is yours, and stays.
  const flagged = await runCli(t, [...FROM_FILE, '--environment', 'sdk-test'], {
    env: {},
    files: { '.env.local': `VOICEFLOW_API_KEY=${VF_KEY}\nVOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=production\n` },
  });
  assert.equal(flagged.code, 0, flagged.err);
  assert.deepEqual(flagged.vf.state.compiles, ['sdk-test']);
  assert.equal((await readEnvFile(join(flagged.dir, '.env.local'))).VOICEFLOW_ENVIRONMENT, 'production');

  // The environment's own key wins over the file's.
  const fromEnv = await runCli(t, FROM_FILE, {
    env: { VOICEFLOW_API_KEY: VF_KEY },
    files: { '.env.local': 'VOICEFLOW_API_KEY=VF.DM.an-old-key-in-the-file\nVOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n' },
  });
  assert.equal(fromEnv.code, 0, fromEnv.err);
  assert.equal((await readEnvFile(join(fromEnv.dir, '.env.local'))).VOICEFLOW_API_KEY, 'VF.DM.an-old-key-in-the-file', 'and the file is left as it was');

  // A key connect was given, not asked for, stays where you keep it: it isn't copied into the file.
  const given = await runCli(t, FROM_FILE, {
    env: { VOICEFLOW_API_KEY: VF_KEY },
    files: { '.env.local': 'VOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n' },
  });
  assert.equal(given.code, 0, given.err);
  assert.equal((await readEnvFile(join(given.dir, '.env.local'))).VOICEFLOW_API_KEY, undefined);
  assert.match(given.out, /VOICEFLOW_API_KEY {5}your Voiceflow API key/);
  assert.doesNotMatch(given.out, /\+ saved/);
});

test('a key typed for a plan that is only shown is saved nowhere', async (t) => {
  const { code, out, dir } = await runCli(t, [...FROM_FILE, '--dry-run'], {
    env: {},
    files: { '.env.local': 'VOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n' },
    answers: { 'API key': VF_KEY },
  });
  assert.equal(code, 0);
  assert.match(out, /\+ create app "Spike"/);
  assert.equal(await readFile(join(dir, '.env.local'), 'utf8'), 'VOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n');
});

test("a script with nothing to go on is told what's missing, by name, and is asked nothing", async (t) => {
  // Which agent, and its key: all of it in the one stop, so whoever ran this hands it over once.
  const nothing = await runCli(t, FROM_FILE, { env: {} });
  assert.equal(nothing.code, 3, 'waiting on a person');
  assert.equal(
    nothing.err,
    [
      "No Voiceflow project: set VOICEFLOW_PROJECT_ID, here or in .env.local, or pass --project. It's your agent's project ID in Voiceflow.",
      'No Voiceflow environment: set VOICEFLOW_ENVIRONMENT, here or in .env.local, or pass --environment (development, say).',
      'No Voiceflow API key: set VOICEFLOW_API_KEY, here or in .env.local, or pass --key-file.',
    ].join('\n\n'),
  );
  assert.deepEqual(nothing.asked, []);
  assert.deepEqual(nothing.slack.calls, [], 'and nothing was called');

  const noKey = await runCli(t, FROM_FILE, { env: { VOICEFLOW_PROJECT_ID: 'proj1', VOICEFLOW_ENVIRONMENT: 'sdk-test' } });
  assert.equal(noKey.code, 3, 'waiting on a person, not a failure');
  assert.match(noKey.err, /No Voiceflow API key: set VOICEFLOW_API_KEY, here or in \.env\.local, or pass --key-file\./);
  assert.deepEqual(noKey.asked, []);
});

test('an env file is read as servers read one: export, quotes and comments, and a missing file is an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vf-env-'));
  const file = join(dir, '.env');
  await writeFile(
    file,
    [
      '# a comment',
      '',
      'PLAIN=one',
      'export EXPORTED=two',
      'QUOTED="three # not a comment"',
      "SINGLE='four'",
      'TRAILING=five # a comment',
      'EMPTY=',
      'SPACED = six',
      'not a line',
      '=nothing',
    ].join('\n'),
  );
  assert.deepEqual(await readEnvFile(file), {
    PLAIN: 'one',
    EXPORTED: 'two',
    QUOTED: 'three # not a comment',
    SINGLE: 'four',
    TRAILING: 'five',
    EMPTY: '',
    SPACED: 'six',
  });
  assert.deepEqual(await readEnvFile(join(dir, 'none')), {});
});

test('a person is asked only once the command can go ahead, and their answer to the plan decides', async (t) => {
  // No address to point at: that's said first, before any question.
  const noUrl = await runCli(t, ['point', '--env-file', '.env.local'], { env: {}, answers: {} });
  assert.equal(noUrl.code, 2);
  assert.match(noUrl.err, /Missing --public-url/);
  assert.deepEqual(noUrl.asked, []);

  const files = { '.env.local': `VOICEFLOW_API_KEY=${VF_KEY}\nVOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n` };
  const ask = [...FROM_FILE.filter((arg) => arg !== '--yes'), '--no-publish'];
  const no = await runCli(t, ask, { env: {}, files, answers: { 'Go ahead': 'n' } });
  assert.equal(no.code, 0);
  assert.deepEqual(no.asked, ['asked: \nGo ahead? [y/N] ']);
  assert.equal(no.slack.calls.filter((call) => call.method === 'apps.manifest.create').length, 0, 'no app was made');
  assert.equal(await readFile(join(no.dir, '.env.local'), 'utf8'), files['.env.local']);

  const yes = await runCli(t, ask, { env: {}, files, answers: { 'Go ahead': ' Y ' } });
  assert.equal(yes.code, 0, yes.err);
  assert.match(yes.out, /Connected: Slack app/);

  // With nobody to ask, and no --yes, it shows the plan and changes nothing.
  const script = await runCli(t, ask, { env: {}, files });
  assert.equal(script.code, 0);
  assert.match(script.err, /Nothing was changed: run it again with --yes/);
  assert.deepEqual(script.asked, []);
});

test('a value an env file would read back differently is left for you to write', async (t) => {
  const { code, out, err, dir } = await runCli(t, [...FROM_FILE, '--project', 'proj1', '--environment', 'my env #2'], {
    env: {},
    files: { '.env.local': `VOICEFLOW_API_KEY=${VF_KEY}\n` },
  });
  assert.equal(code, 0, err);
  assert.match(out, /\+ saved VOICEFLOW_PROJECT_ID to \.env\.local/);
  assert.match(err, /! VOICEFLOW_ENVIRONMENT wasn't saved to \.env\.local: its value needs quoting there\. Add it yourself\./);
  const saved = await readEnvFile(join(dir, '.env.local'));
  assert.equal(saved.VOICEFLOW_ENVIRONMENT, undefined);
  assert.equal(saved.VOICEFLOW_PROJECT_ID, 'proj1');
});

// ── Signing in to Slack ─────────────────────────────────────────────────────

/** A machine's Slack CLI for the command: no login until the ticket's code is given, then one. */
async function slackCliOf({ cli = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vf-slackcli-'));
  const credentialsFile = join(dir, 'credentials.json');
  const ran = [];
  return {
    ran,
    host: {
      credentialsFile,
      platform: 'linux',
      find: () => (cli ? '/fake/bin/slack' : undefined),
      run: async (_command, args, { show }) => {
        const line = args.filter((arg) => arg !== '--skip-update').join(' ');
        ran.push({ line, show });
        if (line === 'login --no-prompt') return { code: 0, output: 'Run the following slash command\n\n/slackauthticket TICKET1\n' };
        if (line === 'login --no-prompt --ticket TICKET1 --challenge CODE1') {
          await writeFile(credentialsFile, JSON.stringify({ T1: { token: CLI_TOKEN, team_domain: 'example' } }));
          return { code: 0, output: '' };
        }
        return { code: 1, output: 'Error: invalid challenge code' };
      },
    },
  };
}

test('with nobody at the terminal, one stop says everything a person has to do, and the ticket and code carry it on', async (t) => {
  const cli = await slackCliOf();
  const files = { '.env.local': 'VOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n' };
  const stopped = await runCli(t, FROM_FILE, { env: {}, files, slackCli: cli.host });
  assert.equal(stopped.code, 3, 'waiting on a person');
  assert.match(stopped.err, /\/slackauthticket TICKET1/);
  assert.match(stopped.err, /--slack-ticket TICKET1 --slack-code <the code>/);
  assert.match(stopped.err, /No Voiceflow API key: set VOICEFLOW_API_KEY, here or in \.env\.local/, 'the key too, in the same stop');
  assert.deepEqual(stopped.asked, []);
  assert.deepEqual(stopped.slack.calls, [], 'and Slack was not called');
  assert.deepEqual(cli.ran, [{ line: 'login --no-prompt', show: false }]);

  const done = await runCli(t, [...FROM_FILE, '--slack-ticket', 'TICKET1', '--slack-code', 'CODE1'], {
    env: { VOICEFLOW_API_KEY: VF_KEY },
    files,
    slackCli: cli.host,
  });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /Connected: Slack app A1, bot user UBOT\./);
  noSecrets(done.out + done.err);

  const wrong = await runCli(t, [...FROM_FILE, '--slack-ticket', 'TICKET1', '--slack-code', 'NOPE'], {
    env: { VOICEFLOW_API_KEY: VF_KEY },
    files,
    slackCli: (await slackCliOf()).host,
  });
  assert.equal(wrong.code, 1, 'a code Slack refuses is a failure, not a wait');
  assert.match(wrong.err, /Slack didn't take that code/);
});

test('without the Slack CLI, a script is told how to get it, and how to go on without it', async (t) => {
  const { code, err, slack } = await runCli(t, FROM_FILE, {
    files: { '.env.local': 'VOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n' },
    slackCli: (await slackCliOf({ cli: false })).host,
  });
  assert.equal(code, 3);
  assert.match(err, /curl -fsSL https:\/\/downloads\.slack-edge\.com\/slack-cli\/install\.sh \| bash/);
  assert.match(err, /For a Slack app you made by hand, run this with --manual instead\./);
  assert.deepEqual(slack.calls, []);
});

// ── An app you made by hand ─────────────────────────────────────────────────

/** A machine with no Slack CLI, where running anything is a failure of the test. */
const NO_CLI = {
  credentialsFile: '/nonexistent/credentials.json',
  platform: 'linux',
  find: () => undefined,
  run: async () => {
    throw new Error('--manual ran a command');
  },
};
const MANUAL = [...FROM_FILE, '--manual'];
const NEEDED = slackManifest({ requestUrl: 'https://bot.example.com/api/slack', tools: {} }).oauth_config.scopes.bot;
const OWN = `VOICEFLOW_API_KEY=${VF_KEY}\nVOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\nSLACK_BOT_TOKEN=${BOT_TOKEN}\nSLACK_SIGNING_SECRET=${SIGNING}\n`;

test('--manual connects an app you made by hand: the tools go on the agent, and nothing in Slack is changed', async (t) => {
  const slack = fakeSlack({ botScopes: NEEDED });
  const { code, out, err, vf, dir } = await runCli(t, MANUAL, { env: {}, files: { '.env.local': OWN }, slack, slackCli: NO_CLI });
  assert.equal(code, 0, err);
  assert.match(out, /Slack: your own app in workspace Example \(T1\), bot user UBOT \(connect changes nothing in it\)/);
  assert.match(out, new RegExp(`= it has every scope this package uses \\(${NEEDED.length}\\)`));
  assert.match(
    out,
    /each pointed at https:\/\/bot\.example\.com\/api\/slack:\n {6}Event Subscriptions > Request URL\n {6}Interactivity & Shortcuts > Request URL\n {6}Slash Commands > \/ask > Request URL/,
  );
  assert.match(out, /Voiceflow: project "Spike" \(proj1\) in workspace ws1, environment sdk-test/);
  assert.match(out, /Connected the agent to your Slack app: bot user UBOT in Example\./);
  assert.match(out, /SLACK_BOT_TOKEN {7}in \.env\.local\n {2}SLACK_SIGNING_SECRET {2}in \.env\.local\n {2}VOICEFLOW_API_KEY {5}in \.env\.local/);
  assert.match(out, /Slack sends to https:\/\/bot\.example\.com\/api\/slack, once the app's settings say so\./);
  noSecrets(out + err);

  assert.deepEqual(vf.state.compiles, ['sdk-test'], 'the tools were installed');
  assert.deepEqual(
    slack.calls.map((c) => c.method),
    ['auth.test'],
    'Slack was asked who the bot is, and nothing else',
  );
  assert.equal(slack.calls[0].token, BOT_TOKEN, 'with the bot token: no Slack CLI login is used');
  assert.equal(await readFile(join(dir, '.env.local'), 'utf8'), OWN, 'the env file is as it was');

  // Credentials given in the environment stay there: they aren't copied to the file, or said to be in it.
  const agent = `VOICEFLOW_API_KEY=${VF_KEY}\nVOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n`;
  const given = await runCli(t, MANUAL, {
    env: { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_SIGNING_SECRET: SIGNING },
    files: { '.env.local': agent },
    slack: fakeSlack({ botScopes: NEEDED }),
    slackCli: NO_CLI,
  });
  assert.equal(given.code, 0, given.err);
  assert.match(
    given.out,
    /SLACK_BOT_TOKEN {7}the Bot User OAuth Token you gave\n {2}SLACK_SIGNING_SECRET {2}the Signing Secret you gave\n {2}VOICEFLOW_API_KEY {5}in \.env\.local/,
  );
  assert.equal(await readFile(join(given.dir, '.env.local'), 'utf8'), agent);
  noSecrets(given.out + given.err);
});

test("--manual names the scopes the app wasn't granted, and still connects", async (t) => {
  const granted = NEEDED.filter((scope) => !['reactions:write', 'pins:write'].includes(scope));
  const { code, out, err } = await runCli(t, MANUAL, { env: {}, files: { '.env.local': OWN }, slack: fakeSlack({ botScopes: granted }), slackCli: NO_CLI });
  assert.equal(code, 0, err);
  assert.match(
    out,
    /! it wasn't granted 2 scopes this package uses: (reactions:write, pins:write|pins:write, reactions:write)\n {4}add them under OAuth & Permissions, then reinstall the app/,
  );
  assert.doesNotMatch(out, /it has every scope/);

  // Slack saying nothing of the scopes isn't read as the app having none.
  const silent = await runCli(t, MANUAL, { env: {}, files: { '.env.local': OWN }, slackCli: NO_CLI });
  assert.equal(silent.code, 0, silent.err);
  assert.match(silent.out, /Slack didn't say which scopes the app has/);
  assert.doesNotMatch(silent.out, /wasn't granted/);
});

test("--manual asks for the app's two credentials, unseen, and saves them; a script is told to set them", async (t) => {
  const agent = `VOICEFLOW_API_KEY=${VF_KEY}\nVOICEFLOW_PROJECT_ID=proj1\nVOICEFLOW_ENVIRONMENT=sdk-test\n`;
  const asked = await runCli(t, [...MANUAL, '--no-publish'], {
    env: {},
    files: { '.env.local': agent },
    slack: fakeSlack({ botScopes: NEEDED }),
    slackCli: NO_CLI,
    answers: { 'Bot User OAuth Token': BOT_TOKEN, 'Signing Secret': SIGNING },
  });
  assert.equal(asked.code, 0, asked.err);
  assert.equal(asked.asked.length, 2);
  assert.ok(
    asked.asked.every((question) => question.startsWith('asked unseen: ')),
    'both in hidden prompts',
  );
  assert.match(asked.out, /\+ saved SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET to \.env\.local/);
  noSecrets(asked.out + asked.err);
  const saved = await readEnvFile(join(asked.dir, '.env.local'));
  assert.deepEqual({ bot: saved.SLACK_BOT_TOKEN, secret: saved.SLACK_SIGNING_SECRET }, { bot: BOT_TOKEN, secret: SIGNING });

  const script = await runCli(t, MANUAL, { env: {}, files: { '.env.local': `${agent}SLACK_BOT_TOKEN=${BOT_TOKEN}\n` }, slackCli: NO_CLI });
  assert.equal(script.code, 3);
  assert.match(
    script.err,
    /--manual works with the Slack app you made\. Set SLACK_SIGNING_SECRET \(Basic Information > Signing Secret\), here or in \.env\.local/,
  );
  assert.doesNotMatch(script.err, /SLACK_BOT_TOKEN/, "what's there isn't asked for");
  assert.deepEqual(script.slack.calls, []);
  assert.deepEqual(script.vf.state.compiles, []);
});

test('--manual refuses a token that is no bot, and one Slack refuses, without changing the agent or showing the token', async (t) => {
  const asUser = OWN.replace(BOT_TOKEN, USER_TOKEN);
  const user = await runCli(t, MANUAL, { env: {}, files: { '.env.local': asUser }, slackCli: NO_CLI });
  assert.equal(user.code, 1);
  assert.match(user.err, /SLACK_BOT_TOKEN isn't a bot's token\. Use the Bot User OAuth Token/);
  assert.deepEqual(user.vf.state.compiles, []);
  noSecrets(user.out + user.err);

  const dead = await runCli(t, MANUAL, { env: {}, files: { '.env.local': OWN.replace(BOT_TOKEN, 'xoxb-a-revoked-token-0000') }, slackCli: NO_CLI });
  assert.equal(dead.code, 1);
  assert.match(dead.err, /Slack doesn't take SLACK_BOT_TOKEN \(invalid_auth\)/);
  assert.doesNotMatch(dead.out + dead.err, /xoxb-a-revoked-token-0000/);
  assert.deepEqual(dead.vf.state.compiles, []);

  // A dry run shows the plan and installs nothing; disconnect has no --manual.
  const dry = await runCli(t, [...MANUAL, '--dry-run'], { env: {}, files: { '.env.local': OWN }, slack: fakeSlack({ botScopes: NEEDED }), slackCli: NO_CLI });
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Slack: your own app/);
  assert.deepEqual(dry.vf.state.compiles, []);
  const disconnect = await runCli(t, ['disconnect', '--manual', '--project', 'proj1', '--environment', 'sdk-test'], { slackCli: NO_CLI });
  assert.equal(disconnect.code, 2);
  assert.match(disconnect.err, /--manual is for connect and point/);
});

// ── Publishing, and the app's first message ─────────────────────────────────

/** The command as a person runs it: no --yes, so the plan and the publish are theirs to answer. */
const ASKED = CONNECT.filter((arg) => arg !== '--yes');
const greetings = (slack) => slack.of('chat.postMessage');
const AGENTS_OWN = { type: 'agent', id: 'agent1', name: 'Support', change: 'updated' };

test("connect shows what the draft holds, publishes on your yes, and the new app's bot tells you in Slack", async (t) => {
  const { code, out, err, vf, slack, asked } = await runCli(t, ASKED, { answers: { 'Go ahead': 'y', 'Publish sdk-test now': 'y' }, draft: [AGENTS_OWN] });
  assert.equal(code, 0, err);
  // The plan says what comes after it.
  assert.match(
    out,
    /Then:\n {2}\? you're shown what sdk-test's draft holds, and asked whether to publish it\n {2}\+ the bot messages you in Slack to say it's connected/,
  );
  // What else would go live is shown before the question: a change of your own, not only connect's.
  const shown = out.indexOf("sdk-test's draft holds");
  assert.ok(shown > 0 && shown < out.indexOf('+ published sdk-test'), 'the draft is shown before anything is published');
  assert.match(out, /sdk-test's draft holds \d+ changes that aren't live \(\d+ created, 1 updated\):\n {2}~ agent Support/);
  assert.equal(asked.at(-1), 'asked: \nPublish sdk-test now? Its whole draft goes live, not only these tools. [y/N] ');
  assert.deepEqual(
    vf.state.publishes.map((p) => `${p.environment}: ${p.name}`),
    ['sdk-test: Slack tools (ChannelKit)'],
  );
  assert.match(out, /\+ published sdk-test \(release "Slack tools \(ChannelKit\)"\)/);
  assert.match(out, /sdk-test is published: the agent in Slack has the tools now\./);
  assert.doesNotMatch(out, /only once you publish/);

  // The bot says so itself, to the person who connected it, with its own token.
  const [greeting] = greetings(slack);
  assert.equal(greetings(slack).length, 1);
  assert.equal(greeting.token, BOT_TOKEN);
  assert.equal(greeting.body.channel, 'UME');
  assert.equal(greeting.body.text, 'Spike is connected to Example. Once your server is running, message me here or mention me in a channel.');
  assert.match(out, /\+ Spike messaged you in Slack: look for it under Apps/);
  noSecrets(out + err);
});

test('a no leaves the environment unpublished, and the bot says what it is still waiting for', async (t) => {
  const { code, out, vf, slack } = await runCli(t, ASKED, { answers: { 'Go ahead': 'y', 'Publish sdk-test now': 'n' } });
  assert.equal(code, 0);
  assert.deepEqual(vf.state.publishes, []);
  assert.match(out, /sdk-test is not published\./);
  assert.match(out, /the agent in Slack has them only once you publish sdk-test: in Voiceflow, or with --publish\./);
  assert.match(greetings(slack)[0].body.text, /I get my Slack tools when the sdk-test environment is published in Voiceflow\.$/);
});

test("nothing is published for a script that didn't ask, and --publish is how it asks", async (t) => {
  const script = await runCli(t, CONNECT, { draft: [AGENTS_OWN] });
  assert.equal(script.code, 0, script.err);
  assert.deepEqual(script.vf.state.publishes, []);
  assert.ok(!script.vf.state.calls.some((c) => c.path.endsWith('/publish')));
  assert.match(script.out, /Then:\n {2}· you're shown what sdk-test's draft holds; it is published only with --publish/);
  // It is told what's waiting, to decide with: an agent can pass that on.
  assert.match(script.out, /sdk-test's draft holds \d+ changes that aren't live[^\n]*\n {2}~ agent Support/);
  assert.match(script.out, /sdk-test is not published: run this again with --publish, or publish it in Voiceflow\./);
  assert.match(script.out, /only once you publish sdk-test/);
  assert.deepEqual(script.asked, []);

  const flagged = await runCli(t, [...CONNECT, '--publish'], { draft: [AGENTS_OWN] });
  assert.equal(flagged.code, 0, flagged.err);
  assert.match(flagged.out, /Then:\n {2}\+ publish sdk-test: its whole draft goes live \(--publish\)/);
  assert.match(flagged.out, /~ agent Support/, 'what goes live is still shown');
  assert.equal(flagged.vf.state.publishes.length, 1);
  assert.deepEqual(flagged.asked, []);

  // A plan only shown publishes nothing, whatever the flag.
  const dry = await runCli(t, [...CONNECT, '--publish', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /\+ publish sdk-test: its whole draft goes live \(--publish\)/);
  assert.deepEqual(dry.vf.state.publishes, []);
  assert.deepEqual(greetings(dry.slack), []);

  const both = await runCli(t, [...CONNECT, '--publish', '--no-publish']);
  assert.equal(both.code, 2);
  assert.match(both.err, /--publish and --no-publish say opposite things/);
  assert.deepEqual(both.slack.calls, []);
});

test("--no-publish and --no-greeting are taken at their word: you aren't asked, and the bot stays quiet", async (t) => {
  const { code, out, vf, slack, asked } = await runCli(t, [...ASKED, '--no-publish', '--no-greeting'], { answers: { 'Go ahead': 'y' } });
  assert.equal(code, 0);
  assert.deepEqual(asked, ['asked: \nGo ahead? [y/N] ']);
  assert.deepEqual(vf.state.publishes, []);
  assert.deepEqual(greetings(slack), []);
  assert.match(out, /Then:\n {2}· you're shown what sdk-test's draft holds; it is not published \(--no-publish\)/);
  assert.match(out, /sdk-test's draft holds \d+ changes that aren't live/);
  assert.match(out, /sdk-test is not published \(--no-publish\)\./);
  assert.doesNotMatch(out, /the bot messages you/);

  // No tools, nothing of connect's for a publish to carry: it isn't offered.
  const noTools = await runCli(t, [...ASKED, '--no-tools'], { answers: { 'Go ahead': 'y' }, draft: [AGENTS_OWN] });
  assert.equal(noTools.code, 0, noTools.err);
  assert.deepEqual(noTools.asked, ['asked: \nGo ahead? [y/N] '], 'a draft of your own is yours to publish');
  assert.ok(!noTools.vf.state.calls.some((c) => c.path.endsWith('/diff')));
  assert.deepEqual(noTools.vf.state.publishes, []);
  assert.doesNotMatch(greetings(noTools.slack)[0].body.text, /tools/);
});

test('a second run finds nothing waiting: it publishes nothing, asks nothing about it, and the bot is not sent again', async (t) => {
  const answers = { 'Go ahead': 'y', 'Publish sdk-test now': 'y' };
  const first = await runCli(t, ASKED, { answers });
  assert.equal(first.code, 0, first.err);
  const again = await runCli(t, [...ASKED, '--app', 'A1'], { answers, slack: first.slack, vf: first.vf });
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /= sdk-test is published: nothing in its draft is waiting/);
  assert.equal(again.vf.state.publishes.length, 1, 'published once, by the first run');
  assert.ok(!again.asked.some((question) => question.includes('Publish')));
  assert.equal(greetings(again.slack).length, 1, 'only a new app introduces itself');
  assert.doesNotMatch(again.out, /the bot messages you/);

  // A script is told the same, from what's there: it isn't warned of a publish that's already done.
  const script = await runCli(t, [...CONNECT, '--app', 'A1'], { slack: first.slack, vf: first.vf });
  assert.equal(script.code, 0, script.err);
  assert.match(script.out, /= sdk-test is published: nothing in its draft is waiting/);
  assert.match(script.out, /sdk-test is published: the agent in Slack has the tools now\./);
  assert.doesNotMatch(script.out, /only once you publish/);
  assert.equal(script.vf.state.publishes.length, 1);
});

test('a publish Voiceflow refuses is a failure that says so, after everything connect did is reported', async (t) => {
  const refuse = (url) => (url.includes('/publish') ? new Response(JSON.stringify({ message: `not allowed for ${VF_KEY}` }), { status: 403 }) : undefined);
  const { code, out, err, vf } = await runCli(t, [...CONNECT, '--publish'], { voiceflow: refuse });
  assert.equal(code, 1);
  assert.match(
    err,
    /! Voiceflow didn't publish sdk-test: Voiceflow POST \/v1\/stable\/environment\/sdk-test\/publish answered 403: not allowed for \[hidden\]\. Publish it in Voiceflow\./,
  );
  assert.match(out, /Connected: Slack app A1, bot user UBOT\./, 'the app is connected all the same');
  assert.match(out, /only once you publish sdk-test/);
  assert.deepEqual(vf.state.publishes, []);
  noSecrets(out + err);

  // A draft that can't be read is said, and --publish still does what it was told.
  const unreadable = (url) => (url.includes('/diff') ? new Response('{"message":"no"}', { status: 500 }) : undefined);
  const blind = await runCli(t, [...CONNECT, '--publish'], { voiceflow: unreadable });
  assert.equal(blind.code, 0, blind.err);
  assert.match(blind.err, /! Couldn't read what sdk-test's draft holds/);
  assert.equal(blind.vf.state.publishes.length, 1);
});

test('a greeting Slack refuses is a note, not a failure', async (t) => {
  const { code, out, err } = await runCli(t, CONNECT, { slack: fakeSlack({ greetError: 'channel_not_found' }) });
  assert.equal(code, 0);
  assert.match(err, /! The bot couldn't message you in Slack \(channel_not_found\)\. Message it yourself once your server is running\./);
  assert.match(out, /Connected: Slack app A1/);
  assert.doesNotMatch(out, /messaged you in Slack/);
});

test('--manual publishes on the same terms, and sends no message: nothing in Slack is its to do', async (t) => {
  const slack = fakeSlack({ botScopes: NEEDED });
  const { code, out, err, vf } = await runCli(t, [...MANUAL, '--publish'], { env: {}, files: { '.env.local': OWN }, slack, slackCli: NO_CLI });
  assert.equal(code, 0, err);
  assert.equal(vf.state.publishes.length, 1);
  assert.match(out, /sdk-test is published: the agent in Slack has the tools now\./);
  assert.deepEqual(greetings(slack), []);
  assert.doesNotMatch(out, /the bot messages you/);
});

// ── A server on this machine: connect's tunnel, and pointing ────────────────

const TUNNEL = 'https://quiet-river-test.trycloudflare.com';
/** A machine a tunnel runs on: cloudflared there or not, each start and stop counted. */
function tunnelMachine({ installed = true } = {}) {
  const started = [];
  const state = { stopped: 0 };
  return {
    started,
    state,
    host: {
      platform: 'linux',
      find: (name) => (name === 'cloudflared' && installed ? '/fake/cloudflared' : undefined),
      start: (command, args, on) => {
        started.push([command, ...args].join(' '));
        queueMicrotask(() => on.line(`2026 INF |  ${TUNNEL}  |`));
        return {
          stop: async () => {
            state.stopped++;
          },
        };
      },
      run: async () => 0,
      known: async () => true,
      fetch: async () => new Response('', { status: 502 }),
      wait: async () => {},
    },
  };
}
const LOCAL = CONNECT.filter((arg, i, all) => arg !== '--public-url' && all[i - 1] !== '--public-url');
const urlsOf = (manifest) => [
  manifest.settings.event_subscriptions.request_url,
  manifest.settings.interactivity.request_url,
  ...manifest.features.slash_commands.map((c) => c.url),
];
const toolsAddress = (vf) => vf.state.secretValues.filter((v) => v.environmentAlias === 'sdk-test').map((v) => `${v.versionVariant}: ${v.value}`);

test('without an address, connect opens a tunnel for as long as the app takes to make, and says dev is next', async (t) => {
  const machine = tunnelMachine();
  const { code, out, err, slack, vf } = await runCli(t, LOCAL, { tunnel: machine.host });
  assert.equal(code, 0, err);
  assert.deepEqual(machine.started, ['/fake/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:0'], "to the port connect answers Slack's check on");
  assert.match(out, new RegExp(`No --public-url, so Slack gets a temporary address while the app is made: ${TUNNEL}`));
  assert.deepEqual(urlsOf(slack.apps.get('A1')), [`${TUNNEL}/api/slack`, `${TUNNEL}/api/slack`, `${TUNNEL}/api/slack`]);
  assert.equal(machine.state.stopped, 1, 'the tunnel is closed when connect is done');
  assert.match(out, /Slack has a temporary address, which has stopped\. Start your server with `voiceflow-channelkit dev -- <its command>`/);
  assert.match(out, /The agent's Slack tools call your server at the address dev gives them/);
  assert.doesNotMatch(out, /Slack sends to https/);
  assert.deepEqual(vf.state.compiles, ['sdk-test']);
});

test('a plan only shown opens no tunnel, and a failure leaves none open', async (t) => {
  const dry = tunnelMachine();
  const shown = await runCli(t, [...LOCAL, '--dry-run'], { tunnel: dry.host });
  assert.equal(shown.code, 0, shown.err);
  assert.deepEqual(dry.started, []);
  assert.match(shown.out, /requests go to a temporary tunnel's address/);
  assert.doesNotMatch(shown.out, /temporary-tunnel\.invalid/);
  assert.deepEqual(shown.slack.writes(), []);

  const broken = tunnelMachine();
  const failed = await runCli(t, LOCAL, { tunnel: broken.host, slack: fakeSlack({ invalid: 'no such feature' }) });
  assert.equal(failed.code, 1);
  assert.equal(broken.started.length, 1);
  assert.equal(broken.state.stopped, 1, 'closed although connect failed');
});

test('without cloudflared, a script is told how to get it, or to give an address, before Slack is touched', async (t) => {
  const { code, err, slack, vf } = await runCli(t, LOCAL, { tunnel: tunnelMachine({ installed: false }).host });
  assert.equal(code, 3, 'waiting on a person');
  assert.match(err, /It needs cloudflared, which isn't installed\. Install it \(https:\/\/developers\.cloudflare\.com\/[^)]+\)\. Then run this again\./);
  assert.match(err, /Or give connect your server's address: --public-url https:\/\/<host>\.$/);
  assert.deepEqual(slack.calls, []);
  assert.deepEqual(vf.writes(), []);

  // With a key to set as well, it's all said in the one stop.
  const both = await runCli(t, LOCAL, { env: {}, tunnel: tunnelMachine({ installed: false }).host });
  assert.equal(both.code, 3);
  assert.match(both.err, /No Voiceflow API key/);
  assert.match(both.err, /It needs cloudflared, which isn't installed/);
});

test("point moves a connected app and the agent's tools to another address, and changes nothing else", async (t) => {
  const first = await runCli(t, CONNECT);
  assert.equal(first.code, 0, first.err);
  const before = structuredClone(first.slack.apps.get('A1'));
  const slackWrites = first.slack.writes().length;
  const vfWrites = first.vf.writes().length;

  const point = ['point', '--project', 'proj1', '--environment', 'sdk-test', '--app', 'A1', '--public-url', TUNNEL];
  const moved = await runCli(t, point, { slack: first.slack, vf: first.vf });
  assert.equal(moved.code, 0, moved.err);
  assert.match(moved.out, new RegExp(`~ Slack app A1 sends to ${TUNNEL}/api/slack \\(it sent to https://bot\\.example\\.com/api/slack\\)`));
  assert.match(moved.out, new RegExp(`~ the agent's Slack tools call ${TUNNEL}/api/slack \\(no publish needed\\)`));
  const after = first.slack.apps.get('A1');
  assert.deepEqual(urlsOf(after), [`${TUNNEL}/api/slack`, `${TUNNEL}/api/slack`, `${TUNNEL}/api/slack`]);
  // Put the addresses back, and it is the manifest it was: nothing else moved.
  const restored = JSON.parse(JSON.stringify(after).replaceAll(TUNNEL, 'https://bot.example.com'));
  assert.deepEqual(restored, before);
  assert.deepEqual(
    first.slack
      .writes()
      .slice(slackWrites)
      .map((c) => c.method),
    ['apps.manifest.update'],
    'one write in Slack: no install, no icon',
  );
  // The tools' address, in the draft and the published version, and nothing more in Voiceflow.
  assert.deepEqual(toolsAddress(first.vf).slice(-2), [`draft: ${TUNNEL}/api/slack`, `published: ${TUNNEL}/api/slack`]);
  assert.deepEqual(
    first.vf
      .writes()
      .slice(vfWrites)
      .map((c) => `${c.method} ${c.path.replace(/sec\d+/, ':id')}`),
    ['PUT /v1/stable/secret/:id/value', 'PUT /v1/stable/secret/:id/value'],
    'no tool, no compile, no publish',
  );
  assert.deepEqual(first.vf.state.publishes, []);
  noSecrets(moved.out + moved.err);

  // Pointed there already: Slack is left alone.
  const again = await runCli(t, point, { slack: first.slack, vf: first.vf });
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, new RegExp(`= Slack app A1 sends to ${TUNNEL}/api/slack already`));
  assert.equal(first.slack.writes().length, slackWrites + 1, 'no second update');
});

test('point needs a connected app, the right workspace, and for an app you made leaves Slack to you', async (t) => {
  const none = await runCli(t, ['point', '--project', 'proj1', '--environment', 'sdk-test', '--public-url', TUNNEL]);
  assert.equal(none.code, 1);
  assert.match(none.err, /No Slack app is connected to Spike's sdk-test environment from here\. Run connect first\. Nothing was changed\./);
  assert.deepEqual(none.slack.writes(), []);
  assert.deepEqual(none.vf.writes(), []);

  const elsewhere = await runCli(t, [
    'point',
    '--project',
    'proj1',
    '--environment',
    'sdk-test',
    '--workspace',
    'ws-other',
    '--app',
    'A1',
    '--public-url',
    TUNNEL,
  ]);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.err, /Project proj1 is in workspace ws1, not ws-other\. Nothing was changed\./);
  assert.deepEqual(elsewhere.slack.calls, []);

  const first = await runCli(t, CONNECT);
  const own = await runCli(t, ['point', '--manual', '--project', 'proj1', '--environment', 'sdk-test', '--public-url', TUNNEL], {
    slack: first.slack,
    vf: first.vf,
    slackCli: NO_CLI,
  });
  assert.equal(own.code, 0, own.err);
  assert.match(
    own.out,
    new RegExp(
      `your Slack app's settings are yours to keep: point Event Subscriptions, Interactivity & Shortcuts and your slash command at ${TUNNEL}/api/slack`,
    ),
  );
  assert.deepEqual(toolsAddress(first.vf).slice(-2), [`draft: ${TUNNEL}/api/slack`, `published: ${TUNNEL}/api/slack`]);
  assert.equal(first.slack.calls.filter((c) => c.method === 'apps.manifest.update').length, 0, 'Slack was not touched');
});

test('a manifest is moved to another address without touching a command you sent elsewhere', () => {
  const manifest = slackManifest({ requestUrl: URL_, tools: {} });
  manifest.features.slash_commands.push({ command: '/other', url: 'https://elsewhere.example.com/hook', description: 'Mine' });
  const { manifest: moved, from } = repointManifest(manifest, `${TUNNEL}/api/slack`);
  assert.equal(from, URL_);
  assert.deepEqual(
    moved.features.slash_commands.map((c) => `${c.command} ${c.url}`),
    [`/ask ${TUNNEL}/api/slack`, '/other https://elsewhere.example.com/hook'],
  );
  assert.equal(manifest.settings.event_subscriptions.request_url, URL_, 'the manifest given is not changed');
  assert.throws(() => repointManifest(manifest, 'http://insecure.example.com/api/slack'), /https/);
  assert.equal(repointManifest(manifest, URL_).from, undefined, 'the same address is no move');
});

test("point asks your server Slack's signed check first: a server that's down, or holds another secret, is said before Slack is touched", async (t) => {
  const first = await runCli(t, CONNECT);
  const point = ['point', '--project', 'proj1', '--environment', 'sdk-test', '--app', 'A1', '--public-url', TUNNEL, '--local-url', 'http://127.0.0.1:3000/'];
  const env = { VOICEFLOW_API_KEY: VF_KEY, SLACK_SIGNING_SECRET: SIGNING };
  const updates = () => first.slack.of('apps.manifest.update').length;
  /** A server on this machine, as the test's: it sees each check, and answers as told. */
  const server = (answer) => {
    const seen = [];
    return {
      seen,
      fetch: async (url, init) => {
        if (!url.startsWith('http://127.0.0.1:')) return undefined;
        const headers = new Headers(init.headers);
        const signed = `v0=${createHmac('sha256', SIGNING)
          .update(`v0:${headers.get('x-slack-request-timestamp')}:${init.body}`)
          .digest('hex')}`;
        seen.push({ url, method: init.method, genuine: headers.get('x-slack-signature') === signed, slackTouchedYet: updates() > 0 });
        return answer(JSON.parse(init.body));
      },
    };
  };

  const up = server((body) => Response.json({ challenge: body.challenge }));
  const good = await runCli(t, point, { env, slack: first.slack, vf: first.vf, voiceflow: up.fetch });
  assert.equal(good.code, 0, good.err);
  assert.deepEqual(up.seen, [{ url: 'http://127.0.0.1:3000/api/slack', method: 'POST', genuine: true, slackTouchedYet: false }]);
  assert.match(good.out, /= your server answers Slack's signed check at http:\/\/127\.0\.0\.1:3000\/api\/slack\n~ Slack app A1 sends to/);
  assert.equal(updates(), 1);
  noSecrets(good.out + good.err);

  const elsewhere = 'https://other-tunnel-test.trycloudflare.com';
  const moved = point.map((arg) => (arg === TUNNEL ? elsewhere : arg));
  const writes = first.vf.writes().length;
  for (const [answer, said] of [
    [() => new Response('no', { status: 401 }), /refused a request signed with SLACK_SIGNING_SECRET\. Is the secret it runs with this app's/],
    [() => new Response('<html>not found</html>', { status: 404 }), /answered 404 to Slack's URL check, not the check's own value\. Is that its Slack route\?/],
    [() => Response.json({ challenge: 'another' }), /answered 200 to Slack's URL check, not the check's own value/],
    [
      () => {
        throw new Error('ECONNREFUSED');
      },
      /Your server didn't answer at http:\/\/127\.0\.0\.1:3000\/api\/slack\. Is it running/,
    ],
  ]) {
    const bad = await runCli(t, moved, { env, slack: first.slack, vf: first.vf, voiceflow: server(answer).fetch });
    assert.equal(bad.code, 1);
    assert.match(bad.err, said);
    assert.match(bad.err, /Nothing was changed\.$/);
  }
  assert.equal(updates(), 1, 'Slack was pointed nowhere new');
  assert.equal(first.vf.writes().length, writes, "and neither were the agent's tools");

  // With no signing secret to sign with, it says the server wasn't checked, and goes on.
  const unsigned = await runCli(t, moved, { slack: first.slack, vf: first.vf });
  assert.equal(unsigned.code, 0, unsigned.err);
  assert.match(unsigned.out, /· no SLACK_SIGNING_SECRET here, so your server at http:\/\/127\.0\.0\.1:3000\/api\/slack wasn't checked first/);
  assert.equal(updates(), 2);
});

test('a plan only shown also says what a publish would carry, so one answer can cover the plan and the publish', async (t) => {
  const dry = await runCli(t, [...CONNECT, '--dry-run'], { draft: [AGENTS_OWN] });
  assert.equal(dry.code, 0, dry.err);
  assert.match(
    dry.out,
    /sdk-test's draft holds a change that isn't live \(1 updated\):\n {2}~ agent Support\nA publish would carry these too, with what's above: its whole draft goes live\./,
  );
  assert.deepEqual(dry.slack.writes(), []);
  assert.deepEqual(dry.vf.writes(), [], 'reading the draft changes nothing');

  const clean = await runCli(t, [...CONNECT, '--dry-run']);
  assert.match(clean.out, /sdk-test's draft holds nothing else that isn't live: a publish would carry only what's above\./);

  // Told there'll be no publish, or with no tools for one to carry, the draft isn't read.
  for (const flag of ['--no-publish', '--no-tools']) {
    const quiet = await runCli(t, [...CONNECT, '--dry-run', flag], { draft: [AGENTS_OWN] });
    assert.equal(quiet.code, 0, quiet.err);
    assert.ok(!quiet.vf.state.calls.some((c) => c.path.endsWith('/diff')), flag);
    assert.doesNotMatch(quiet.out, /A publish would carry/);
  }

  // An app you made gets the same preview.
  const own = await runCli(t, [...MANUAL, '--dry-run'], {
    env: {},
    files: { '.env.local': OWN },
    slack: fakeSlack({ botScopes: NEEDED }),
    slackCli: NO_CLI,
    draft: [AGENTS_OWN],
  });
  assert.equal(own.code, 0, own.err);
  assert.match(own.out, /A publish would carry these too/);
});
