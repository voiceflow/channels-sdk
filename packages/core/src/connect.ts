// `connect`, `point` and `disconnect` for a channel whose platform has no
// setup this SDK can do from a command: its app, bot or webhook is made on
// the platform's own pages. Connect then does what is left, the same way for
// every channel: it checks the settings the adapter needs are there and says
// what each missing one is, creates the channel's variables on the agent,
// and says what address to give the platform. A channel's package can add the
// one step most platforms do allow from here: giving the platform that address.
//
// Every line this prints, an error's included, is first cleaned of the secrets
// it holds. Node only: import it from `@voiceflow/channels-sdk/connect`.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { platformEntry } from './catalog.js';
import { contextVariables } from './channel.js';
import { NeedsYou } from './errors.js';
import { checkProject, installTools, memoryRecordStore } from './install.js';
import { createRedactor } from './redact.js';
import { hidden, previewPublish, publishStep, question, readEnvFile, resolveAgent, type Say, saveEnv, voiceflowKey } from './setup.js';

interface EnvVar {
  key: string;
  secret?: boolean;
  description?: string;
}
interface CatalogEnv {
  required?: readonly EnvVar[];
  optional?: readonly EnvVar[];
  /** Ways to sign in, any one of which is enough: each a set of settings. */
  credentialModes?: readonly { label: string; vars: readonly EnvVar[] }[];
}

/** A setting the adapter reads that Chat SDK's catalog doesn't mark as needed, and this channel does need. */
export interface ChannelSetting {
  key: string;
  description: string;
  /**
   * True for a secret of your own choosing, which the platform is given and
   * sends back (a webhook's secret): connect makes one and saves it.
   */
  make?: boolean;
}

/** What a channel's package can do for its platform that the catalog can't say. */
export interface ChannelSetup {
  /** Settings the channel needs beyond the ones the catalog marks as needed. */
  settings?: readonly ChannelSetting[];
  /**
   * Settings the catalog marks as needed that can't be there at first, each
   * with why: one the platform hands over only once it has the server's
   * address, say. Connect doesn't wait for them, and says each one's reason.
   */
  later?: Readonly<Record<string, string>>;
  /**
   * Gives the platform your server's address, where the platform takes one
   * from a command. Returns what it did, as a line to print. Without it, the
   * address is printed for a person to enter on the platform's own page.
   */
  point?(input: { url: string; env: Record<string, string | undefined>; fetch: typeof fetch }): Promise<string>;
  /** Where on the platform a person enters the address, in a few words: "Settings → Webhooks → Add webhook", say. */
  addressGoes?: string;
  /** Takes back what `point` gave the platform. Returns what it did, as a line to print. */
  remove?(input: { env: Record<string, string | undefined>; fetch: typeof fetch }): Promise<string>;
}

/** What the command reads and writes, for a test or a program that runs it. */
export interface ChannelCliIO {
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  secret?: (question: string) => Promise<string>;
}

export interface ChannelCommandSet {
  /** The settings the channel can't run without: the ones a person brings, and the secrets connect makes. */
  settings: { needed: string[]; made: string[] };
  cli(argv: string[], io?: ChannelCliIO): Promise<number>;
  /** Whether the settings the adapter needs are all there: `voiceflow-channels dev` asks, and runs connect first when not. */
  connected(options?: { envFile?: string; env?: Record<string, string | undefined> }): Promise<boolean>;
}

/**
 * The settings a channel still lacks: each one it needs, and one whole way of
 * signing in where there are several. One that connect makes itself (`make`)
 * is not among them: `toMake` lists those.
 */
export function missingSettings(
  slug: string,
  has: (key: string) => boolean,
  setup: Pick<ChannelSetup, 'settings' | 'later'> = {},
): { key: string; description: string; oneOf?: string }[] {
  const env = platformEntry(slug).env as CatalogEnv;
  const later = setup.later ?? {};
  const made = new Set((setup.settings ?? []).filter((v) => v.make).map((v) => v.key));
  const needed = [...(env.required ?? []), ...(setup.settings ?? [])].filter(
    (v, index, all) => !(v.key in later) && !made.has(v.key) && all.findIndex((other) => other.key === v.key) === index,
  );
  const missing = needed.filter((v) => !has(v.key)).map((v) => ({ key: v.key, description: v.description ?? '' }));
  const modes = env.credentialModes ?? [];
  if (modes.length && !modes.some((mode) => mode.vars.every((v) => has(v.key)))) {
    // Any one way is enough: the first is said in full, and the others by name.
    const [first, ...others] = modes;
    for (const v of first!.vars) {
      if (!has(v.key))
        missing.push({ key: v.key, description: v.description ?? '', ...(others.length ? { oneOf: others.map((mode) => mode.label).join(', ') } : {}) });
    }
  }
  return missing;
}

/** The secrets of your own that connect makes for a channel, and that aren't there yet. */
export function toMake(has: (key: string) => boolean, setup: Pick<ChannelSetup, 'settings'> = {}): ChannelSetting[] {
  return (setup.settings ?? []).filter((v) => v.make && !has(v.key));
}

/** The commands for one channel. `slug` is its name in Chat SDK's catalog; `setup` is what its package adds. */
export function channelCommands(slug: string, setup: ChannelSetup = {}): ChannelCommandSet {
  const entry = platformEntry(slug);
  const platform = entry.name;
  const path = `/api/${slug}`;
  const variables = contextVariables(slug);
  const guide = (entry as { readme?: string }).readme ?? 'https://chat-sdk.dev/adapters';
  const secretKeys = [
    ...((entry.env as CatalogEnv).required ?? []),
    ...((entry.env as CatalogEnv).optional ?? []),
    ...((entry.env as CatalogEnv).credentialModes ?? []).flatMap((m) => m.vars),
  ]
    .filter((v) => v.secret)
    .map((v) => v.key)
    .concat((setup.settings ?? []).filter((v) => v.make).map((v) => v.key));
  const usage = `Usage:
  voiceflow-channels connect ${slug} --env-file <path> [--public-url <https://host>] [options]
  voiceflow-channels point ${slug} --public-url <https://host> [--env-file <path>]
  voiceflow-channels disconnect ${slug}

Connect sets up ${platform} for your Voiceflow agent. ${platform}'s side (its
app or bot, and the settings below) is made on ${platform}'s own pages:
  ${guide}
Connect checks those settings are in --env-file or the environment, and says
what each missing one is. It creates the ${slug}_* variables on your agent,
writes the Voiceflow values to --env-file, and ${setup.point ? `gives ${platform} your server's address` : `says what address to give ${platform}`}.
It shows the plan and asks before changing anything.${
    (setup.settings ?? []).some((v) => v.make)
      ? `\n\nOne secret is yours to choose, and connect makes it: ${(setup.settings ?? [])
          .filter((v) => v.make)
          .map((v) => v.key)
          .join(', ')}, saved to --env-file.`
      : ''
  }

Your Voiceflow API key, project and environment come from the flags below,
then VOICEFLOW_API_KEY, VOICEFLOW_PROJECT_ID and VOICEFLOW_ENVIRONMENT in the
environment, then --env-file; a person is asked for what's left.

Point ${setup.point ? `gives ${platform} another address` : `says the address to give ${platform}`}, and changes nothing else:
\`voiceflow-channels dev\` runs it on each start. Disconnect ${setup.remove ? `has ${platform} stop sending to your server` : `says where ${platform}'s side is taken out`}.

It exits 0 when done, 1 on a failure, 2 on a mistake in the command, and 3
when it's waiting on you: do what it says, then run it again.

Options:
  --project <id>          the Voiceflow project (agent)
  --environment <alias>   the environment whose draft gets the variables
  --workspace <id>        stop, changing nothing, unless the project is in this
                          Voiceflow workspace
  --public-url <url>      your server's public address; ${platform} sends to <url>${path}
  --request-url <url>     or the whole URL, if it isn't <url>${path}
  --local-url <url>       point: your server on this machine. It is asked first,
                          so a server that's down or has no ${platform} route is said
  --no-variables          create no variables on the agent (then pass
                          context: false to ${slug}() on your server)
  --env-file <path>       your server's env file
  --key-file <path>       a file holding only the Voiceflow API key
  --publish               publish the environment once the variables are on its
                          draft, without asking: its whole draft goes live
  --no-publish            don't publish (the default)
  --dry-run               show the plan and stop
  --yes                   don't ask before going ahead`;

  async function run(
    argv: string[],
    io: ChannelCliIO & { env: Record<string, string | undefined> },
    secrets: ReturnType<typeof createRedactor>,
    out: Say,
    err: Say,
  ): Promise<number> {
    const { values: o, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        environment: { type: 'string' },
        workspace: { type: 'string' },
        'public-url': { type: 'string' },
        'request-url': { type: 'string' },
        'local-url': { type: 'string' },
        'from-dev': { type: 'boolean', default: false },
        'no-variables': { type: 'boolean', default: false },
        'env-file': { type: 'string' },
        'key-file': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        publish: { type: 'boolean', default: false },
        'no-publish': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    const action = positionals[0] ?? 'connect';
    if (o.help || !['connect', 'disconnect', 'point'].includes(action)) {
      out(usage);
      return o.help ? 0 : 2;
    }
    if (o.publish && o['no-publish']) {
      err('--publish and --no-publish say opposite things: pass one.');
      return 2;
    }
    const requestUrl = o['request-url'] ?? (o['public-url'] ? `${o['public-url'].replace(/\/+$/, '')}${path}` : undefined);
    if (action === 'point' && !requestUrl) {
      err(`Missing --public-url: your server's public address, where ${platform} sends.\n\n${usage}`);
      return 2;
    }
    if (requestUrl && !/^https:\/\//.test(requestUrl)) {
      err(`${platform} sends only to an https address, and "${requestUrl}" isn't one.`);
      return 2;
    }
    const envFile = o['env-file'];
    const inFile = envFile ? await readEnvFile(envFile) : {};
    const value = (key: string) => io.env[key] || inFile[key];
    secrets.add(inFile.VOICEFLOW_API_KEY, ...secretKeys.map(value));
    const doFetch = io.fetch ?? fetch;
    const where = envFile ? `in ${envFile}` : 'in the environment';
    const has = (key: string) => Boolean(value(key));
    const lacking = missingSettings(slug, has, setup);
    // A secret connect makes needs somewhere to be kept: with no env file, it is one more setting to bring.
    const making = toMake(has, setup);
    if (!envFile) lacking.push(...making.splice(0).map((v) => ({ key: v.key, description: `${v.description} Any long random text of your own.` })));
    const notConnected = () =>
      `${platform} isn't connected here yet: run \`voiceflow-channels connect ${slug} --env-file ${envFile}\` first. It makes ${making.map((v) => v.key).join(' and ')} and saves ${making.length === 1 ? 'it' : 'them'} there.`;
    const lackingText = () =>
      `${platform} isn't set up here yet. ${lacking.length === 1 ? 'One setting is' : 'These settings are'} missing ${where}:\n${lacking
        .map((v) => `  ${v.key}=…   ${v.description}${v.oneOf ? ` (or sign in another way: ${v.oneOf})` : ''}`)
        .join(
          '\n',
        )}\nThey come from ${platform}'s own pages: ${guide}\nPut ${lacking.length === 1 ? 'it' : 'them'} ${where}, never in a chat or a command line. Then run this again: it does the rest.`;
    /** The secrets connect made in this run: what gives the platform the address needs them. */
    const madeNow: Record<string, string> = {};
    /** Every setting as this command reads one: the environment's, then the env file's, then what was made in this run. */
    const settings = (): Record<string, string | undefined> => {
      const all: Record<string, string | undefined> = { ...madeNow, ...inFile };
      // A variable that is set and empty says nothing: the env file's value stands.
      for (const [key, set] of Object.entries(io.env)) if (set) all[key] = set;
      return all;
    };
    /** Gives the platform the address, or says where a person does. */
    const address = async (url: string): Promise<void> => {
      if (setup.point) out(await setup.point({ url, env: settings(), fetch: doFetch }));
      else out(`! Give ${platform} this address, where it asks where to send messages${setup.addressGoes ? ` (${setup.addressGoes})` : ''}: ${url}`);
    };

    if (action === 'disconnect') {
      const rest = `The bot or app itself is taken out on ${platform}'s own pages (${guide}). The ${slug}_* variables stay on the agent: they are its own now.`;
      if (setup.remove) {
        if (lacking.length) throw new NeedsYou(lackingText());
        out(await setup.remove({ env: settings(), fetch: doFetch }));
        out(rest);
        return 0;
      }
      err(`Nothing of ${platform}'s was made from here, so there is nothing here to remove. ${rest}`);
      return 3;
    }
    if (action === 'point') {
      if (lacking.length) throw new NeedsYou(lackingText());
      if (making.length) throw new NeedsYou(notConnected());
      if (o['local-url']) {
        const at = `${o['local-url'].replace(/\/+$/, '')}${new URL(requestUrl!).pathname}`;
        if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(at)) {
          err(`--local-url is your server on this machine, and "${o['local-url']}" isn't.`);
          return 2;
        }
        let status: number;
        try {
          status = (await doFetch(at, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }))
            .status;
        } catch (error) {
          throw new Error(
            `Your server didn't answer at ${at} (${error instanceof Error ? error.message : String(error)}). Is it running? Nothing was changed.`,
          );
        }
        if (status === 404 || status === 405)
          throw new Error(`Your server has no ${platform} route at ${at} (HTTP ${status}). The starter puts it at app${path}/route.ts. Nothing was changed.`);
        if (status >= 500)
          throw new Error(`Your server failed at ${at} (HTTP ${status}): its own log says why. A setting it needs may be missing. Nothing was changed.`);
        out(`= your server has its ${platform} route at ${at}`);
      }
      await address(requestUrl!);
      return 0;
    }

    // A flag wins, then the environment, then the env file. A person is asked for what's left.
    const interactive = io.interactive ?? Boolean(process.stdin.isTTY);
    const ask = io.ask ?? question;
    const {
      project,
      environment,
      missing,
      waiting: agentWaits,
    } = await resolveAgent(
      { ...(o.project ? { project: o.project } : {}), ...(o.environment ? { environment: o.environment } : {}) },
      { env: io.env, inFile, ...(envFile ? { envFile } : {}), interactive, ask },
    );
    if (missing.length && interactive) {
      err(`Missing ${missing.join(' and ')}${envFile ? `, in the environment or in ${envFile}` : ''}.\n\n${usage}`);
      return 2;
    }
    // Everything a person has to do is said in one stop, not one thing per run.
    const waiting: string[] = [...agentWaits];
    let key: { value: string; typed: boolean } | undefined;
    try {
      key = await voiceflowKey({ file: o['key-file'], env: io.env, inFile, envFile, interactive, secret: io.secret ?? hidden });
    } catch (error) {
      if (interactive || !(error instanceof NeedsYou)) throw error;
      waiting.push(error.message);
    }
    secrets.add(key?.value);
    if (lacking.length) waiting.push(lackingText());
    if (waiting.length || !key) throw new NeedsYou(waiting.join('\n\n'));

    const withFetch = io.fetch ? { fetch: io.fetch } : {};
    const voiceflow = { apiKey: key.value, projectID: project, environment, ...(o.workspace ? { expectWorkspace: o.workspace } : {}), ...withFetch };
    const projectRead = await checkProject(voiceflow);
    const wantsVariables = !o['no-variables'];
    const set = { channel: slug, variables, tools: [] };
    const record = memoryRecordStore();
    const dry = wantsVariables ? await installTools(set, { ...voiceflow, record, dryRun: true }) : undefined;
    const fresh = dry?.steps.filter((s) => s.kind === 'variable' && s.action === 'create').map((s) => (s as { name: string }).name) ?? [];
    const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    out(
      [
        `${platform}: Chat SDK's ${platform} adapter, with the settings ${where}`,
        !requestUrl
          ? `  · ${platform} needs your server's address: \`voiceflow-channels dev\` ${setup.point ? 'gives it one' : 'says it'} each time it starts`
          : setup.point
            ? `  + have ${platform} send to ${requestUrl}`
            : `  · ${platform} is given ${requestUrl} by hand: connect says where`,
        ...making.map((v) => `  + make ${v.key}, a secret of your own that ${platform} sends back, and save it ${where}`),
        `Voiceflow: project "${projectRead.name}" (${projectRead.id}) in workspace ${projectRead.workspaceID}, environment ${environment}${wantsVariables ? ': the variables go on its draft' : ''}`,
        !wantsVariables
          ? `  · no variables (then pass context: false to ${slug}() on your server)`
          : fresh.length
            ? `  + ${count(fresh.length, 'variable')} for your agent's prompts (${fresh.slice(0, 2).join(', ')}${fresh.length > 2 ? ', …' : ''})\n  ~ compile the environment's draft`
            : `  = ${count(Object.keys(variables).length, 'variable')}: there already`,
        'Then:',
        o.publish
          ? `  + publish ${environment}: its whole draft goes live (--publish)`
          : `  · nothing is published, and nothing has to be${wantsVariables ? `: the variables are live once you publish ${environment}` : ''}`,
      ].join('\n'),
    );
    const io2 = { interactive, ask, out, err };
    if (o['dry-run']) {
      if (o.publish) await previewPublish(voiceflow, { publish: true, noPublish: false }, io2, fresh.length > 0);
      return 0;
    }
    if (!o.yes) {
      if (!interactive) {
        err('\nNothing was changed: run it again with --yes to go ahead.');
        return 0;
      }
      if (!/^y(es)?$/i.test((await ask('\nGo ahead? [y/N] ')).trim())) return 0;
    }
    if (wantsVariables) {
      const install = await installTools(set, { ...voiceflow, record });
      const made = install.steps.filter((s) => s.kind === 'variable' && s.action === 'create').length;
      if (made) out(`+ created ${count(made, 'variable')} on the agent`);
      for (const problem of install.problems ?? []) err(`! ${problem}`);
    }
    for (const v of making) {
      madeNow[v.key] = randomBytes(32).toString('hex');
      secrets.add(madeNow[v.key]);
    }
    await saveEnv(
      { ...(envFile ? { envFile } : {}), inFile },
      [
        ...Object.entries(madeNow),
        ['VOICEFLOW_API_KEY', key.typed ? key.value : ''],
        ['VOICEFLOW_PROJECT_ID', project],
        ['VOICEFLOW_ENVIRONMENT', environment],
      ],
      io2,
    );
    const published = o.publish
      ? await publishStep(
          voiceflow,
          { publish: true, noPublish: false },
          io2,
          { name: `${platform} variables (Channels SDK)`, description: `Published by \`voiceflow-channels connect ${slug} --publish\`.` },
          true,
        )
      : 'not';
    out(`
Connected: ${platform}, with your agent "${projectRead.name}".

  createChannels({
    voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY, projectID: '${project}', environment: '${environment}' },
    channels: [${slug}()],
  })
`);
    if (requestUrl) await address(requestUrl);
    else
      out(
        o['from-dev']
          ? `Your server starts next: dev ${setup.point ? `gives ${platform} its address` : `says the address to give ${platform}`}.`
          : `Then start your server with \`voiceflow-channels dev -- <its command>\` (\`npm run dev\` in an app the starter made): it ${setup.point ? `gives ${platform} your server's address` : `says the address to give ${platform}`}, each time it starts.`,
      );
    for (const [later, why] of Object.entries(setup.later ?? {})) {
      if (!has(later)) out(`! ${later} isn't set yet, and can't be: ${why}`);
    }
    if (wantsVariables)
      out(
        `The ${slug}_* variables are on ${environment}'s draft, for your agent's prompts: {${slug}_user_name}, say.${published === 'published' ? '' : ` They're live once you publish ${environment}.`}`,
      );
    return published === 'failed' ? 1 : 0;
  }

  return {
    settings: { needed: missingSettings(slug, () => false, setup).map((v) => v.key), made: toMake(() => false, setup).map((v) => v.key) },
    async cli(argv, io = {}) {
      const env = io.env ?? process.env;
      const secrets = createRedactor(env.VOICEFLOW_API_KEY, ...secretKeys.map((key) => env[key]));
      const out = (line: string) => (io.out ?? console.log)(secrets.redact(line));
      const err = (line: string) => (io.err ?? console.error)(secrets.redact(line));
      try {
        return await run(argv, { ...io, env }, secrets, out, err);
      } catch (error) {
        err(error instanceof Error ? error.message : String(error));
        return error instanceof NeedsYou ? 3 : 1;
      }
    },
    async connected(options = {}) {
      const env = options.env ?? process.env;
      const inFile = options.envFile ? await readEnvFile(options.envFile) : {};
      const has = (key: string) => Boolean(env[key] || inFile[key]);
      // Connected is everything connect leaves behind: the platform's settings, the secrets it makes, and which agent.
      return missingSettings(slug, has, setup).length === 0 && toMake(has, setup).length === 0 && has('VOICEFLOW_API_KEY') && has('VOICEFLOW_PROJECT_ID');
    },
  };
}
