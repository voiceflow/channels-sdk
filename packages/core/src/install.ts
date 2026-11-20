// Installs a channel's tools on a Voiceflow agent through Voiceflow's public
// API (`realtime-api.voiceflow.com`). It never publishes: it writes the
// environment's draft and compiles it, so the tools can be tried before anyone
// publishes them.
//
// Each tool is installed once. An install record (per project, environment and
// channel) remembers what was installed, so a tool you remove or detach is
// never added again, and a function you've edited is never overwritten.
//
// Node only: kept out of the package's main entry, which runs anywhere.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ChannelsError } from './errors.js';
import { DEFAULT_PATHS, type ToolDefinition, type ToolSet } from './tools.js';

export const DEFAULT_API_URL = 'https://realtime-api.voiceflow.com';
export const DEFAULT_RECORD_PATH = '.voiceflow/channels-install.json';
/** The editor's default variable colour. */
const VARIABLE_COLOR = '#515A63';

// ── The install record ──────────────────────────────────────────────────────

export interface InstalledTool {
  functionID: string;
  /** The agent tool attaching the function, once attached. */
  toolID?: string;
  version: number;
  /** A hash of the code installed: a function whose code no longer matches was edited, and is never overwritten. */
  codeHash: string;
  installedAt: string;
  updatedAt?: string;
  /** Removed (by you in Voiceflow, or by uninstall). Never added again unless restored by name. */
  removed?: { at: string; by: 'you' | 'uninstall' };
}

export interface InstallRecord {
  version: 1;
  /** Keyed `<projectID>/<environment>/<channel>`. */
  installs: Record<string, { tools: Record<string, InstalledTool> }>;
}

/** Where install records are kept. The default is a JSON file; keep it with your deployment's code. */
export interface RecordStore {
  read(): Promise<InstallRecord | null>;
  write(record: InstallRecord): Promise<void>;
}

export function fileRecordStore(path: string = DEFAULT_RECORD_PATH): RecordStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as InstallRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(record) {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
      await rename(temp, path);
    },
  };
}

export function memoryRecordStore(initial: InstallRecord | null = null): RecordStore & { record: InstallRecord | null } {
  const store = {
    record: initial,
    async read() {
      return store.record && structuredClone(store.record);
    },
    async write(record: InstallRecord) {
      store.record = structuredClone(record);
    },
  };
  return store;
}

// ── Voiceflow's API ─────────────────────────────────────────────────────────

export interface ApiOptions {
  /** A Voiceflow API key with access to the project. Read it from the environment or a prompt; it is never printed. */
  apiKey: string;
  apiURL?: string;
  fetch?: typeof fetch;
}

type Query = Record<string, string | boolean | undefined>;

export function createVoiceflowApi(options: ApiOptions) {
  const base = (options.apiURL ?? DEFAULT_API_URL).replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  return async function call<T = any>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const search = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${base}${path}${search ? `?${search}` : ''}`;
    const headers: Record<string, string> = { authorization: options.apiKey, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        message = parsed.message ?? parsed.error ?? message;
      } catch {}
      throw new ChannelsError('voiceflow_http', `Voiceflow ${method} ${path} answered ${res.status}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  };
}

export type VoiceflowApi = ReturnType<typeof createVoiceflowApi>;

// ── Planning ────────────────────────────────────────────────────────────────

export interface InstallOptions extends ApiOptions {
  projectID: string;
  /** The environment alias to install into (`development`, say). Its draft is changed and compiled; nothing is published. */
  environment: string;
  /**
   * The workspace the project must belong to. The install stops before writing
   * anything when the project reports another.
   */
  expectWorkspace?: string;
  /** Install only these tools, by name. Default: all. */
  only?: readonly string[];
  /** Tools to add again although they were removed, by name. */
  restore?: readonly string[];
  /** Values for the set's secrets, by name, written to the environment's draft and published versions. Never printed. */
  secretValues?: Readonly<Record<string, string>>;
  record?: RecordStore;
  /** Plan only: read the project, write nothing. */
  dryRun?: boolean;
  /** Compile the environment when something changed. Default: `true`. */
  compile?: boolean;
  /** Called with each step as it completes. */
  onStep?: (step: Step) => void;
}

export type ToolAction =
  /** Not on the agent: created and attached. */
  | 'create'
  /** Created by an install that stopped partway: attached now. */
  | 'attach'
  /** An earlier version you haven't edited: updated to this one. */
  | 'update'
  /** Already installed at this version. */
  | 'current'
  /** Left alone; `reason` says why. */
  | 'skip'
  /** Uninstall: detached and its function deleted. */
  | 'remove'
  /** Uninstall: detached, and its function kept because you edited it. */
  | 'detach';

export type Step =
  | { kind: 'variable'; name: string; action: 'create' | 'exists' }
  | { kind: 'secret'; name: string; action: 'create' | 'exists'; value: 'set' | 'unchanged' | 'missing' }
  | { kind: 'tool'; name: string; action: ToolAction; reason?: string; from?: number; to?: number }
  | { kind: 'compile'; action: 'compile' | 'skip' };

export interface InstallResult {
  project: { id: string; name: string; workspaceID: string };
  environment: string;
  steps: Step[];
  /** `false` for a dry run. */
  applied: boolean;
  /** Problems found after writing, such as a `{name}` Voiceflow couldn't resolve. */
  problems: string[];
}

interface Remote {
  functions: { id: string; name: string; code: string }[];
  variables: { id: string; name: string }[];
  secrets: { id: string; name: string; hasValue: boolean }[];
  tools: { id: string; type: string; functionID?: string }[];
}

export function codeHash(code: string): string {
  return `sha256:${createHash('sha256').update(code).digest('hex')}`;
}

function recordKey(projectID: string, environment: string, channel: string): string {
  return `${projectID}/${environment}/${channel}`;
}

/** Reads the project, and stops (writing nothing) when it isn't in `expectWorkspace`. */
export async function checkProject(options: ApiOptions & Pick<InstallOptions, 'projectID' | 'expectWorkspace'>) {
  return readProject(createVoiceflowApi(options), options);
}

async function readProject(api: VoiceflowApi, options: Pick<InstallOptions, 'projectID' | 'expectWorkspace'>) {
  const { project } = await api<{ project: { id: string; name: string; workspaceID: string; image?: string | null } }>(
    'GET',
    `/v1/stable/project/${encodeURIComponent(options.projectID)}`,
  );
  if (options.expectWorkspace && project.workspaceID !== options.expectWorkspace) {
    throw new ChannelsError(
      'wrong_workspace',
      `Project ${project.id} is in workspace ${project.workspaceID}, not ${options.expectWorkspace}. Nothing was changed.`,
    );
  }
  // The agent's avatar in Voiceflow, when it has one.
  return {
    id: project.id,
    name: project.name,
    workspaceID: project.workspaceID,
    ...(typeof project.image === 'string' && project.image ? { image: project.image } : {}),
  };
}

async function readRemote(api: VoiceflowApi, projectID: string, environmentAlias: string): Promise<Remote> {
  const q = { projectID, environmentAlias };
  const [functions, variables, secrets, tools] = await Promise.all([
    api('GET', '/v1/stable/function', q),
    api('GET', '/v2/stable/variable', q),
    api('GET', '/v2/stable/secret', { projectID }),
    api('GET', '/v2/stable/tool', { ...q, global: true }),
  ]);
  return { functions: functions.functions ?? [], variables: variables.variables ?? [], secrets: secrets.secrets ?? [], tools: tools.tools ?? [] };
}

function planTool(def: ToolDefinition, installed: InstalledTool | undefined, remote: Remote, restore: boolean): Step & { kind: 'tool' } {
  const step = (action: ToolAction, reason?: string, extra: object = {}) => ({
    kind: 'tool' as const,
    name: def.name,
    action,
    ...(reason ? { reason } : {}),
    ...extra,
  });
  if (installed?.removed && !restore) {
    return step(
      'skip',
      installed.removed.by === 'uninstall' ? 'uninstalled; restore it by name to add it again' : 'removed from the agent; restore it by name to add it again',
    );
  }
  const fn = installed && (!installed.removed || restore) ? remote.functions.find((f) => f.id === installed.functionID) : undefined;
  if (installed && !installed.removed && !fn && !restore) return step('skip', 'removed from the agent; restore it by name to add it again');
  if (installed && fn) {
    const attached = remote.tools.some((t) => t.functionID === fn.id);
    if (!attached && installed.toolID && !restore) return step('skip', 'detached from the agent; restore it by name to attach it again');
    const edited = codeHash(fn.code) !== installed.codeHash;
    // An update attaches the function too when it isn't attached.
    if (!edited && installed.version < def.version) return step('update', undefined, { from: installed.version, to: def.version });
    if (!attached) return step('attach', installed.toolID ? 'restored' : 'an earlier install stopped before attaching it');
    if (edited && installed.version < def.version) return step('skip', `edited in Voiceflow, so version ${def.version} wasn't installed over it`);
    return step('current', edited ? 'edited in Voiceflow' : undefined);
  }
  if (remote.functions.some((f) => f.name === def.name)) return step('skip', `a function named ${def.name} already exists on the agent`);
  return step('create');
}

// ── Installing ──────────────────────────────────────────────────────────────

/** Plans the set's install and, unless `dryRun`, applies it. */
export async function installTools(set: ToolSet, options: InstallOptions): Promise<InstallResult> {
  const api = createVoiceflowApi(options);
  const store = options.record ?? fileRecordStore();
  const env = options.environment;
  if (!env) throw new TypeError('installTools: `environment` is required');
  const project = await readProject(api, options);
  const remote = await readRemote(api, project.id, env);
  const record: InstallRecord = (await store.read()) ?? { version: 1, installs: {} };
  const key = recordKey(project.id, env, set.channel);
  const installs = (record.installs[key] ??= { tools: {} }).tools;

  const unknown = (options.only ?? []).filter((n) => !set.tools.some((t) => t.name === n));
  if (unknown.length) throw new TypeError(`installTools: no ${set.channel} tool named ${unknown.join(', ')}`);
  const tools = set.tools.filter((t) => !options.only || options.only.includes(t.name));
  const restore = new Set(options.restore ?? []);

  const steps: Step[] = [];
  for (const name of Object.keys(set.variables ?? {})) {
    steps.push({ kind: 'variable', name, action: remote.variables.some((v) => v.name === name) ? 'exists' : 'create' });
  }
  for (const name of Object.keys(set.secrets ?? {})) {
    const existing = remote.secrets.find((s) => s.name === name);
    const given = Boolean(options.secretValues?.[name]);
    steps.push({ kind: 'secret', name, action: existing ? 'exists' : 'create', value: given ? 'set' : existing?.hasValue ? 'unchanged' : 'missing' });
  }
  const toolSteps = tools.map((def) => planTool(def, installs[def.name], remote, restore.has(def.name)));
  steps.push(...toolSteps);
  const changes = steps.some((s) => s.action === 'create' || s.action === 'update' || s.action === 'attach' || (s.kind === 'secret' && s.value === 'set'));
  steps.push({ kind: 'compile', action: changes && options.compile !== false ? 'compile' : 'skip' });

  const result: InstallResult = { project, environment: env, steps, applied: false, problems: [] };
  if (options.dryRun) return result;

  const q = { projectID: project.id, environmentAlias: env };
  const report = (step: Step) => options.onStep?.(step);
  const save = () => store.write(record);
  const now = () => new Date().toISOString();

  // Tools whose functions were removed in Voiceflow are recorded as such, so later installs leave them out.
  for (const s of toolSteps) {
    const installed = installs[s.name];
    if (s.action === 'skip' && installed && !installed.removed && !remote.functions.some((f) => f.id === installed.functionID)) {
      installed.removed = { at: now(), by: 'you' };
    }
  }

  for (const s of steps) {
    if (s.kind === 'variable' && s.action === 'create') {
      await api('POST', '/v2/stable/variable', q, { name: s.name, color: VARIABLE_COLOR, description: set.variables![s.name] ?? null });
      report(s);
    }
    if (s.kind === 'secret') {
      let id = remote.secrets.find((x) => x.name === s.name)?.id;
      if (s.action === 'create') {
        // Created without a value: a value given at creation would go to main's published version.
        id = (await api('POST', '/v2/stable/secret', { projectID: project.id }, { name: s.name, visibility: 'restricted' })).secret.id;
      }
      const value = options.secretValues?.[s.name];
      if (value && id) {
        for (const versionVariant of ['draft', 'published'] as const) {
          await api('PUT', `/v1/stable/secret/${encodeURIComponent(id)}/value`, { projectID: project.id }, { value, environmentAlias: env, versionVariant });
        }
      }
      if (s.action === 'create' || value) report(s);
    }
  }

  for (const s of toolSteps) {
    const def = tools.find((t) => t.name === s.name)!;
    if (s.action === 'create') {
      const fn = await createFunction(api, q, def);
      installs[def.name] = { functionID: fn.id, version: def.version, codeHash: codeHash(def.code), installedAt: now() };
      await save();
      const attached = await attach(api, q, def, fn.id, fn.variables);
      installs[def.name]!.toolID = attached.id;
      result.problems.push(...attached.problems);
      await save();
      report(s);
    } else if (s.action === 'attach') {
      const installed = installs[def.name]!;
      // The function may have been edited: its variables are left as they are.
      const variables = await readVariables(api, q, installed.functionID);
      const attached = await attach(api, q, def, installed.functionID, variables);
      installed.toolID = attached.id;
      delete installed.removed;
      result.problems.push(...attached.problems);
      await save();
      report(s);
    } else if (s.action === 'update') {
      const installed = installs[def.name]!;
      await api('PATCH', `/v1/stable/function/${encodeURIComponent(installed.functionID)}`, q, functionBody(def));
      const variables = await syncVariables(api, q, def, installed.functionID);
      await syncPaths(api, q, def, installed.functionID);
      let toolID = remote.tools.find((t) => t.functionID === installed.functionID)?.id;
      if (toolID) {
        const res = await api('PATCH', `/v2/stable/tool/${encodeURIComponent(toolID)}`, q, {
          type: 'function',
          description: def.description,
          inputVariables: wiring(def, variables),
        });
        result.problems.push(...unresolved(def, res));
      } else {
        const attached = await attach(api, q, def, installed.functionID, variables);
        toolID = attached.id;
        result.problems.push(...attached.problems);
      }
      Object.assign(installed, { toolID, version: def.version, codeHash: codeHash(def.code), updatedAt: now() });
      delete installed.removed;
      await save();
      report(s);
    } else if (s.action === 'skip' || s.action === 'current') {
      report(s);
    }
  }
  await save();

  const compile = steps.find((s) => s.kind === 'compile')!;
  if (compile.action === 'compile') {
    await api('PUT', `/v1/stable/environment/${encodeURIComponent(env)}/compile`, { projectID: project.id });
    report(compile);
  }
  result.applied = true;
  return result;
}

function functionBody(def: ToolDefinition) {
  return {
    name: def.name,
    code: def.code,
    description: def.description,
    ...(def.timeoutMs ? { settings: { timeoutMs: def.timeoutMs } } : {}),
  };
}

type Q = { projectID: string; environmentAlias: string };
type FunctionVariables = Record<string, { id: string; type: 'input' | 'output' }>;

async function createFunction(api: VoiceflowApi, q: Q, def: ToolDefinition): Promise<{ id: string; variables: FunctionVariables }> {
  const { function: fn } = await api('POST', '/v1/stable/function', q, functionBody(def));
  const variables = await syncVariables(api, q, def, fn.id);
  await syncPaths(api, q, def, fn.id);
  return { id: fn.id, variables };
}

/** Makes the function's input and output variables match the definition's. */
async function syncVariables(api: VoiceflowApi, q: Q, def: ToolDefinition, functionID: string): Promise<FunctionVariables> {
  const { variables: existing = [] } = await api('GET', '/v1/stable/function-variable', { ...q, functionID });
  const want: [string, 'input' | 'output', string][] = [
    ...Object.entries(def.inputs).map(([n, i]) => [n, 'input', i.description] as [string, 'input', string]),
    ...Object.entries(def.outputs ?? {}).map(([n, d]) => [n, 'output', d] as [string, 'output', string]),
  ];
  const out: FunctionVariables = {};
  for (const [name, type, description] of want) {
    const found = existing.find((v: any) => v.name === name && v.type === type);
    const id = found ? found.id : (await api('POST', '/v1/stable/function-variable', q, { name, type, functionID, description })).variable.id;
    if (found && found.description !== description) await api('PATCH', `/v1/stable/function-variable/${encodeURIComponent(found.id)}`, q, { description });
    out[name] = { id, type };
  }
  for (const v of existing) {
    if (!want.some(([n, t]) => n === v.name && t === v.type)) await api('DELETE', `/v1/stable/function-variable/${encodeURIComponent(v.id)}`, q);
  }
  return out;
}

/** The function's variables as they are, for attaching a function that may have been edited. Inputs it lacks are left out of the wiring. */
async function readVariables(api: VoiceflowApi, q: Q, functionID: string): Promise<FunctionVariables> {
  const { variables: existing = [] } = await api('GET', '/v1/stable/function-variable', { ...q, functionID });
  const out: FunctionVariables = {};
  for (const v of existing) out[v.name] = { id: v.id, type: v.type };
  return out;
}

async function syncPaths(api: VoiceflowApi, q: Q, def: ToolDefinition, functionID: string): Promise<void> {
  const { paths: existing = [] } = await api('GET', '/v1/stable/function-path', { ...q, functionID });
  for (const name of def.paths ?? DEFAULT_PATHS) {
    if (!existing.some((p: any) => p.name === name)) await api('POST', '/v1/stable/function-path', q, { name, functionID });
  }
}

/** The agent tool's inputs: those with `from` are filled by the runtime and never asked of the model. */
function wiring(def: ToolDefinition, variables: FunctionVariables) {
  return Object.fromEntries(
    Object.entries(def.inputs)
      .filter(([name]) => variables[name]?.type === 'input')
      .map(([name, input]) => [
        name,
        {
          functionInputVariableID: variables[name]!.id,
          description: input.description,
          ...(input.from ? { defaultValue: `{${input.from}}`, required: false } : { required: true }),
        },
      ]),
  );
}

async function attach(
  api: VoiceflowApi,
  q: Q,
  def: ToolDefinition,
  functionID: string,
  variables: FunctionVariables,
): Promise<{ id: string; problems: string[] }> {
  const res = await api('POST', '/v2/stable/tool', q, {
    type: 'function',
    functionID,
    target: { global: true },
    description: def.description,
    inputVariables: wiring(def, variables),
    asyncExecution: false,
  });
  return { id: res.tool.id, problems: unresolved(def, res) };
}

function unresolved(def: ToolDefinition, res: { unresolvedReferences?: { token: string; path?: string }[] }): string[] {
  return (res.unresolvedReferences ?? []).map(
    (r) => `${def.name}: Voiceflow couldn't resolve {${r.token}}${r.path ? ` at ${r.path}` : ''}; the input gets that text literally`,
  );
}

// ── Uninstalling ────────────────────────────────────────────────────────────

export type UninstallOptions = Omit<InstallOptions, 'restore' | 'secretValues'>;

/**
 * Takes the set's installed tools off the agent: each is detached and its
 * function deleted, except a function you edited, which is only detached. The
 * record marks them uninstalled, so a later install leaves them out until
 * restored by name. Variables and secrets stay: other parts of the agent may use them.
 */
export async function uninstallTools(set: ToolSet, options: UninstallOptions): Promise<InstallResult> {
  const api = createVoiceflowApi(options);
  const store = options.record ?? fileRecordStore();
  const env = options.environment;
  if (!env) throw new TypeError('uninstallTools: `environment` is required');
  const project = await readProject(api, options);
  const remote = await readRemote(api, project.id, env);
  const record: InstallRecord = (await store.read()) ?? { version: 1, installs: {} };
  const installs = record.installs[recordKey(project.id, env, set.channel)]?.tools ?? {};
  const names = set.tools.map((t) => t.name).filter((n) => !options.only || options.only.includes(n));

  const steps: Step[] = [];
  for (const name of names) {
    const installed = installs[name];
    const fn = installed && !installed.removed ? remote.functions.find((f) => f.id === installed.functionID) : undefined;
    if (!installed) steps.push({ kind: 'tool', name, action: 'skip', reason: 'not installed by this package' });
    else if (installed.removed) steps.push({ kind: 'tool', name, action: 'skip', reason: 'already removed' });
    else if (!fn) steps.push({ kind: 'tool', name, action: 'skip', reason: 'already removed from the agent' });
    else if (codeHash(fn.code) !== installed.codeHash)
      steps.push({ kind: 'tool', name, action: 'detach', reason: 'edited in Voiceflow, so the function is kept' });
    else steps.push({ kind: 'tool', name, action: 'remove' });
  }
  const changes = steps.some((s) => s.action === 'remove' || s.action === 'detach');
  steps.push({ kind: 'compile', action: changes && options.compile !== false ? 'compile' : 'skip' });
  const result: InstallResult = { project, environment: env, steps, applied: false, problems: [] };
  if (options.dryRun) return result;

  const q = { projectID: project.id, environmentAlias: env };
  const at = new Date().toISOString();
  for (const s of steps) {
    if (s.kind !== 'tool') continue;
    const installed = installs[s.name];
    if (installed && !installed.removed && s.action === 'skip') installed.removed = { at, by: 'you' };
    if (s.action === 'remove' || s.action === 'detach') {
      for (const t of remote.tools.filter((t) => t.functionID === installed!.functionID)) {
        await api('DELETE', `/v2/stable/tool/${encodeURIComponent(t.id)}`, { ...q, type: 'function' });
      }
      if (s.action === 'remove') await api('DELETE', `/v1/stable/function/${encodeURIComponent(installed!.functionID)}`, q);
      installed!.removed = { at, by: 'uninstall' };
      await store.write(record);
    }
    options.onStep?.(s);
  }
  await store.write(record);
  const compile = steps.at(-1)!;
  if (compile.action === 'compile') {
    await api('PUT', `/v1/stable/environment/${encodeURIComponent(env)}/compile`, { projectID: project.id });
    options.onStep?.(compile);
  }
  result.applied = true;
  return result;
}

// ── Showing a plan ──────────────────────────────────────────────────────────

/** One line per step, for a person to read before applying. */
export function formatStep(step: Step): string {
  switch (step.kind) {
    case 'variable':
      return step.action === 'create' ? `+ variable ${step.name}` : `= variable ${step.name} (exists)`;
    case 'secret': {
      const value = { set: 'value set from what you gave', unchanged: 'value unchanged', missing: 'NO VALUE: the tools that read it fail until one is set' }[
        step.value
      ];
      return `${step.action === 'create' ? '+' : '='} secret ${step.name} (${step.action === 'create' ? 'new, restricted' : 'exists'}; ${value})`;
    }
    case 'tool': {
      const mark = { create: '+', attach: '+', update: '~', current: '=', skip: '·', remove: '-', detach: '-' }[step.action];
      const what = {
        create: 'create and attach',
        attach: 'attach',
        update: `update v${step.from} → v${step.to}`,
        current: 'installed',
        skip: 'left alone',
        remove: 'detach and delete',
        detach: 'detach',
      }[step.action];
      return `${mark} tool ${step.name}: ${what}${step.reason ? ` (${step.reason})` : ''}`;
    }
    case 'compile':
      return step.action === 'compile' ? '~ compile the environment (nothing is published)' : '= nothing to compile';
  }
}
