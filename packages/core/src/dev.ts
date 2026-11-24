// `voiceflow-channels dev -- <your server's command>`: local development in
// one command. It opens a tunnel to your server's port, starts the server,
// and has each channel in the app point its platform, and the agent's tools,
// at the tunnel's address. A quick tunnel's address is new each time, so this
// is done on every start. Stopping it stops the server and the tunnel.
//
// A channel takes part by having its connect module (`@voiceflow/channels-<name>/connect`)
// answer `cli(['point', '--public-url', <address>, '--local-url', <the server here>, …])`.
// It is given the local address so that it can check the server answers, with a
// request signed as its platform signs one, before the platform is pointed at it.
// A channel whose platform sends over a standing connection (Discord's Gateway)
// also exports `listen`: dev holds that connection open beside the server, and
// closes it when it stops. And one that exports `connected` is connected first
// when it never was: one command sets the channel up and starts it. Node only.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { NeedsYou } from './errors.js';
import { startTunnel, type Tunnel, type TunnelHost } from './tunnel.js';

export { checkTunnelTool, startTunnel, TUNNEL_DOCS, TUNNEL_INSTALL_BREW, type Tunnel, type TunnelHost, type TunnelOptions } from './tunnel.js';

export const DEV_USAGE = `Usage:
  voiceflow-channels dev [options] -- <your server's command>
  voiceflow-channels dev [options]            (your server is running already)

Local development in one command. It opens a tunnel to your server's port,
starts the server, and points each channel in this app, and the agent's tools,
at the tunnel's address: a quick tunnel's address is new each time. Stop it
with Ctrl-C: the server and the tunnel stop with it.

Options:
  --port <n>            your server's port (default: PORT, or 3000); the server's
                        command is started with PORT set to it
  --env-file <path>     your server's env file, passed on to each channel
  --public-url <url>    use this address and start no tunnel
  --channel <name>      a channel to point; default: every @voiceflow/channels-*
                        package this app depends on. Repeat it for several
  -h, --help            show this`;

/** A server started by `dev`: what it needs to know of the child. */
export interface DevServer {
  /** Resolves with the exit code when the server stops. */
  exited: Promise<number>;
  stop(): Promise<void>;
}

/** What a channel's connect module gives `dev`. */
export interface ChannelCommands {
  /** The channel's command: `dev` runs its `point`. */
  cli(argv: string[]): Promise<number>;
  /**
   * Holds the platform's standing connection open, passing what arrives to the
   * server at `localUrl`, until `signal` aborts. Rejects if it can't.
   */
  listen?(options: { localUrl: string; envFile?: string; signal: AbortSignal; out: (line: string) => void; err: (line: string) => void }): Promise<void>;
  /**
   * Whether the channel has been connected from here. When it hasn't, dev is
   * starting the server itself, and a person is there, dev runs the channel's
   * connect first: `cli(['connect', '--from-dev', '--env-file', <path>])`. A
   * channel that exports this takes `--from-dev`, which says the server starts next.
   */
  connected?(options: { envFile?: string; env: Record<string, string | undefined> }): boolean | Promise<boolean>;
}

/** What `dev` reads, writes and runs, for a test or a program that runs it. */
export interface DevIO {
  out?: (line: string) => void;
  err?: (line: string) => void;
  cwd?: string;
  env?: Record<string, string | undefined>;
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  /** Starts the server's command. */
  serve?: (command: string, args: string[], env: Record<string, string | undefined>) => DevServer;
  /** A channel's commands, by name: by default its connect module. A bare function is its `cli`. */
  channel?: (name: string) => Promise<ChannelCommands | ((argv: string[]) => Promise<number>)>;
  tunnel?: Partial<TunnelHost>;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  /** Ends `dev`, as Ctrl-C does. */
  signal?: AbortSignal;
}

/** Runs `dev`. Returns its exit code: 0 when stopped, the server's when it stopped itself, 3 when it waits on a person. */
export async function dev(argv: string[], io: DevIO = {}): Promise<number> {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  try {
    return await run(argv, io, out, err);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return error instanceof NeedsYou ? 3 : 1;
  }
}

async function run(argv: string[], io: DevIO, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const split = argv.indexOf('--');
  const command = split < 0 ? [] : argv.slice(split + 1);
  const { values: o, positionals } = parseArgs({
    args: split < 0 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'env-file': { type: 'string' },
      'public-url': { type: 'string' },
      channel: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (o.help) {
    out(DEV_USAGE);
    return 0;
  }
  if (positionals.length) {
    err(`dev takes your server's command after "--": voiceflow-channels dev -- ${positionals.join(' ')}\n\n${DEV_USAGE}`);
    return 2;
  }
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const port = Number(o.port ?? env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    err(`"${o.port ?? env.PORT}" isn't a port.`);
    return 2;
  }
  const channels = o.channel?.length ? o.channel : channelsOf(cwd);
  if (!channels.length) {
    err('No channel to point: this app depends on no @voiceflow/channels-* package. Install one, or name it with --channel.');
    return 2;
  }
  if (channels.some((name) => !/^[a-z0-9-]+$/.test(name))) {
    err(`A channel's name is lowercase letters, digits and "-": ${channels.join(', ')}.`);
    return 2;
  }
  const doFetch = io.fetch ?? fetch;
  const wait = io.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const local = `http://127.0.0.1:${port}`;
  const answers = () =>
    doFetch(local, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    );

  let tunnel: Tunnel | undefined;
  let server: DevServer | undefined;
  // Standing connections a channel asked dev to hold: closed first, so nothing arrives for a server that's going.
  const listening = new AbortController();
  const listeners: Promise<void>[] = [];
  const stop = async () => {
    listening.abort();
    await Promise.allSettled(listeners);
    await server?.stop();
    await tunnel?.close();
  };
  try {
    // A server already on the port, with a command to start one, would be two servers: say so before anything is started.
    if (command.length && (await answers())) {
      err(`Something already answers on port ${port}. Stop it, give dev another --port, or run dev without a command to use the server that's there.`);
      return 1;
    }
    if (!command.length && !(await answers())) {
      err(`Nothing answers on port ${port}. Start your server there, or give dev its command: voiceflow-channels dev -- <command>.`);
      return 1;
    }

    const interactive = io.interactive ?? Boolean(process.stdin.isTTY);
    const loaded = new Map<string, ChannelCommands>();
    for (const name of channels) {
      const got = await (io.channel ?? channelCli)(name);
      loaded.set(name, typeof got === 'function' ? { cli: got } : got);
    }
    // A channel that was never connected from here is connected first, so one command sets it up and starts it.
    // Only for a person who is there (connect asks things), and only where dev starts the server: one that's
    // running already was started without what connect writes.
    if (command.length && interactive) {
      for (const [name, commands] of loaded) {
        if (!commands.connected || (await commands.connected({ ...(o['env-file'] ? { envFile: o['env-file'] } : {}), env }))) continue;
        out(`${name} isn't connected yet, so that comes first.\n`);
        const code = await commands.cli(['connect', '--from-dev', ...(o['env-file'] ? ['--env-file', o['env-file']] : [])]);
        if (code !== 0) {
          err(`\n${name} wasn't connected, so dev is stopping.`);
          return code;
        }
        out('');
      }
    }

    let url = o['public-url']?.replace(/\/+$/, '');
    if (!url) {
      tunnel = await startTunnel({
        port,
        interactive,
        ask: io.ask ?? question,
        say: out,
        instead: 'Or start no tunnel, and give dev your own address: --public-url https://<host>.',
        ...(io.tunnel ? { host: io.tunnel } : {}),
      });
      url = tunnel.url;
      out(`tunnel: ${url} → ${local}`);
    }

    if (command.length) {
      server = (io.serve ?? serve)(command[0]!, command.slice(1), { ...env, PORT: String(port) });
      // Up means it answers: until then nothing is pointed at it.
      let stopped: number | undefined;
      void server.exited.then((code) => {
        stopped = code;
      });
      for (const deadline = Date.now() + 120_000; !(await answers()); ) {
        if (stopped !== undefined) {
          err(`The server's command stopped before it answered on port ${port} (exit ${stopped}).`);
          return stopped || 1;
        }
        if (Date.now() > deadline) {
          err(`The server's command didn't answer on port ${port} in two minutes. Is that its port? Give dev the right one with --port.`);
          return 1;
        }
        await wait(250);
      }
    }

    let lost: (code: number) => void = () => {};
    const connectionLost = new Promise<number>((resolve) => {
      lost = resolve;
    });
    for (const [name, commands] of loaded) {
      const code = await commands.cli(['point', '--public-url', url, '--local-url', local, ...(o['env-file'] ? ['--env-file', o['env-file']] : [])]);
      if (code !== 0) {
        err(`\n${name} wasn't pointed at ${url}, so dev is stopping.`);
        return code;
      }
      if (commands.listen) {
        listeners.push(
          commands.listen({ localUrl: local, ...(o['env-file'] ? { envFile: o['env-file'] } : {}), signal: listening.signal, out, err }).catch((error) => {
            // A connection that ends because dev is stopping is no failure. One that drops while it runs is: nothing would arrive.
            if (listening.signal.aborted) return;
            err(`\n${name} lost its connection, so dev is stopping: ${error instanceof Error ? error.message : String(error)}`);
            lost(error instanceof NeedsYou ? 3 : 1);
          }),
        );
      }
    }
    out(`\n${channels.join(', ')}: pointed at ${url}. Stop with Ctrl-C.`);

    const ended = new Promise<number>((resolve) => {
      const end = () => resolve(0);
      io.signal?.addEventListener('abort', end, { once: true });
      if (io.signal?.aborted) end();
      if (!io.signal) {
        process.once('SIGINT', end);
        process.once('SIGTERM', end);
      }
    });
    return await Promise.race([ended, connectionLost, ...(server ? [server.exited] : [])]);
  } finally {
    await stop();
  }
}

/** The channels this app has: its `@voiceflow/channels-<name>` dependencies, the SDK itself aside. */
function channelsOf(cwd: string): string[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .map((name) => /^@voiceflow\/channels-([a-z0-9-]+)$/.exec(name)?.[1])
    .filter((name): name is string => Boolean(name) && name !== 'sdk');
}

async function channelCli(name: string): Promise<ChannelCommands> {
  const module = `@voiceflow/channels-${name}/connect`;
  let loaded: Partial<ChannelCommands>;
  try {
    loaded = await import(module);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes(`channels-${name}`)) {
      throw new Error(`No ${name} package: install @voiceflow/channels-${name}.`);
    }
    throw error;
  }
  if (typeof loaded.cli !== 'function') throw new Error(`@voiceflow/channels-${name} has no command to point it with.`);
  return {
    cli: loaded.cli,
    ...(typeof loaded.listen === 'function' ? { listen: loaded.listen } : {}),
    ...(typeof loaded.connected === 'function' ? { connected: loaded.connected } : {}),
  };
}

function serve(command: string, args: string[], env: Record<string, string | undefined>): DevServer {
  // A shell on Windows, where a package's command is a .cmd file.
  const child: ChildProcess = spawn(command, args, { stdio: 'inherit', env: env as NodeJS.ProcessEnv, shell: process.platform === 'win32' });
  const exited = new Promise<number>((resolve) => {
    child.once('error', (error) => {
      console.error(`Couldn't start "${command}": ${error.message}`);
      resolve(127);
    });
    child.once('close', (code, signal) => resolve(code ?? (signal ? 0 : 1)));
  });
  return {
    exited,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(forced);
    },
  };
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
