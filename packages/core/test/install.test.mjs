// The installer, against a fake of Voiceflow's API: what it writes, what it
// never writes, and the install record that keeps a removed tool removed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { functionSource } from '../dist/index.js';
import {
  codeHash,
  draftChanges,
  formatDraftChanges,
  formatStep,
  installTools,
  memoryRecordStore,
  publishEnvironment,
  uninstallTools,
} from '../dist/install.js';
import { fakeVoiceflowApi, runFunction } from '../dist/testing.js';

const PROJECT = { id: 'proj1', name: 'Spike', workspaceID: 'ws1' };
const KEY = 'VF.DM.test-key';
const SECRET = 'xoxb-never-printed';

async function echo(args) {
  const { text, who } = args.inputVars;
  return { outputVars: { said: `${who}: ${text}` }, next: { path: 'success' } };
}

function tool(overrides = {}) {
  return {
    name: 'demo_echo',
    description: 'Echo text back. Call it when asked to echo.',
    code: functionSource(echo),
    inputs: {
      text: { description: 'What to echo.' },
      who: { description: 'Who is asking.', from: 'demo_user' },
      token: { description: 'The bot token.', from: 'demo_token' },
    },
    outputs: { said: 'What was echoed.' },
    version: 1,
    kind: 'workspace',
    ...overrides,
  };
}

const SET = (tools = [tool()]) => ({
  channel: 'demo',
  variables: { demo_user: 'Who is talking.' },
  secrets: { demo_token: 'The bot token.' },
  tools,
});

function setup(fail) {
  const api = fakeVoiceflowApi({ project: PROJECT, apiKey: KEY, fail });
  const record = memoryRecordStore();
  const opts = (more = {}) => ({ apiKey: KEY, projectID: PROJECT.id, environment: 'sdk-test', fetch: api.fetch, record, ...more });
  return { api, record, opts };
}

const actions = (result) => Object.fromEntries(result.steps.filter((s) => s.kind === 'tool').map((s) => [s.name, s.action]));

test("a value never goes into an existing secret that isn't restricted: the install stops before any write", async () => {
  const { api, record, opts } = setup();
  api.state.secrets.push({ id: 'sec_masked', name: 'demo_token', visibility: 'masked', hasValue: true });
  for (const dryRun of [true, false]) {
    await assert.rejects(
      installTools(SET(), opts({ dryRun, secretValues: { demo_token: SECRET } })),
      (e) => e.code === 'secret_not_restricted' && /demo_token/.test(e.message) && /Nothing was changed/.test(e.message) && !e.message.includes(SECRET),
    );
  }
  assert.deepEqual(api.writes(), []);
  assert.deepEqual(api.state.secretValues, []);
  assert.equal(record.record, null);
});

test('an existing restricted secret gets the value, and the plan says it is restricted', async () => {
  const { api, opts } = setup();
  api.state.secrets.push({ id: 'sec_kept', name: 'demo_token', visibility: 'restricted', hasValue: false });
  const result = await installTools(SET(), opts({ secretValues: { demo_token: SECRET } }));
  assert.ok(result.steps.map(formatStep).includes('= secret demo_token (exists, restricted; value set from what you gave)'));
  assert.deepEqual(
    api.state.secretValues.map((v) => [v.secretID, v.environmentAlias, v.versionVariant]),
    [
      ['sec_kept', 'sdk-test', 'draft'],
      ['sec_kept', 'sdk-test', 'published'],
    ],
  );
  assert.equal(api.state.secrets.length, 1);
});

test('a plan shows an existing secret that is not restricted, when no value is given', async () => {
  const { api, opts } = setup();
  api.state.secrets.push({ id: 'sec_masked', name: 'demo_token', visibility: 'masked', hasValue: true });
  const result = await installTools(SET(), opts({ dryRun: true }));
  assert.ok(result.steps.map(formatStep).includes('= secret demo_token (exists, NOT restricted: its value can be revealed in Voiceflow; value unchanged)'));
});

test('a project in another workspace stops the install before any write', async () => {
  const { api, opts } = setup();
  await assert.rejects(
    installTools(SET(), opts({ expectWorkspace: 'ws-other' })),
    (e) => e.code === 'wrong_workspace' && /Nothing was changed/.test(e.message),
  );
  assert.deepEqual(api.writes(), []);
  assert.equal(api.state.calls.length, 1, 'only the project was read');
});

test('a dry run plans and writes nothing', async () => {
  const { api, record, opts } = setup();
  const result = await installTools(SET(), opts({ dryRun: true, expectWorkspace: 'ws1', secretValues: { demo_token: SECRET } }));
  assert.equal(result.applied, false);
  assert.deepEqual(api.writes(), []);
  assert.equal(record.record, null);
  assert.deepEqual(result.steps.map(formatStep), [
    '+ variable demo_user',
    '+ secret demo_token (new, restricted; value set from what you gave)',
    '+ tool demo_echo: create and attach',
    '~ compile the environment (nothing is published)',
  ]);
});

test('an install creates the variables, secret, function and its wiring, compiles, and never publishes', async () => {
  const { api, record, opts } = setup();
  const steps = [];
  const result = await installTools(SET(), opts({ expectWorkspace: 'ws1', secretValues: { demo_token: SECRET }, onStep: (s) => steps.push(s) }));
  const { state } = api;

  assert.equal(result.applied, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    state.variables.map((v) => [v.name, v.color, v.description]),
    [['demo_user', '#515A63', 'Who is talking.']],
  );
  assert.deepEqual(
    state.secrets.map((s) => [s.name, s.visibility]),
    [['demo_token', 'restricted']],
  );
  // The value goes to the target environment's draft and published versions, never main's through creation.
  assert.deepEqual(
    state.secretValues.map((v) => [v.environmentAlias, v.versionVariant]),
    [
      ['sdk-test', 'draft'],
      ['sdk-test', 'published'],
    ],
  );
  assert.ok(!api.writes().some((c) => c.path === '/v2/stable/secret' && 'defaultValue' in c.body));

  const [fn] = state.functions;
  assert.equal(fn.name, 'demo_echo');
  assert.equal(fn.code, tool().code);
  assert.deepEqual(
    state.functionVariables.map((v) => [v.name, v.type]),
    [
      ['text', 'input'],
      ['who', 'input'],
      ['token', 'input'],
      ['said', 'output'],
    ],
  );
  assert.deepEqual(
    state.functionPaths.map((p) => p.name),
    ['success', 'error'],
  );

  const [attached] = state.tools;
  assert.equal(attached.functionID, fn.id);
  assert.deepEqual(attached.target, { global: true });
  assert.equal(attached.description, tool().description);
  const wiring = Object.fromEntries(Object.entries(attached.inputVariables).map(([k, v]) => [k, [v.defaultValue ?? null, v.required]]));
  assert.deepEqual(wiring, { text: [null, true], who: ['{demo_user}', false], token: ['{demo_token}', false] });

  assert.deepEqual(state.compiles, ['sdk-test']);
  assert.ok(!state.calls.some((c) => /publish/i.test(c.path)), 'nothing is published');
  assert.ok(!JSON.stringify([result, steps, record.record]).includes(SECRET), 'the secret value is never in a result, step or record');

  const installed = record.record.installs['proj1/sdk-test/demo'].tools.demo_echo;
  assert.equal(installed.functionID, fn.id);
  assert.equal(installed.toolID, attached.id);
  assert.equal(installed.codeHash, codeHash(fn.code));
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['variable', 'secret', 'tool', 'compile'],
  );
});

test('installing again changes nothing and compiles nothing', async () => {
  const { api, opts } = setup();
  await installTools(SET(), opts());
  const before = api.writes().length;
  const result = await installTools(SET(), opts());
  assert.deepEqual(actions(result), { demo_echo: 'current' });
  assert.equal(api.writes().length, before);
  assert.deepEqual(result.steps.at(-1), { kind: 'compile', action: 'skip' });
});

test('a tool you deleted in Voiceflow is never added again, until restored by name', async () => {
  const { api, record, opts } = setup();
  await installTools(SET(), opts());
  api.state.functions.length = 0;
  api.state.tools.length = 0;

  const again = await installTools(SET(), opts());
  assert.deepEqual(actions(again), { demo_echo: 'skip' });
  assert.match(again.steps.find((s) => s.kind === 'tool').reason, /removed from the agent/);
  assert.equal(api.state.functions.length, 0);
  assert.equal(record.record.installs['proj1/sdk-test/demo'].tools.demo_echo.removed.by, 'you');

  // Still left out on a later run, even with a newer version.
  const later = await installTools(SET([tool({ version: 2 })]), opts());
  assert.deepEqual(actions(later), { demo_echo: 'skip' });

  const restored = await installTools(SET(), opts({ restore: ['demo_echo'] }));
  assert.deepEqual(actions(restored), { demo_echo: 'create' });
  assert.equal(api.state.tools.length, 1);
  assert.equal(record.record.installs['proj1/sdk-test/demo'].tools.demo_echo.removed, undefined);
});

test('a tool you detached stays detached until restored, which attaches it again', async () => {
  const { api, opts } = setup();
  await installTools(SET(), opts());
  api.state.tools.length = 0;
  assert.deepEqual(actions(await installTools(SET(), opts())), { demo_echo: 'skip' });
  assert.equal(api.state.tools.length, 0);
  assert.deepEqual(actions(await installTools(SET(), opts({ restore: ['demo_echo'] }))), { demo_echo: 'attach' });
  assert.equal(api.state.tools.length, 1);
  assert.equal(api.state.functions.length, 1, 'the same function, not a copy');
});

test('a newer version updates a tool you have not edited, and its wiring', async () => {
  const { api, opts } = setup();
  await installTools(SET(), opts());
  async function echo2(args) {
    const { text, who, tone } = args.inputVars;
    return { outputVars: { said: `${who} (${tone}): ${text}` }, next: { path: 'success' } };
  }
  const v2 = tool({ version: 2, code: functionSource(echo2), inputs: { ...tool().inputs, tone: { description: 'How to say it.' } } });
  const result = await installTools(SET([v2]), opts());
  assert.deepEqual(
    result.steps.find((s) => s.kind === 'tool'),
    { kind: 'tool', name: 'demo_echo', action: 'update', from: 1, to: 2 },
  );
  assert.equal(api.state.functions.length, 1);
  assert.equal(api.state.functions[0].code, v2.code);
  assert.ok(api.state.functionVariables.some((v) => v.name === 'tone' && v.type === 'input'));
  assert.ok('tone' in api.state.tools[0].inputVariables);
  assert.deepEqual(api.state.compiles.length, 2);
});

test('a function you edited is never overwritten by a newer version', async () => {
  const { api, opts } = setup();
  await installTools(SET(), opts());
  api.state.functions[0].code += '\n// mine';
  const result = await installTools(SET([tool({ version: 2, code: `${tool().code}\n// v2` })]), opts());
  assert.deepEqual(actions(result), { demo_echo: 'skip' });
  assert.match(result.steps.find((s) => s.kind === 'tool').reason, /edited in Voiceflow/);
  assert.ok(api.state.functions[0].code.endsWith('// mine'));
});

test('a function with the same name that this package did not install is left alone', async () => {
  const { api, opts } = setup();
  api.state.functions.push({ id: 'theirs', name: 'demo_echo', code: 'x', description: null, settings: null });
  const result = await installTools(SET(), opts());
  assert.deepEqual(actions(result), { demo_echo: 'skip' });
  assert.equal(api.state.functions.length, 1);
  assert.equal(api.state.tools.length, 0);
});

test('an install that stops partway resumes where it stopped', async () => {
  let failAttach = true;
  const { api, record, opts } = setup((call) => failAttach && call.method === 'POST' && call.path === '/v2/stable/tool');
  await assert.rejects(installTools(SET(), opts()), (e) => e.code === 'voiceflow_http' && /500/.test(e.message));
  const installed = record.record.installs['proj1/sdk-test/demo'].tools.demo_echo;
  assert.ok(installed.functionID && !installed.toolID, 'the function was recorded before attaching');
  failAttach = false;
  const result = await installTools(SET(), opts());
  assert.deepEqual(actions(result), { demo_echo: 'attach' });
  assert.equal(api.state.functions.length, 1);
  assert.equal(api.state.tools.length, 1);
});

test('a {name} Voiceflow cannot resolve is reported as a problem', async () => {
  const { opts } = setup();
  const broken = tool({ inputs: { ...tool().inputs, team: { description: 'The team.', from: 'nowhere' } } });
  const result = await installTools(SET([broken]), opts());
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /demo_echo: Voiceflow couldn't resolve \{nowhere\}/);
});

test('only and unknown names', async () => {
  const { api, opts } = setup();
  const two = SET([tool(), tool({ name: 'demo_other' })]);
  const result = await installTools(two, opts({ only: ['demo_other'] }));
  assert.deepEqual(actions(result), { demo_other: 'create' });
  assert.deepEqual(
    api.state.functions.map((f) => f.name),
    ['demo_other'],
  );
  await assert.rejects(installTools(two, opts({ only: ['demo_nope'] })), /no demo tool named demo_nope/);
});

test('uninstall deletes what it installed, keeps what you edited, and a later install leaves both out', async () => {
  const { api, record, opts } = setup();
  const two = SET([tool(), tool({ name: 'demo_other' })]);
  await installTools(two, opts());
  api.state.functions.find((f) => f.name === 'demo_other').code += '\n// mine';

  const plan = await uninstallTools(two, opts({ dryRun: true }));
  assert.deepEqual(plan.steps.map(formatStep), [
    '- tool demo_echo: detach and delete',
    '- tool demo_other: detach (edited in Voiceflow, so the function is kept)',
    '~ compile the environment (nothing is published)',
  ]);
  assert.equal(api.state.tools.length, 2);

  await uninstallTools(two, opts());
  assert.deepEqual(
    api.state.functions.map((f) => f.name),
    ['demo_other'],
  );
  assert.equal(api.state.tools.length, 0);
  assert.equal(api.state.variables.length, 1, 'variables stay');
  assert.equal(api.state.secrets.length, 1, 'secrets stay');
  const tools = record.record.installs['proj1/sdk-test/demo'].tools;
  assert.equal(tools.demo_echo.removed.by, 'uninstall');

  const after = await installTools(two, opts());
  assert.deepEqual(actions(after), { demo_echo: 'skip', demo_other: 'skip' });

  // Restoring the kept function attaches it again rather than making a copy.
  const restored = await installTools(two, opts({ restore: ['demo_echo', 'demo_other'] }));
  assert.deepEqual(actions(restored), { demo_echo: 'create', demo_other: 'attach' });
  assert.equal(api.state.functions.filter((f) => f.name === 'demo_other').length, 1);
});

test('functionSource composes helpers and main, and runs in the sandbox', async () => {
  function shout(text) {
    return String(text).toUpperCase();
  }
  async function main(args) {
    return { outputVars: { loud: shout(args.inputVars.text) }, next: { path: 'success' } };
  }
  const code = functionSource(main, [shout]);
  assert.match(code, /^function shout\(text\)/);
  assert.match(code, /export default async function main\(args\)/);
  assert.deepEqual(await runFunction(code, { text: 'hi' }), { outputVars: { loud: 'HI' }, next: { path: 'success' } });
  assert.throws(() => functionSource(async (a) => a), /entry must be/);
  assert.throws(() => functionSource(main, [(x) => x]), /named function declaration/);
});

test('the sandbox has no Node or browser globals, and fetch carries json as a property', async () => {
  async function main() {
    return { outputVars: { kinds: [typeof URLSearchParams, typeof Buffer, typeof process, typeof setTimeout, typeof atob, typeof URL].join(',') } };
  }
  assert.deepEqual(await runFunction(functionSource(main), {}), { outputVars: { kinds: 'undefined,undefined,undefined,undefined,undefined,undefined' } });

  async function fetches() {
    const res = await fetch('https://example.test/x', { method: 'POST' });
    return { outputVars: { ok: res.ok, value: res.json.value, text: res.text } };
  }
  const fake = async () => new Response(JSON.stringify({ value: 7 }), { status: 200 });
  assert.deepEqual(await runFunction(functionSource(fetches), {}, { fetch: fake }), { outputVars: { ok: true, value: 7, text: '{"value":7}' } });
});

// ── Publishing ──────────────────────────────────────────────────────────────

test('an install leaves its work in the draft; publishing is a step of its own, which says what it made live', async () => {
  const { api, opts } = setup();
  await installTools(SET(), opts({ secretValues: { demo_token: SECRET } }));
  assert.deepEqual(api.state.publishes, [], 'the install published nothing');

  const waiting = await draftChanges(opts());
  assert.deepEqual(
    { created: waiting.created, updated: waiting.updated, deleted: waiting.deleted, truncated: waiting.truncated },
    { created: 3, updated: 0, deleted: 0, truncated: false },
  );
  assert.deepEqual(waiting.resources.map((r) => `${r.change} ${r.type} ${r.name}`).sort(), [
    'created function demo_echo',
    'created tool demo_echo',
    'created variable demo_user',
  ]);

  // Each change is read as what it is; one this package doesn't know is an update, never a guess at more.
  api.state.draft.push({ type: 'variable', id: 'gone', name: 'old_name', change: 'deleted' }, { type: 'agent', id: 'a1', name: 'Support', change: 'moved' });
  const mixed = await draftChanges(opts());
  assert.deepEqual(
    mixed.resources.filter((r) => r.name === 'old_name' || r.name === 'Support').map((r) => `${r.change} ${r.type} ${r.name}`),
    ['deleted variable old_name', 'updated agent Support'],
  );
  assert.equal(mixed.deleted, 1);

  const { release } = await publishEnvironment(opts({ name: 'Demo tools', description: 'From a test.' }));
  assert.equal(release, 'Demo tools');
  assert.deepEqual(api.state.publishes, [{ environment: 'sdk-test', name: 'Demo tools', description: 'From a test.' }]);
  const call = api.state.calls.find((c) => c.method === 'POST' && c.path.endsWith('/publish'));
  assert.equal(call.path, '/v1/stable/environment/sdk-test/publish');
  assert.deepEqual(call.query, { projectID: 'proj1' });
  const after = await draftChanges(opts());
  assert.equal(after.created + after.updated + after.deleted, 0, 'nothing is left waiting');
});

test('nothing is read or published for a project in another workspace, and a failure never carries the key', async () => {
  const { api, opts } = setup();
  for (const act of [() => draftChanges(opts({ expectWorkspace: 'ws-other' })), () => publishEnvironment(opts({ expectWorkspace: 'ws-other', name: 'x' }))]) {
    await assert.rejects(act(), (e) => e.code === 'wrong_workspace' && /Nothing was changed/.test(e.message));
  }
  assert.ok(!api.state.calls.some((c) => /\/(diff|publish)$/.test(c.path)), 'neither was called');
  assert.deepEqual(api.state.publishes, []);

  const failing = setup((call) => call.path.endsWith('/publish'));
  await assert.rejects(
    publishEnvironment(failing.opts({ name: 'x' })),
    (e) => /Voiceflow POST \/v1\/stable\/environment\/sdk-test\/publish answered 500/.test(e.message) && !e.message.includes(KEY),
  );
  assert.deepEqual(failing.api.state.publishes, []);
});

test("a draft's changes read as lines: how many, the first of them by name, and how many more", () => {
  const none = { created: 0, updated: 0, deleted: 0, resources: [], truncated: false };
  assert.deepEqual(formatDraftChanges('development', none), ["development's draft holds nothing that isn't live."]);
  const one = { ...none, updated: 1, resources: [{ type: 'agent', name: 'Support', change: 'updated' }] };
  assert.deepEqual(formatDraftChanges('development', one), ["development's draft holds a change that isn't live (1 updated):", '  ~ agent Support']);
  const many = {
    created: 3,
    updated: 1,
    deleted: 1,
    resources: [
      { type: 'function', name: 'a', change: 'created' },
      { type: 'tool', name: 'a', change: 'created' },
      { type: 'variable', name: 'old', change: 'deleted' },
    ],
    truncated: true,
  };
  assert.deepEqual(formatDraftChanges('main', many, 2), [
    "main's draft holds 5 changes that aren't live (3 created, 1 updated, 1 deleted):",
    '  + function a',
    '  + tool a',
    '  … and 3 more',
  ]);
});
