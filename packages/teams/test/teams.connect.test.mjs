// `connect teams`, `point` and `disconnect`, against a stand-in for
// Microsoft's Teams command and a fake of Voiceflow's API: the plan it shows
// before changing anything, what it has Microsoft make, where it stops, and
// where the bot's secret goes (the file you name, never a line it prints).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NeedsYou } from '@voiceflow/channels-sdk';
import { fakeVoiceflowApi } from '@voiceflow/channels-sdk/testing';
import {
  botNameOf,
  cli,
  connected,
  connectTeams,
  createMsCli,
  decodePng,
  encodePng,
  localMsCli,
  MS_CLI_NPX,
  MsCliError,
  msRunner,
  pointTeams,
  THREAD_PERMISSION,
  uploadProblem,
} from '../dist/connect/index.js';
import { CONTEXT_VARIABLES } from '../dist/index.js';
import { fakeMs, SECRET, TENANT, USER } from './helpers/fake-ms.mjs';

const PROJECT = { id: 'proj1', name: 'Acme Support', workspaceID: 'ws1' };
const VF_KEY = 'VF.DM.teams-connect-test';
const PUBLIC = 'https://bot.example.com';
const VARIABLES = Object.keys(CONTEXT_VARIABLES).length;
const APP = 'aaaaaaaa-0000-4000-8000-000000000001';
/**
 * The environment of someone at their own machine's screen, whatever machine the tests run on: Linux says there is
 * a screen with DISPLAY, and a Mac or Windows always has one. Without it a test that expects a browser to open
 * passes on a laptop and fails on a CI runner.
 */
const DESKTOP = { DISPLAY: ':0' };
/** A picture of one colour, as a PNG. */
const png = (side, colour = [61, 130, 246, 255]) =>
  encodePng({ width: side, height: side, rgba: Uint8Array.from({ length: side * side * 4 }, (_, i) => colour[i % 4]) });

/** Runs the command against the fakes, with an env file in a folder of its own. */
async function setup({
  ms = {},
  file = { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development' },
  project = PROJECT,
  /** Images on the web, by URL: `{ bytes, type }`. */
  images = {},
  voiceflowOptions = {},
} = {}) {
  const microsoft = fakeMs(ms);
  const voiceflow = fakeVoiceflowApi({ project, apiKey: VF_KEY, ...voiceflowOptions });
  const dir = await mkdtemp(join(tmpdir(), 'teams-connect-'));
  const envFile = join(dir, '.env.local');
  if (file)
    await writeFile(
      envFile,
      `${Object.entries(file)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')}\n`,
    );
  /** The pages the command opened in the person's browser: none is ever really opened by a test. */
  const opened = [];
  const run = async (argv, io = {}) => {
    const out = [];
    const err = [];
    const code = await cli(argv, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      open: async (url) => (opened.push(url), true),
      env: {},
      microsoft: createMsCli(microsoft.run),
      // A picture is wherever its URL says; a server on this machine is itself; everything else is Voiceflow's API.
      fetch: (url, init) => {
        const image = images[String(url)];
        if (image) return Promise.resolve(new Response(image.bytes, { status: image.status ?? 200, headers: { 'content-type': image.type } }));
        return String(url).startsWith('http://127.0.0.1') ? fetch(url, init) : voiceflow.fetch(url, init);
      },
      interactive: false,
      ...io,
    });
    return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') };
  };
  const env = async () =>
    Object.fromEntries(
      (await readFile(envFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  const writes = () => voiceflow.state.calls.filter((call) => call.method !== 'GET').length;
  return { microsoft, voiceflow, dir, envFile, run, env, opened, writes };
}
const connect = (t, ...more) => t.run(['connect', '--env-file', t.envFile, ...more]);

/** Servers a test started: each is stopped when the test ends, passed or failed. */
const servers = [];
test.afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

test('the plan says everything it would do, and changes nothing', async () => {
  const t = await setup();
  const { code, out, all } = await connect(t, '--dry-run');
  assert.equal(code, 0, all);
  assert.match(out, new RegExp(`Microsoft 365: signed in as ${USER.replace('.', '\\.')} \\(organization ${TENANT}\\)`));
  assert.match(out, /\+ make a Teams app and its bot, named "Acme Support" after your agent in Voiceflow/);
  assert.match(out, /\+ give it Voiceflow's icon as its picture \(the agent has no avatar in Voiceflow\)/);
  assert.match(
    out,
    /\+ let it read a thread's replies, so they need no mention \(the permission ChannelMessage\.Read\.Group: Teams then sends it everything written in a channel/,
  );
  assert.match(out, /· Teams needs your server's address: `voiceflow-channels dev` gives it one each time it starts/);
  assert.match(out, /Voiceflow: project "Acme Support" \(proj1\) in workspace ws1, environment development: the variables go on its draft/);
  assert.match(out, new RegExp(`\\+ ${VARIABLES} variables for your agent's prompts`));
  assert.match(out, /· nothing is published, and nothing has to be/);
  assert.match(out, /gets TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID/);
  assert.deepEqual(t.microsoft.apps(), [], 'no app was made');
  assert.deepEqual(t.microsoft.taken(), ['status --json'], 'Microsoft was asked only who is signed in');
  assert.equal(t.writes(), 0);
  assert.deepEqual(Object.keys(await t.env()).sort(), ['VOICEFLOW_API_KEY', 'VOICEFLOW_ENVIRONMENT', 'VOICEFLOW_PROJECT_ID']);
});

test('without --yes and with nobody to ask, it shows the plan and changes nothing', async () => {
  const t = await setup();
  const { code, err } = await connect(t);
  assert.equal(code, 0);
  assert.match(err, /Nothing was changed: run it again with --yes to go ahead\./);
  assert.deepEqual(t.microsoft.apps(), []);
  assert.equal(t.writes(), 0);
});

test('from a Microsoft 365 sign-in, connect does the rest', async () => {
  const t = await setup();
  const { code, out, all } = await connect(t, '--yes');
  assert.equal(code, 0, all);

  // Microsoft made the app, named after the agent, with a picture it takes, and the permission went on before anyone could add it.
  const [app] = t.microsoft.apps();
  assert.equal(app.name, 'Acme Support');
  assert.equal(app.endpoint, '', 'no address yet: dev gives one');
  const icon = decodePng(app.icon);
  assert.deepEqual([icon.width, icon.height], [192, 192]);
  assert.deepEqual(app.permissions, [THREAD_PERMISSION]);
  const calls = t.microsoft.taken();
  assert.deepEqual(
    calls.map((call) => call.split(' ').slice(0, 3).join(' ')),
    ['status --json', 'app create --name', 'app rsc add'],
    'and it was asked for nothing else',
  );
  assert.match(calls[1], /--teams-managed --yes --json$/, 'made without an Azure account, asking nothing');

  // What the server needs is in its env file, readable by you alone. The secret has a "~", as Microsoft's do.
  const env = await t.env();
  assert.equal(env.TEAMS_APP_ID, app.id);
  assert.equal(env.TEAMS_APP_PASSWORD, SECRET);
  assert.equal(env.TEAMS_APP_TENANT_ID, TENANT);
  assert.equal(env.VOICEFLOW_API_KEY, VF_KEY, 'what was there is as it was');
  assert.equal((await stat(t.envFile)).mode & 0o777, 0o600);
  assert.ok(!existsSync(app.credentialsFile), "the file Microsoft's command wrote the secret to is gone");
  assert.ok(!all.includes(SECRET), 'the secret is never printed');
  assert.ok(!all.includes(VF_KEY));

  // The agent has its variables, and nothing was published.
  assert.deepEqual(t.voiceflow.state.variables.map((variable) => variable.name).sort(), Object.keys(CONTEXT_VARIABLES).sort());
  assert.deepEqual(t.voiceflow.state.publishes, []);
  assert.match(out, new RegExp(`\\+ created ${VARIABLES} variables on the agent`));

  // And the person is told what's left: the one click that is theirs.
  assert.match(out, new RegExp(`Connected: Teams app ${app.id} "Acme Support", in ${USER.replace('.', '\\.')}'s organization\\.`));
  assert.match(out, /TEAMS_APP_PASSWORD {4}in .*\.env\.local/);
  assert.match(out, /Add the bot in Teams: open this link\. Choose "Use the web app instead"/);
  assert.ok(out.includes(`https://teams.microsoft.com/l/app/${app.id}?installAppPackage=true&appTenantId=${TENANT}`));
  assert.match(out, /Then start your server with `voiceflow-channels dev -- <its command>`/);
  assert.match(out, /The teams_\* variables are on development's draft/);
  assert.deepEqual(t.opened, [], 'no page is opened when nobody is there');
});

test('run again, connect keeps the app it made and changes nothing in Microsoft 365', async () => {
  const t = await setup();
  await connect(t, '--yes');
  const before = structuredClone(t.microsoft.apps()[0]);
  t.microsoft.taken();
  const { code, out, all } = await connect(t, '--yes');
  assert.equal(code, 0, all);
  assert.match(out, new RegExp(`= the Teams app "Acme Support" \\(${before.id}\\) is there: its name, picture and permissions are left as they are`));
  assert.match(out, new RegExp(`= ${VARIABLES} variables: there already`));
  assert.deepEqual(t.microsoft.taken(), ['status --json', `app get ${before.id} --json`], 'it read the app, and changed nothing');
  assert.equal(t.microsoft.apps().length, 1, 'no second app');
  assert.equal(t.microsoft.apps()[0].version, before.version);
  assert.equal((await t.env()).TEAMS_APP_PASSWORD, SECRET);
  assert.match(out, /To add the bot in Teams: open this link\./);
});

test('with nobody there and nothing set, it stops once and says everything it waits on', async () => {
  const t = await setup({ ms: { signedIn: false }, file: null });
  const { code, err } = await connect(t, '--yes');
  assert.equal(code, 3);
  assert.match(err, /No Voiceflow project/);
  assert.match(err, /No Voiceflow environment/);
  assert.match(err, /Voiceflow API key/);
  assert.match(err, /Not signed in to Microsoft 365\. Sign in with the account you use Teams with:/);
  assert.ok(err.includes(`${MS_CLI_NPX} login`));
  assert.match(err, /add --device-code/);
  assert.deepEqual(t.microsoft.apps(), []);
  assert.deepEqual(t.microsoft.taken(), ['status --json'], 'nobody was signed in on their behalf');
  assert.ok(!existsSync(t.envFile), 'and nothing was written');
});

test("a person who is there signs in, in Microsoft's own command, and connect goes on", async () => {
  const t = await setup({ ms: { signedIn: false } });
  const asked = [];
  const io = { interactive: true, ask: async (question) => (asked.push(question), 'y') };
  // On this machine's own screen, a browser is opened for the sign-in.
  const here = await connect(t, '--no-open');
  assert.equal(here.code, 3, 'not interactive: it waits');
  t.microsoft.taken();
  const { code, out, all } = await t.run(['connect', '--env-file', t.envFile], { ...io, env: DESKTOP });
  assert.equal(code, 0, all);
  assert.match(out, /Sign in to Microsoft 365, with the account you use Teams with\./);
  const calls = t.microsoft.taken();
  assert.equal(calls[1], 'login (shown)', "the terminal is handed to Microsoft's command");
  assert.equal(t.microsoft.apps().length, 1);
  assert.deepEqual(asked, ['\nGo ahead? [y/N] ']);
  assert.equal(t.opened.length, 1, 'and the page that adds the bot is opened for them');
  assert.match(out, /Add the bot in Teams: the page is open in your browser\./);

  // Over SSH no browser of theirs can open here: a link and a code instead.
  const far = await setup({ ms: { signedIn: false } });
  await far.run(['connect', '--env-file', far.envFile, '--yes'], { interactive: true, env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }, open: undefined });
  assert.equal(far.microsoft.taken()[1], 'login --device-code (shown)');

  // A sign-in that doesn't finish is said, and nothing is made.
  const failed = await setup({ ms: { signedIn: false, signInWorks: false } });
  const result = await failed.run(['connect', '--env-file', failed.envFile, '--yes'], { interactive: true });
  assert.equal(result.code, 1);
  assert.match(result.err, /The sign-in didn't finish/);
  assert.deepEqual(failed.microsoft.apps(), []);
});

test("an organization, or an account, that can't add its own apps to Teams is said before anything is made", async () => {
  const org = await setup({ ms: { upload: { tenant: false } } });
  const first = await connect(org, '--yes');
  assert.equal(first.code, 3);
  assert.match(first.err, /Your Microsoft 365 organization doesn't let people add apps of their own to Teams/);
  assert.match(first.err, /Org-wide app settings → Custom apps \(https:\/\/admin\.teams\.microsoft\.com\/policies\/manage-apps\)/);
  assert.deepEqual(org.microsoft.apps(), []);

  const person = await setup({ ms: { upload: { user: false } } });
  const second = await connect(person, '--yes');
  assert.equal(second.code, 3);
  assert.match(second.err, /isn't allowed to add apps of its own to Teams/);
  assert.match(second.err, /Setup policies → Global \(Org-wide default\), or the policy you're under → Upload custom apps/);
  assert.deepEqual(person.microsoft.apps(), []);
  assert.equal(person.writes(), 0);

  // Where Microsoft's command can't say, connect goes on.
  assert.equal(uploadProblem({ signedIn: true, username: USER, tenantId: TENANT, upload: { organization: null, person: null } }), undefined);
});

test('connectTeams itself stops for a person: signed out, or not allowed to add an app', async () => {
  const voiceflow = fakeVoiceflowApi({ project: PROJECT, apiKey: VF_KEY });
  const options = (ms) => ({
    microsoft: createMsCli(ms.run),
    voiceflow: { apiKey: VF_KEY, projectID: PROJECT.id, environment: 'development', fetch: voiceflow.fetch },
  });
  const out = fakeMs({ signedIn: false });
  await assert.rejects(connectTeams(options(out)), (error) => error instanceof NeedsYou && /Not signed in to Microsoft 365/.test(error.message));
  const blocked = fakeMs({ upload: { user: false } });
  await assert.rejects(
    connectTeams(options(blocked)),
    (error) => error instanceof NeedsYou && /isn't allowed to add apps of its own to Teams/.test(error.message),
  );
  assert.deepEqual([...out.apps(), ...blocked.apps()], []);
  assert.equal(voiceflow.state.calls.length, 0, 'before Voiceflow is asked anything');
  // A name or an address that can't be is a mistake in the call, said before anything is made.
  const fine = fakeMs();
  await assert.rejects(connectTeams({ ...options(fine), name: 'x'.repeat(31) }), /at most 30 characters/);
  await assert.rejects(connectTeams({ ...options(fine), endpoint: 'http://bot.example.com/api/teams' }), /only to an https address/);
  await assert.rejects(pointTeams({ microsoft: createMsCli(fine.run), appId: APP, endpoint: 'http://bot.example.com' }), /only to an https address/);
  assert.deepEqual(fine.apps(), []);
});

test("the bot's secret is saved before anything else can fail", async () => {
  // Voiceflow's API goes down once the app is made.
  let made = false;
  const t = await setup({ voiceflowOptions: { fail: (call) => made && call.method !== 'GET' } });
  const run = t.microsoft.run;
  const microsoft = createMsCli(async (args, how) => {
    const result = await run(args, how);
    if (args[1] === 'create') made = true;
    return result;
  });
  const { code } = await t.run(['connect', '--env-file', t.envFile, '--yes'], { microsoft });
  assert.equal(code, 1, 'the run failed');
  const env = await t.env();
  assert.equal(env.TEAMS_APP_PASSWORD, SECRET, 'and the secret, shown once, is where the server reads it');
  assert.equal(env.TEAMS_APP_ID, t.microsoft.apps()[0].id);
  // Run again, it finishes: the app is kept.
  made = false;
  const again = await connect(t, '--yes');
  assert.equal(again.code, 0, again.all);
  assert.equal(t.microsoft.apps().length, 1);
  assert.equal(t.voiceflow.state.variables.length, VARIABLES);
});

test('--mentions-only asks for no permission, and one Microsoft refuses is said with how to add it', async () => {
  const quiet = await setup();
  const first = await connect(quiet, '--yes', '--mentions-only');
  assert.equal(first.code, 0, first.all);
  assert.match(first.out, /· it answers where it is mentioned, and in chats: a reply in a thread needs a mention too/);
  assert.deepEqual(quiet.microsoft.apps()[0].permissions, []);

  // Microsoft's refusal repeats the new secret back: it is taken out of what's printed, though it was made a moment ago.
  const refused = await setup({ ms: { fail: (args) => (args[1] === 'rsc' ? { code: 'API_ERROR', message: `Graph said no. (${SECRET})` } : undefined) } });
  const second = await connect(refused, '--yes');
  assert.equal(second.code, 0, 'the bot works without it');
  assert.match(second.out, /! The bot wasn't given the permission to read a thread's replies \(Graph said no\./);
  assert.ok(!second.all.includes(SECRET), 'a secret just made is never printed');
  assert.ok(second.out.includes(`${MS_CLI_NPX} app rsc add ${refused.microsoft.apps()[0].id} ${THREAD_PERMISSION} --type Application`));
  assert.equal((await refused.env()).TEAMS_APP_PASSWORD, SECRET);
});

test("the agent's avatar is the bot's picture at the size Teams takes, and Voiceflow's icon stands in when it can't be", async () => {
  const avatar = 'https://cdn.example.com/avatar.png';
  const t = await setup({ project: { ...PROJECT, image: avatar }, images: { [avatar]: { bytes: png(512, [10, 200, 30, 255]), type: 'image/png' } } });
  const { code, out, all } = await connect(t, '--yes');
  assert.equal(code, 0, all);
  assert.match(out, /\+ give it the agent's avatar in Voiceflow as its picture, made the 192 by 192 pixels Teams takes/);
  const icon = decodePng(t.microsoft.apps()[0].icon);
  assert.deepEqual([icon.width, icon.height], [192, 192]);
  assert.deepEqual([...icon.rgba.subarray(0, 4)], [10, 200, 30, 255], 'the same picture, smaller');

  // A JPEG can't be made a PNG here: Voiceflow's icon, and a note saying so.
  const jpeg = await setup({
    project: { ...PROJECT, image: avatar },
    images: { [avatar]: { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]), type: 'image/jpeg' } },
  });
  const second = await connect(jpeg, '--yes');
  assert.equal(second.code, 0, second.all);
  assert.match(second.out, /! The agent's avatar couldn't be the bot's picture: it isn't a PNG.*It has Voiceflow's icon instead\./);
  assert.equal(decodePng(jpeg.microsoft.apps()[0].icon).width, 192);

  // One that can't be downloaded: the same.
  const gone = await setup({ project: { ...PROJECT, image: avatar }, images: { [avatar]: { bytes: 'no', type: 'text/plain', status: 404 } } });
  const third = await connect(gone, '--yes');
  assert.match(third.out, /couldn't be downloaded \(HTTP 404\).*It has Voiceflow's icon instead\./);
});

test('--icon names the picture, and --icon none leaves Teams its placeholder', async () => {
  const image = 'https://cdn.example.com/logo.png';
  const t = await setup({ images: { [image]: { bytes: png(300, [1, 2, 3, 255]), type: 'image/png' } } });
  const first = await connect(t, '--yes', '--icon', image);
  assert.equal(first.code, 0, first.all);
  assert.deepEqual([...decodePng(t.microsoft.apps()[0].icon).rgba.subarray(0, 4)], [1, 2, 3, 255]);

  const none = await setup();
  await connect(none, '--yes', '--icon', 'none');
  assert.equal(none.microsoft.apps()[0].icon, undefined);
  assert.ok(!none.microsoft.taken().some((call) => call.includes('--color-icon')));

  // A picture you named that can't be used is yours to fix: said, and no other put in its place.
  const bad = await setup({ images: { [image]: { bytes: Buffer.from('GIF89a'), type: 'image/gif' } } });
  const third = await connect(bad, '--yes', '--icon', image);
  assert.equal(third.code, 0);
  assert.match(third.out, /! The image couldn't be the bot's picture: it isn't a PNG.*It has Teams' placeholder\..*before the app is first added/);
  assert.equal(bad.microsoft.apps()[0].icon, undefined);
});

test("an agent's name becomes a name Teams takes, and --name gives another", async () => {
  assert.equal(botNameOf('  Acme   Support  '), 'Acme Support');
  assert.equal(botNameOf('The Acme Corporation Supporting Assistant'), 'The Acme Corporation', 'cut at a word, not in one');
  assert.equal(botNameOf('Supercalifragilisticexpialidocious-and-then-some'), 'Supercalifragilisticexpialidoc', 'one long word is cut where it must be');
  assert.equal(botNameOf('x'.repeat(30)), 'x'.repeat(30));

  const t = await setup({ project: { ...PROJECT, name: 'The Acme Corporation Supporting Assistant' } });
  await connect(t, '--yes');
  assert.equal(t.microsoft.apps()[0].name, 'The Acme Corporation');

  const named = await setup();
  const { out } = await connect(named, '--yes', '--name', 'Helpdesk');
  assert.equal(named.microsoft.apps()[0].name, 'Helpdesk');
  assert.match(out, /\+ make a Teams app and its bot, named "Helpdesk"\n/);

  // On an app made before, a name is changed only when you give one: run again with none, it keeps yours, not the agent's.
  named.microsoft.taken();
  const kept = await connect(named, '--yes');
  assert.equal(kept.code, 0, kept.all);
  assert.equal(named.microsoft.apps()[0].name, 'Helpdesk');
  assert.ok(!named.microsoft.taken().some((call) => call.startsWith('app update')));
  const renamed = await connect(named, '--yes', '--name', 'Front desk');
  assert.equal(renamed.code, 0, renamed.all);
  assert.match(renamed.out, /~ name it "Front desk" \(it is "Helpdesk" now/);
  assert.equal(named.microsoft.apps()[0].name, 'Front desk');
  assert.ok(named.microsoft.taken().some((call) => /^app update \S+ --name Front desk --json$/.test(call)));
});

test('with --public-url Teams is given the address as the app is made, and again when it changes', async () => {
  const t = await setup();
  const { code, out, all } = await connect(t, '--yes', '--public-url', `${PUBLIC}/`);
  assert.equal(code, 0, all);
  assert.match(out, /\+ have Teams send the bot's messages to https:\/\/bot\.example\.com\/api\/teams/);
  assert.equal(t.microsoft.apps()[0].endpoint, `${PUBLIC}/api/teams`);
  assert.match(out, /Teams sends the bot's messages to https:\/\/bot\.example\.com\/api\/teams\./);

  t.microsoft.taken();
  const same = await connect(t, '--yes', '--public-url', PUBLIC);
  assert.match(same.out, /= Teams sends the bot's messages to https:\/\/bot\.example\.com\/api\/teams/);
  assert.ok(!t.microsoft.taken().some((call) => call.startsWith('app update')), 'the same address is not sent again');

  const moved = await connect(t, '--yes', '--request-url', 'https://other.example.com/hooks/teams');
  assert.match(
    moved.out,
    /~ have Teams send the bot's messages to https:\/\/other\.example\.com\/hooks\/teams \(it sends them to https:\/\/bot\.example\.com\/api\/teams now\)/,
  );
  assert.equal(t.microsoft.apps()[0].endpoint, 'https://other.example.com/hooks/teams');
});

test('a mistake in the command is said as one, before anything is asked or changed', async () => {
  const t = await setup();
  for (const [argv, said] of [
    [['connect', '--yes'], /makes the bot's secret, which has to be written where your server reads it: pass --env-file/],
    [['connect', '--env-file', t.envFile, '--public-url', 'http://bot.example.com'], /Teams sends only to an https address/],
    [['connect', '--env-file', t.envFile, '--name', 'x'.repeat(31)], /--name takes the bot's name in Teams, at most 30 characters: ".*" is 31/],
    [['connect', '--env-file', t.envFile, '--name', ' '], /--name takes the bot's name in Teams/],
    [['connect', '--env-file', t.envFile, '--icon', 'logo.png'], /--icon takes a PNG's http\(s\) URL, or "none"/],
    [['connect', '--env-file', t.envFile, '--publish', '--no-publish'], /say opposite things/],
    [['point', '--env-file', t.envFile], /Missing --public-url/],
    [['install'], /Usage:/],
  ]) {
    const { code, all } = await t.run(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(all, said);
  }
  assert.deepEqual(t.microsoft.taken(), [], "Microsoft's command was never run");
  assert.equal(t.voiceflow.state.calls.length, 0);
  assert.equal((await t.run(['--help'])).code, 0);
});

test('a project in another workspace stops it before anything is made, and --publish publishes only then', async () => {
  const t = await setup();
  const wrong = await connect(t, '--yes', '--workspace', 'ws-other');
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /ws1/);
  assert.deepEqual(t.microsoft.apps(), []);
  assert.equal(t.writes(), 0);

  const { code, out, all } = await connect(t, '--yes', '--workspace', 'ws1', '--publish');
  assert.equal(code, 0, all);
  assert.match(out, /\+ publish development: its whole draft goes live \(--publish\)/);
  assert.equal(t.voiceflow.state.publishes.length, 1);
});

test('--no-variables leaves the agent alone, and run from dev it says the server starts next', async () => {
  const t = await setup();
  const { code, out, all } = await connect(t, '--yes', '--no-variables', '--from-dev');
  assert.equal(code, 0, all);
  assert.match(out, /· no variables \(then pass context: false to teams\(\) on your server\)/);
  assert.equal(t.writes(), 0);
  assert.match(out, /Your server starts next: dev gives Teams its address\./);
  assert.doesNotMatch(out, /Then start your server/);
  assert.doesNotMatch(out, /teams_\* variables are on/);

  // dev asks whether a bot is connected from here: only with all three of its values.
  assert.equal(await connected({ envFile: t.envFile, env: {} }), true);
  assert.equal(await connected({ env: { TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b' } }), false);
  assert.equal(await connected({ env: { TEAMS_APP_ID: 'a', TEAMS_APP_PASSWORD: 'b', TEAMS_APP_TENANT_ID: 'c' } }), true);
});

test('a value the env file has is never changed, and what it lacks is added', async () => {
  const t = await setup();
  const { code, out, all } = await connect(t, '--yes', '--environment', 'staging');
  assert.equal(code, 0, all);
  assert.match(out, /environment staging/);
  const env = await t.env();
  assert.equal(env.VOICEFLOW_ENVIRONMENT, 'development', "the file's own value stands");
  assert.doesNotMatch(out, /saved VOICEFLOW/);

  // A secret an env file would read back as something else (none of Microsoft's has been, so far) goes in quotes:
  // it is written whatever it holds, because it is shown only once.
  const odd = await setup({ ms: { secret: 'q#1 two~three' } });
  assert.equal((await connect(odd, '--yes')).code, 0);
  assert.match(await readFile(odd.envFile, 'utf8'), /^TEAMS_APP_PASSWORD='q#1 two~three'$/m);

  // What isn't there is added: here, the project and environment given as flags.
  const empty = await setup({ file: { VOICEFLOW_API_KEY: VF_KEY } });
  const second = await connect(empty, '--yes', '--project', PROJECT.id, '--environment', 'development');
  assert.equal(second.code, 0, second.all);
  assert.match(second.out, /\+ saved VOICEFLOW_PROJECT_ID, VOICEFLOW_ENVIRONMENT to /);
  assert.equal((await empty.env()).VOICEFLOW_PROJECT_ID, PROJECT.id);
});

test('a page is opened only for a person who is there, for a new app, and not when told not to', async () => {
  const t = await setup();
  const io = { interactive: true, ask: async () => 'y' };
  await t.run(['connect', '--env-file', t.envFile, '--no-open'], io);
  assert.deepEqual(t.opened, []);
  // The app is made already: its page isn't opened again.
  await t.run(['connect', '--env-file', t.envFile], io);
  assert.deepEqual(t.opened, []);
});

test('point asks your server first, then gives Teams the address, and needs nothing of Voiceflow', async () => {
  const t = await setup({
    ms: { apps: [{ id: APP, name: 'Acme Support' }] },
    file: { TEAMS_APP_ID: APP, TEAMS_APP_PASSWORD: SECRET, TEAMS_APP_TENANT_ID: TENANT },
  });
  // A server with its Teams route: it refuses a request Microsoft didn't sign.
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers.authorization ?? 'no token'}`);
    res.writeHead(req.url === '/api/teams' ? 401 : 404).end('{"error":"Missing authorization header"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const local = `http://127.0.0.1:${server.address().port}`;
  const { code, out, all } = await t.run(['point', '--public-url', PUBLIC, '--local-url', local, '--env-file', t.envFile]);
  assert.equal(code, 0, all);
  assert.deepEqual(asked, ['POST /api/teams no token']);
  assert.match(out, /= your server has its Teams route at http:\/\/127\.0\.0\.1:\d+\/api\/teams, and refuses a request that isn't Teams'/);
  assert.match(out, /~ Teams sends the bot's messages to https:\/\/bot\.example\.com\/api\/teams/);
  assert.deepEqual(t.microsoft.taken(), [`app update ${APP} --endpoint ${PUBLIC}/api/teams --json`], 'one call to Microsoft, and it changes the address alone');
  assert.equal(t.microsoft.apps()[0].endpoint, `${PUBLIC}/api/teams`);
  assert.equal(t.voiceflow.state.calls.length, 0);
  assert.ok(!all.includes(SECRET));
});

test("a server that's down, has no route, or takes anyone's request is said before Teams is pointed at it", async () => {
  const t = await setup({ ms: { apps: [{ id: APP, name: 'Acme Support' }] }, file: { TEAMS_APP_ID: APP } });
  const answers = { status: 404 };
  const server = http.createServer((_req, res) => res.writeHead(answers.status).end('{}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const local = `http://127.0.0.1:${server.address().port}`;
  const point = (url = local) => t.run(['point', '--public-url', PUBLIC, '--local-url', url, '--env-file', t.envFile]);

  const none = await point();
  assert.equal(none.code, 1);
  assert.match(none.err, /Your server has no Teams route at .*\/api\/teams \(HTTP 404\).*Nothing was changed\./);
  answers.status = 500;
  assert.match((await point()).err, /Your server failed at .* \(HTTP 500\).*TEAMS_APP_ID, TEAMS_APP_PASSWORD, TEAMS_APP_TENANT_ID/);
  answers.status = 200;
  assert.match((await point()).err, /took a request with no token .* anyone could send it messages as Teams/);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.match((await point()).err, /Your server didn't answer at .*Is it running\? Nothing was changed\./);
  const far = await point('https://elsewhere.example.com');
  assert.equal(far.code, 2);
  assert.match(far.err, /--local-url is your server on this machine/);
  assert.deepEqual(t.microsoft.taken(), [], 'Teams was pointed nowhere');
});

test('point says what it waits on: connect not run, or Microsoft 365 signed out', async () => {
  const none = await setup({ file: {} });
  const first = await none.run(['point', '--public-url', PUBLIC, '--env-file', none.envFile]);
  assert.equal(first.code, 3);
  assert.match(first.err, /No TEAMS_APP_ID in .*\.env\.local\. Run connect first: voiceflow-channels connect teams --env-file/);

  const out = await setup({ ms: { signedIn: false, apps: [{ id: APP, name: 'Acme Support' }] }, file: { TEAMS_APP_ID: APP } });
  const second = await out.run(['point', '--public-url', PUBLIC, '--env-file', out.envFile]);
  assert.equal(second.code, 3);
  assert.match(second.err, /Not signed in to Microsoft 365/);
  assert.equal(out.microsoft.apps()[0].endpoint, '');
  assert.ok(!out.microsoft.taken().some((call) => call.startsWith('login')), 'nobody is signed in on their behalf');

  // A sign-in runs out in time. A person who is there (dev was started by one) signs in again, and it goes on.
  const third = await out.run(['point', '--public-url', PUBLIC, '--env-file', out.envFile], { interactive: true, env: DESKTOP });
  assert.equal(third.code, 0, third.all);
  assert.match(third.out, /Sign in to Microsoft 365, with the account you use Teams with\./);
  assert.ok(out.microsoft.taken().includes('login (shown)'));
  assert.equal(out.microsoft.apps()[0].endpoint, `${PUBLIC}/api/teams`);
});

test('disconnect says how the bot is removed, and removes nothing', async () => {
  const t = await setup({ ms: { apps: [{ id: APP, name: 'Acme Support' }] }, file: { TEAMS_APP_ID: APP } });
  const { code, err } = await t.run(['disconnect', '--env-file', t.envFile]);
  assert.equal(code, 3, "what's left is the person's to do");
  assert.match(err, /Microsoft gives no command that removes a Teams app, so this is by hand:/);
  assert.ok(err.includes(`https://dev.teams.microsoft.com/apps/${APP}`));
  assert.ok(err.includes(`/appId/${APP}`));
  assert.match(err, /The teams_\* variables stay on the agent/);
  assert.deepEqual(t.microsoft.taken(), []);
  const none = await setup({ file: {} });
  assert.equal((await none.run(['disconnect', '--env-file', none.envFile])).code, 3);
});

test("what Microsoft's command says is passed on as it said it, and never with a secret", async () => {
  const t = await setup({
    ms: {
      apps: [{ id: APP, name: 'Acme Support' }],
      fail: (args) => (args[1] === 'update' ? { code: 'API_ERROR', message: `The service refused it. (secret ${SECRET})` } : undefined),
    },
    file: { TEAMS_APP_ID: APP, TEAMS_APP_PASSWORD: SECRET },
  });
  const { code, err } = await t.run(['point', '--public-url', PUBLIC, '--env-file', t.envFile]);
  assert.equal(code, 1);
  assert.match(err, /The service refused it\./);
  assert.ok(!err.includes(SECRET), 'a secret it repeats back is taken out');

  // An app that isn't this account's.
  const gone = await setup({ file: { VOICEFLOW_API_KEY: VF_KEY, VOICEFLOW_PROJECT_ID: PROJECT.id, VOICEFLOW_ENVIRONMENT: 'development', TEAMS_APP_ID: APP } });
  const second = await connect(gone, '--yes');
  assert.equal(second.code, 1);
  assert.match(second.err, new RegExp(`Microsoft 365 has no Teams app ${APP} for the account signed in \\(Failed to fetch app details: 404 Not Found\\)`));
  assert.match(second.err, /take TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID out of your server's env file and run connect again/);
  // The same from dev's point: said, with the address left where it was.
  const pointed = await gone.run(['point', '--public-url', PUBLIC, '--env-file', gone.envFile]);
  assert.equal(pointed.code, 1);
  assert.match(pointed.err, /It was made from another account, or deleted\./);
});

test("Microsoft's command is read whatever it printed first, and its refusals keep their code", async () => {
  const noisy = fakeMs({ noise: 'npm warn exec The following package was not found and will be installed: @microsoft/teams.cli@3.1.0\n' });
  const account = await createMsCli(noisy.run).account();
  assert.deepEqual(account, { signedIn: true, username: USER, tenantId: TENANT, upload: { organization: true, person: true } });

  const out = fakeMs({ signedIn: false });
  await assert.rejects(
    createMsCli(out.run).app(APP),
    (error) => error instanceof MsCliError && error.code === 'AUTH_REQUIRED' && /Not logged in\. Run `teams login` first\./.test(error.message),
  );

  // A command that dies without a word of JSON says what it did say.
  const dead = createMsCli(async () => ({ code: 127, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' }));
  await assert.rejects(dead.account(), /stopped with code 127:\nnpm error code E404/);
});

test("Microsoft's command is the one installed in the app, or else fetched by npx, and is asked nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teams-ms-'));
  const started = [];
  const spawn = (command, args, options) => {
    started.push({ command, args, options });
    const listeners = {};
    const child = { stdout: { on() {} }, stderr: { on() {} }, once: (event, fn) => ((listeners[event] = fn), child) };
    queueMicrotask(() => listeners.close?.(0));
    return child;
  };
  // None installed: npx, pinned to the major these commands were written against.
  assert.equal(localMsCli(dir), undefined);
  await msRunner({ cwd: dir, env: { PATH: '/bin' }, spawn, platform: 'darwin' })(['status', '--json']);
  assert.equal(started[0].command, 'npx');
  assert.deepEqual(started[0].args, ['--yes', '@microsoft/teams.cli@3', 'status', '--json']);
  assert.equal(started[0].options.env.TEAMS_NO_INTERACTIVE, '1');
  assert.equal(started[0].options.shell, false);
  assert.deepEqual(started[0].options.stdio, ['ignore', 'pipe', 'pipe']);

  // Shown to a person, it has the terminal and may ask.
  await msRunner({ cwd: dir, env: {}, spawn, platform: 'darwin' })(['login'], { show: true });
  assert.equal(started[1].options.stdio, 'inherit');
  assert.equal(started[1].options.env.TEAMS_NO_INTERACTIVE, undefined);

  // On Windows npx is a .cmd file, which a shell runs: a name with a space in it stays one argument.
  await msRunner({ cwd: dir, env: {}, spawn, platform: 'win32' })(['app', 'create', '--name', 'Acme Support']);
  assert.equal(started[2].options.shell, true);
  assert.equal(started[2].args.at(-1), '"Acme Support"');

  // Installed in the app (or a folder above): that one, run by this Node, with no shell.
  const pkg = join(dir, 'node_modules', '@microsoft', 'teams.cli');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@microsoft/teams.cli', bin: { teams: './dist/index.js' } }));
  const nested = join(dir, 'apps', 'web');
  await mkdir(nested, { recursive: true });
  assert.equal(localMsCli(nested), join(pkg, 'dist', 'index.js'));
  await msRunner({ cwd: nested, env: {}, spawn, platform: 'win32' })(['status', '--json']);
  assert.equal(started[3].command, process.execPath);
  assert.deepEqual(started[3].args, [join(pkg, 'dist', 'index.js'), 'status', '--json']);
  assert.equal(started[3].options.shell, false);
});
