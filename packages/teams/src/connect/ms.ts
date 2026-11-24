// Microsoft's own command for making and changing Teams apps, run from here.
// Microsoft gives no public API for it: its Teams Developer CLI
// (`@microsoft/teams.cli`, the `teams` command) is the supported way, and it
// holds the sign-in. So connect runs that command, asks it for JSON, and reads
// what it answers. This package never sees the Microsoft account's password or
// its tokens: the command keeps them, where it keeps them for you.
//
// Node only.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const MS_CLI_PACKAGE = '@microsoft/teams.cli';
/** The major version these commands were written against and run with. */
export const MS_CLI_MAJOR = '3';
/** How a person runs Microsoft's command themselves. */
export const MS_CLI_NPX = `npx ${MS_CLI_PACKAGE}@${MS_CLI_MAJOR}`;

export interface MsOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs Microsoft's command with arguments. `show` hands it the terminal, for a
 * step a person follows there (signing in): nothing of it is read then.
 */
export type MsRun = (args: string[], options?: { show?: boolean }) => Promise<MsOutput>;

/** Microsoft's command said no: its own code (`AUTH_REQUIRED`, `INVALID_ICON`, …) and message. */
export class MsCliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MsCliError';
    this.code = code;
  }
}

/** The command installed in the app, where it is: `node_modules/@microsoft/teams.cli`, in this folder or one above. */
export function localMsCli(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const root = join(dir, 'node_modules', MS_CLI_PACKAGE);
    const manifest = join(root, 'package.json');
    if (existsSync(manifest)) {
      try {
        const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> }).bin;
        const file = typeof bin === 'string' ? bin : (bin?.teams ?? Object.values(bin ?? {})[0]);
        if (file) return join(root, file);
      } catch {
        // Not a package this can read: npx finds one.
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** An argument as cmd.exe takes it whole. Used only where a shell runs the command: Windows. */
const quoted = (arg: string) => (/^[\w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/(["^&|<>%])/g, '^$1')}"`);

export interface MsRunnerOptions {
  /** Where the app is: an install of the command there is used first. Default: this process's folder. */
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Starts a process, in place of `spawn`: for a test. */
  spawn?: typeof spawn;
  platform?: string;
}

/**
 * How Microsoft's command is run from here: the one installed in the app when
 * there is one, or else `npx`, which fetches it the first time. It is asked
 * nothing it would stop to ask a person, except where it is shown.
 */
export function msRunner(options: MsRunnerOptions = {}): MsRun {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const start = options.spawn ?? spawn;
  const windows = (options.platform ?? process.platform) === 'win32';
  return (args, { show = false } = {}) => {
    const local = localMsCli(cwd);
    // npx is npx.cmd on Windows, which only a shell runs; a shell needs each argument quoted for it.
    const [command, argv, shell] = local
      ? [process.execPath, [local, ...args], false]
      : windows
        ? ['npx', ['--yes', `${MS_CLI_PACKAGE}@${MS_CLI_MAJOR}`, ...args].map(quoted), true]
        : ['npx', ['--yes', `${MS_CLI_PACKAGE}@${MS_CLI_MAJOR}`, ...args], false];
    return new Promise<MsOutput>((done, failed) => {
      let child: ChildProcess;
      try {
        child = start(command as string, argv as string[], {
          cwd,
          shell: shell as boolean,
          stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'],
          // The command checks for a newer one of itself on every run, and stops to ask things: neither, from here.
          env: { ...env, ...(show ? {} : { TEAMS_NO_INTERACTIVE: '1' }), NO_UPDATE_NOTIFIER: '1' } as NodeJS.ProcessEnv,
        });
      } catch (error) {
        failed(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', (error) =>
        failed(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? new Error(
                `Couldn't run Microsoft's Teams command: "${command}" isn't on this machine's PATH. It comes with Node.js: ${MS_CLI_NPX} --version should print a version.`,
              )
            : error,
        ),
      );
      child.once('close', (code) => done({ code: code ?? 1, stdout, stderr }));
    });
  };
}

/** The JSON in what the command printed: it may say other things first (npm's notices, a warning). */
function jsonIn(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Something was printed before it: the JSON is the last block that starts a line with { or [.
  }
  const starts = [...trimmed.matchAll(/^[[{]/gm)].map((match) => match.index);
  for (const at of starts.reverse()) {
    try {
      return JSON.parse(trimmed.slice(at));
    } catch {
      // Not from here.
    }
  }
  return undefined;
}

/** Who is signed in to Microsoft 365 through the command, and whether they can add an app of their own to Teams. */
export interface MsAccount {
  signedIn: boolean;
  username: string;
  tenantId: string;
  /**
   * Whether Teams takes an app someone uploads themselves: for the whole
   * organization, and for this person. `null` where the command couldn't say.
   */
  upload: { organization: boolean | null; person: boolean | null };
}

export interface MsApp {
  /** The Teams app's ID. Its bot has the same one: your server's TEAMS_APP_ID. */
  id: string;
  name: string;
  version: string;
  /** Where Teams sends the bot's messages. Empty when it has no address yet. */
  endpoint: string;
  /** The link that opens the app in Teams, to add it. */
  installLink: string;
  /** The app's page in Teams' Developer Portal. */
  portalLink: string;
}

export interface MsCli {
  account(): Promise<MsAccount>;
  /** Signs in, in the terminal: the command shows a person what to do. `deviceCode` is for where no browser can open. */
  signIn(options?: { deviceCode?: boolean }): Promise<boolean>;
  /** Makes the Teams app, its bot and their secret. The credentials go to `credentialsFile`, which should exist already, readable by you alone. */
  createApp(options: { name: string; endpoint?: string; credentialsFile: string; colorIcon?: string }): Promise<MsApp>;
  app(id: string): Promise<MsApp>;
  /** Changes what's named, and nothing else. */
  updateApp(id: string, changes: { endpoint?: string; name?: string; colorIcon?: string }): Promise<{ version: string }>;
  /** A permission the app has in a team or chat it's added to (`ChannelMessage.Read.Group`). */
  addPermission(id: string, permission: string): Promise<void>;
  permissions(id: string): Promise<string[]>;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The command's calls this package makes, each asked for as JSON and read back. */
export function createMsCli(run: MsRun): MsCli {
  async function ask<T>(args: string[]): Promise<T> {
    const output = await run([...args, '--json']);
    const answer = jsonIn(output.stdout) as { ok?: boolean; error?: { code?: unknown; message?: unknown; suggestion?: unknown } } | undefined;
    if (answer && typeof answer === 'object' && !Array.isArray(answer) && answer.ok === false) {
      const { code, message, suggestion } = answer.error ?? {};
      throw new MsCliError(text(code) || 'UNKNOWN', [text(message) || 'It failed.', text(suggestion)].filter(Boolean).join(' '));
    }
    if (output.code !== 0 || answer === undefined) {
      const said = (output.stderr.trim() || output.stdout.trim()).split('\n').slice(-6).join('\n');
      throw new MsCliError(
        'UNKNOWN',
        `Microsoft's Teams command (teams ${args[0]} ${args[1] ?? ''}) ${output.code !== 0 ? `stopped with code ${output.code}` : "didn't answer"}${said ? `:\n${said}` : '.'}`,
      );
    }
    return answer as T;
  }
  const appOf = (value: any, fallback: Partial<MsApp> = {}): MsApp => ({
    id: text(value?.teamsAppId) || text(value?.appId) || fallback.id || '',
    name: text(value?.name) || text(value?.appName) || fallback.name || '',
    version: text(value?.version) || fallback.version || '',
    endpoint: text(value?.endpoint) || fallback.endpoint || '',
    installLink: text(value?.installLink),
    portalLink: text(value?.portalLink),
  });
  return {
    async account() {
      const status = await ask<any>(['status']);
      const upload = status?.tdp?.sideloading ?? {};
      const flag = (value: unknown) => (typeof value === 'boolean' ? value : null);
      return {
        signedIn: status?.loggedIn === true,
        username: text(status?.username),
        tenantId: text(status?.tenantId),
        upload: { organization: flag(upload.tenant), person: flag(upload.user) },
      };
    },
    async signIn({ deviceCode = false } = {}) {
      const output = await run(['login', ...(deviceCode ? ['--device-code'] : [])], { show: true });
      return output.code === 0;
    },
    async createApp({ name, endpoint, credentialsFile, colorIcon }) {
      const made = await ask<any>([
        'app',
        'create',
        '--name',
        name,
        ...(endpoint ? ['--endpoint', endpoint] : []),
        '--env',
        credentialsFile,
        ...(colorIcon ? ['--color-icon', colorIcon] : []),
        '--teams-managed',
        '--yes',
      ]);
      const app = appOf(made, { name, endpoint: endpoint ?? '', version: '1.0.0' });
      if (!app.id) throw new MsCliError('UNKNOWN', "Microsoft's Teams command made an app and didn't say which.");
      return app;
    },
    async app(id) {
      return appOf(await ask<any>(['app', 'get', id]), { id });
    },
    async updateApp(id, changes) {
      const updated = await ask<any>([
        'app',
        'update',
        id,
        ...(changes.endpoint ? ['--endpoint', changes.endpoint] : []),
        ...(changes.name ? ['--name', changes.name] : []),
        ...(changes.colorIcon ? ['--color-icon', changes.colorIcon] : []),
      ]);
      return { version: text(updated?.updated?.version) };
    },
    async addPermission(id, permission) {
      await ask(['app', 'rsc', 'add', id, permission, '--type', 'Application']);
    },
    async permissions(id) {
      const listed = await ask<unknown>(['app', 'rsc', 'list', id]);
      return Array.isArray(listed) ? listed.map((entry) => text((entry as { name?: unknown })?.name)).filter(Boolean) : [];
    },
  };
}
