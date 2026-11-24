// What every channel's connect command does the same way: read and write the
// server's env file, ask a person a question (a secret unseen), find the
// Voiceflow key and the agent, and offer to publish. A channel's command adds
// only what is its platform's: how to sign in, and what to make there.
//
// Nothing here prints a secret. Node only.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { NeedsYou } from './errors.js';
import { type DraftChanges, draftChanges, type EnvironmentOptions, formatDraftChanges, publishEnvironment } from './install.js';

export type Say = (line: string) => void;

/**
 * A value that reads the same in every env file parser with no quotes around it. A `~` is one of its characters
 * (Microsoft's app secrets have one) except where a shell would read it as a home folder: first, or after a colon.
 */
export const BARE = /^(?!~)(?!.*:~)[\w.:/@+=,~-]+$/;

/** Sets these keys in an env file, keeping its other lines, readable only by you. */
export async function writeEnvFile(path: string, values: Record<string, string | undefined>): Promise<void> {
  const set = Object.entries(values).filter((e): e is [string, string] => Boolean(e[1]));
  if (!set.length) return;
  let lines: string[] = [];
  try {
    lines = (await readFile(path, 'utf8')).split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (lines.at(-1) === '') lines.pop();
  for (const [key, value] of set) {
    const i = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  // A new file, readable only by you from the start, renamed over the old one:
  // the secrets never go into a file someone else can read.
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}`);
  try {
    await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The Voiceflow values in an env file, or any others: its `KEY=value` lines,
 * with or without `export` and quotes. A file that isn't there is an empty one.
 */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    // Unquoted, a value ends where a comment starts.
    values[match[1]!] = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '');
  }
  return values;
}

/**
 * The Voiceflow API key: from the file that holds only it, the environment, the
 * server's env file, or (asked of a person) a hidden prompt. `typed` says it
 * came from the prompt, so it can be saved for the server.
 */
export async function voiceflowKey(from: {
  file?: string;
  env: Record<string, string | undefined>;
  inFile: Record<string, string>;
  envFile?: string;
  interactive: boolean;
  secret: (question: string) => Promise<string>;
}): Promise<{ value: string; typed: boolean }> {
  if (from.file) {
    const key = (await readFile(from.file, 'utf8')).trim();
    if (!key) throw new Error(`${from.file} is empty.`);
    return { value: key, typed: false };
  }
  if (from.env.VOICEFLOW_API_KEY) return { value: from.env.VOICEFLOW_API_KEY, typed: false };
  if (from.inFile.VOICEFLOW_API_KEY) return { value: from.inFile.VOICEFLOW_API_KEY, typed: false };
  if (!from.interactive) {
    throw new NeedsYou(`No Voiceflow API key: set VOICEFLOW_API_KEY${from.envFile ? `, here or in ${from.envFile},` : ''} or pass --key-file.`);
  }
  const key = await from.secret('Voiceflow API key (hidden): ');
  if (!key) throw new Error('No Voiceflow API key entered.');
  return { value: key, typed: true };
}

/**
 * Reads a line from the terminal without showing it. It reads raw keystrokes and
 * writes only the prompt, so nothing typed reaches the screen: not as it's
 * typed, and not when a terminal would redraw the line (a backspace, a wrap).
 */
export function hidden(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const wasRaw = input.isRaw;
    let value = '';
    // An escape sequence (an arrow key, say) is skipped whole. inEscape: 1 after ESC, 2 inside `ESC [`, 3 after `ESC O`.
    let inEscape = 0;
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const key of decoder.write(chunk)) {
        if (inEscape === 1) inEscape = key === '[' ? 2 : key === 'O' ? 3 : 0;
        else if (inEscape === 2) inEscape = key >= '@' && key <= '~' ? 0 : 2;
        else if (inEscape === 3) inEscape = 0;
        else if (key === '\x1b') inEscape = 1;
        else if (key === '\r' || key === '\n' || key === '\x04') return finish();
        else if (key === '\x03') return finish(new Error('Cancelled.'));
        else if (key === '\x7f' || key === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (key === '\x15') value = '';
        else if (key >= ' ') value += key;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

/** Asks a question in the terminal and resolves with the answer, trimmed. */
export function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── The agent, the env file, and publishing: the same for every channel ─────

/** Who is there to answer, and where what's said goes. */
export interface SetupIO {
  interactive: boolean;
  ask(question: string): Promise<string>;
  out: Say;
  err: Say;
}

/**
 * Which agent: its project and environment. A flag wins, then the environment,
 * then the env file; a person is asked for what's left. `waiting` says what a
 * script still lacks, for the one stop that lists everything; `missing` names
 * the flags a person who was asked left blank.
 */
export async function resolveAgent(
  given: { project?: string; environment?: string },
  from: { env: Record<string, string | undefined>; inFile: Record<string, string>; envFile?: string } & Pick<SetupIO, 'interactive' | 'ask'>,
): Promise<{ project: string; environment: string; missing: string[]; waiting: string[] }> {
  let project = given.project || from.env.VOICEFLOW_PROJECT_ID || from.inFile.VOICEFLOW_PROJECT_ID || '';
  let environment = given.environment || from.env.VOICEFLOW_ENVIRONMENT || from.inFile.VOICEFLOW_ENVIRONMENT || '';
  if (!project && from.interactive) project = (await from.ask('Voiceflow project ID: ')).trim();
  if (!environment && from.interactive) environment = (await from.ask('Voiceflow environment to install the tools into (development, say): ')).trim();
  const where = from.envFile ? `, here or in ${from.envFile},` : '';
  return {
    project,
    environment,
    missing: [...(project ? [] : ['--project (or VOICEFLOW_PROJECT_ID)']), ...(environment ? [] : ['--environment (or VOICEFLOW_ENVIRONMENT)'])],
    waiting: [
      ...(project ? [] : [`No Voiceflow project: set VOICEFLOW_PROJECT_ID${where} or pass --project. It's your agent's project ID in Voiceflow.`]),
      ...(environment ? [] : [`No Voiceflow environment: set VOICEFLOW_ENVIRONMENT${where} or pass --environment (development, say).`]),
    ],
  };
}

/**
 * Writes to the env file what the server needs and the file doesn't say yet:
 * never over a value that's there. A value an env file would read back as
 * something else (a space, a quote, a `#`, a `$`) is yours to write. Returns
 * the names it wrote.
 */
export async function saveEnv(
  file: { envFile?: string; inFile: Record<string, string> },
  values: readonly (readonly [name: string, value: string])[],
  io: Pick<SetupIO, 'out' | 'err'>,
): Promise<string[]> {
  const { envFile } = file;
  const absent = envFile ? values.filter(([name, value]) => value && !file.inFile[name]) : [];
  const saved = absent.filter(([, value]) => BARE.test(value));
  if (envFile && saved.length) {
    await writeEnvFile(envFile, Object.fromEntries(saved));
    io.out(`+ saved ${saved.map(([name]) => name).join(', ')} to ${envFile}`);
  }
  for (const [name, value] of absent) {
    if (!BARE.test(value)) io.err(`! ${name} wasn't saved to ${envFile}: its value needs quoting there. Add it yourself.`);
  }
  return saved.map(([name]) => name);
}

/** What a run was told about publishing. */
export interface PublishFlags {
  publish: boolean;
  noPublish: boolean;
}

/** The line a plan ends on: what happens to publishing once the plan is done. */
export function publishPlanLine(environment: string, flags: PublishFlags, interactive: boolean, installs: boolean): string {
  if (!installs && !flags.publish) return `  · ${environment} is left as it is: no tools were installed for a publish to carry`;
  if (flags.noPublish) return `  · you're shown what ${environment}'s draft holds; it is not published (--no-publish)`;
  if (flags.publish) return `  + publish ${environment}: its whole draft goes live (--publish)`;
  return interactive
    ? `  ? you're shown what ${environment}'s draft holds, and asked whether to publish it`
    : `  · you're shown what ${environment}'s draft holds; it is published only with --publish`;
}

/**
 * Says what the environment's draft holds that isn't live, and publishes it
 * when that's wanted: by --publish, or by a person's yes. Publishing makes the
 * whole draft live, so nothing is published for a script that didn't ask. The
 * draft is read either way: whether the agent has what was installed is said
 * from what's there, never assumed.
 */
export async function publishStep(
  voiceflow: EnvironmentOptions,
  flags: PublishFlags,
  io: SetupIO,
  release: { name: string; description?: string },
  installed: boolean,
): Promise<'published' | 'not' | 'failed'> {
  const { environment } = voiceflow;
  if (!installed && !flags.publish) return 'not';
  let waiting: DraftChanges | undefined;
  try {
    waiting = await draftChanges(voiceflow);
  } catch (error) {
    io.err(`! Couldn't read what ${environment}'s draft holds: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (waiting && waiting.created + waiting.updated + waiting.deleted === 0) {
    io.out(`\n= ${environment} is published: nothing in its draft is waiting`);
    return 'published';
  }
  io.out(`\n${waiting ? formatDraftChanges(environment, waiting).join('\n') : `${environment}'s draft may hold changes that aren't live.`}`);
  if (flags.noPublish) {
    io.out(`${environment} is not published (--no-publish).`);
    return 'not';
  }
  if (!flags.publish && !io.interactive) {
    io.out(`${environment} is not published: run this again with --publish, or publish it in Voiceflow.`);
    return 'not';
  }
  if (!flags.publish && !/^y(es)?$/i.test((await io.ask(`\nPublish ${environment} now? Its whole draft goes live, not only these tools. [y/N] `)).trim())) {
    io.out(`${environment} is not published.`);
    return 'not';
  }
  try {
    const { release: made } = await publishEnvironment({ ...voiceflow, ...release });
    io.out(`+ published ${environment} (release "${made}")`);
    return 'published';
  } catch (error) {
    io.err(`! Voiceflow didn't publish ${environment}: ${error instanceof Error ? error.message : String(error)}. Publish it in Voiceflow.`);
    return 'failed';
  }
}

/**
 * For a plan that is only shown: what the environment's draft holds already,
 * so whoever decides can say "go ahead" and "publish" (or not) in one answer.
 */
export async function previewPublish(voiceflow: EnvironmentOptions, flags: PublishFlags, io: Pick<SetupIO, 'out' | 'err'>, installs: boolean): Promise<void> {
  const { environment } = voiceflow;
  if (flags.noPublish || (!installs && !flags.publish)) return;
  try {
    const waiting = await draftChanges(voiceflow);
    const nothing = waiting.created + waiting.updated + waiting.deleted === 0;
    io.out(
      nothing
        ? `\n${environment}'s draft holds nothing else that isn't live: a publish would carry only what's above.`
        : `\n${formatDraftChanges(environment, waiting).join('\n')}\nA publish would carry these too, with what's above: its whole draft goes live.`,
    );
  } catch (error) {
    io.err(`! Couldn't read what ${environment}'s draft holds: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── The bot's picture ────────────────────────────────────────────────────────
// A bot looks like the agent it speaks for: its picture is the agent's avatar in
// Voiceflow, or Voiceflow's icon for an agent that has none. Each channel gives
// the image to its platform its own way.

/** An image to give a platform, or why there is none. */
export type IconFile = { file: File } | { problem: string };

const MAX_ICON_BYTES = 10 * 1024 * 1024;

/**
 * Voiceflow's icon, for an agent with no avatar: the brand's butterfly on its
 * blue, as Voiceflow's own agent avatar draws it (made by scripts/make-icon.mjs
 * from the website's mark and colour tokens; 512 pixels, a size Slack and
 * Discord both take).
 */
const VOICEFLOW_ICON = new URL('../assets/voiceflow-icon.png', import.meta.url);
export const VOICEFLOW_ICON_NAME = "Voiceflow's icon";

export async function voiceflowIcon(): Promise<IconFile> {
  try {
    return { file: new File([await readFile(fileURLToPath(VOICEFLOW_ICON))], 'voiceflow-icon.png', { type: 'image/png' }) };
  } catch (error) {
    return { problem: `it isn't in this package (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` };
  }
}

/** Downloads an image to be a bot's picture, or says why it couldn't. */
export async function downloadIcon(url: string, doFetch: typeof fetch = fetch): Promise<IconFile> {
  let res: Response;
  try {
    res = await doFetch(url);
  } catch (error) {
    return { problem: `it couldn't be downloaded (${(error as Error).message})` };
  }
  if (!res.ok) return { problem: `it couldn't be downloaded (HTTP ${res.status})` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_ICON_BYTES) return { problem: 'it is larger than 10 MB' };
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'icon';
  return { file: new File([bytes], name, { type }) };
}

/** A URL a picture may be downloaded from. */
export function iconUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// ── A page in the person's browser ───────────────────────────────────────────
// Where a platform leaves a step to a person (Discord: making the application,
// adding the bot to a server), the command opens the page for it, so the step
// is the page's own clicks and no hunting for it.

/**
 * Whether a browser opened from here would be the person's own: not over SSH
 * (it would open on the far machine), not in CI, and on Linux only with a display.
 */
export function canOpenBrowser(env: Record<string, string | undefined> = process.env, platform: string = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT || env.CI) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return platform === 'linux' && Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Opens a web page in the person's browser. Resolves to whether it could: it never throws, and the caller prints
 * the link either way. `run` starts the platform's opener, in place of `spawn`: for a test.
 */
export function openInBrowser(url: string, platform: string = process.platform, run: typeof spawn = spawn): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return Promise.resolve(false);
  // No shell: the link is passed as it is, whatever it holds.
  const [command, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = run(command as string, args as string[], { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
