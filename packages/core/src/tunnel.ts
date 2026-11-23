// A public address for a server on this machine, for as long as it's needed.
//
// A channel's platform sends to your server, and so does the agent when it
// calls a tool that runs there. On a laptop that takes a tunnel. This starts
// one (a Cloudflare quick tunnel: no account, and an address that's new each
// time) and stops it when asked. When cloudflared isn't installed it says how
// to get it, and with Homebrew there and a person's yes, installs it.
//
// Nothing here is a secret: a tunnel's address is public by nature, and what
// crosses it is signed by the platform or carries a turn's pass. Node only.
import { type ChildProcess, spawn } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { NeedsYou } from './errors.js';

/** Where Cloudflare says how to install cloudflared. */
export const TUNNEL_DOCS = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
export const TUNNEL_INSTALL_BREW = 'brew install cloudflared';

export interface Tunnel {
  /** The public address, without a trailing slash: `https://….trycloudflare.com`. */
  url: string;
  close(): Promise<void>;
}

/** The machine a tunnel runs on. A test stands in for each part. */
export interface TunnelHost {
  platform: NodeJS.Platform;
  /** Where a command is, or undefined when it isn't installed. */
  find(name: 'cloudflared' | 'brew'): string | undefined;
  /** Starts a long-running command. `line` gets each line it prints, `exit` its end. */
  start(command: string, args: string[], on: { line(text: string): void; exit(code: number | null): void }): { stop(): Promise<void> };
  /** Runs a command a person sees and answers. Resolves with its exit code. */
  run(command: string, args: string[]): Promise<number>;
  /** Whether the public DNS has a name yet, asked of a public resolver directly and never of this machine's own. */
  known(hostname: string): Promise<boolean>;
  fetch: typeof fetch;
  wait(ms: number): Promise<void>;
}

export interface TunnelOptions {
  /** The local port the tunnel forwards to. */
  port: number;
  /** Whether a person is there to answer. */
  interactive: boolean;
  ask(question: string): Promise<string>;
  say(line: string): void;
  /** The way to do without a tunnel, said wherever one can't be made: "Or give connect your server's address with --public-url." */
  instead: string;
  host?: Partial<TunnelHost>;
  /** How long to wait for the tunnel's address, and then for it to answer. Default 30 s each. */
  timeoutMs?: number;
}

/** Starts a tunnel to a local port, and resolves once its address answers from outside. */
export async function startTunnel(options: TunnelOptions): Promise<Tunnel> {
  const host: TunnelHost = { ...defaultHost(), ...options.host };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cloudflared = await tunnelTool(options, host);

  const printed: string[] = [];
  let found: (url: string) => void = () => {};
  let failed: (error: Error) => void = () => {};
  const address = new Promise<string>((resolve, reject) => {
    found = resolve;
    failed = reject;
  });
  const running = host.start(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${options.port}`], {
    line: (text) => {
      printed.push(text);
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
      if (url) found(url);
    },
    exit: (code) => failed(new Error(`cloudflared stopped before it gave an address (exit ${code ?? 'by signal'})${last(printed)}`)),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cloudflared gave no address in ${Math.round(timeoutMs / 1000)} seconds${last(printed)}`)), timeoutMs);
  });
  let url: string;
  try {
    url = await Promise.race([address, late]);
  } catch (error) {
    await running.stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  // A new address isn't in DNS for a few seconds, and this machine's resolver remembers a miss for far longer than
  // that: asked too soon, it says "no such name" long after the name exists. So a public resolver is asked first,
  // directly, and the machine's own (through fetch) only once the name is there.
  const hostname = new URL(url).hostname;
  for (const giveUp = Date.now() + Math.min(timeoutMs, 15_000); !(await host.known(hostname)); ) {
    // No public resolver in reach, perhaps. By now the name has had long enough, and nothing here has asked for it.
    if (Date.now() > giveUp) break;
    await host.wait(500);
  }
  // Then wait until it answers, so whoever is told the address can reach it.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // Any answer will do: nothing may be listening on the port yet, and the tunnel says so itself.
      await host.fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
      break;
    } catch {
      if (Date.now() > deadline) {
        await running.stop();
        throw new Error(`The tunnel's address (${url}) didn't start answering in ${Math.round(timeoutMs / 1000)} seconds. Run this again. ${options.instead}`);
      }
      await host.wait(1000);
    }
  }
  return { url, close: () => running.stop() };
}

/**
 * Whether a tunnel can be started here without asking anyone: cloudflared is
 * installed. Throws `NeedsYou`, saying how to get it, when it isn't.
 */
export function checkTunnelTool(options: Pick<TunnelOptions, 'instead' | 'host'>): void {
  const host: TunnelHost = { ...defaultHost(), ...options.host };
  if (!host.find('cloudflared')) throw new NeedsYou(installFirst(host, options.instead));
}

/** cloudflared's path: found, or installed with Homebrew on a person's yes. */
async function tunnelTool(options: TunnelOptions, host: TunnelHost): Promise<string> {
  const found = host.find('cloudflared');
  if (found) return found;
  const brew = host.find('brew');
  if (!options.interactive || !brew) throw new NeedsYou(installFirst(host, options.instead));
  options.say(
    `A tunnel gives this machine a public address. It needs cloudflared, which isn't installed. Homebrew can install it:\n\n  ${TUNNEL_INSTALL_BREW}\n`,
  );
  if (!/^y(es)?$/i.test((await options.ask('Run it now? [y/N] ')).trim()))
    throw new NeedsYou(`Install cloudflared (${TUNNEL_DOCS}), then run this again. ${options.instead}`);
  const code = await host.run(brew, ['install', 'cloudflared']);
  const installed = host.find('cloudflared');
  if (code !== 0 || !installed) {
    throw new Error(
      `cloudflared wasn't installed (${code !== 0 ? `Homebrew exited ${code}` : "it isn't on the PATH"}). Install it yourself (${TUNNEL_DOCS}), then run this again.`,
    );
  }
  return installed;
}

function installFirst(host: TunnelHost, instead: string): string {
  const how = host.find('brew') ? `:\n\n  ${TUNNEL_INSTALL_BREW}\n\n(or see ${TUNNEL_DOCS})` : ` (${TUNNEL_DOCS})`;
  return `A tunnel gives this machine a public address. It needs cloudflared, which isn't installed. Install it${how}${how.endsWith(')') ? '.' : ''} Then run this again. ${instead}`;
}

/** The last of what a command printed, short enough for an error. */
function last(lines: string[]): string {
  const text = lines.slice(-4).join(' ').replace(/\s+/g, ' ').trim();
  return text ? `: ${text.slice(-400)}` : '.';
}

function defaultHost(): TunnelHost {
  return {
    platform: process.platform,
    find,
    start,
    run: (command, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      }),
    known: async (hostname) => {
      const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers(['1.1.1.1', '8.8.8.8']);
      return resolver.resolve4(hostname).then(
        (addresses) => addresses.length > 0,
        () => false,
      );
    },
    fetch: (input, init) => fetch(input, init),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** A command on the PATH, or where Homebrew puts things. */
function find(name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'].filter(Boolean);
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function start(command: string, args: string[], on: { line(text: string): void; exit(code: number | null): void }): { stop(): Promise<void> } {
  const child: ChildProcess = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let rest = '';
  const read = (chunk: Buffer) => {
    const lines = (rest + chunk.toString('utf8')).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) on.line(line);
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);
  const ended = new Promise<void>((resolve) => {
    child.once('error', () => {
      on.exit(null);
      resolve();
    });
    child.once('close', (code) => {
      on.exit(code);
      resolve();
    });
  });
  return {
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      // A tunnel that won't go is killed: nothing may be left holding an address open.
      const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
      await ended;
      clearTimeout(forced);
    },
  };
}
