// The starter's words for a channel: its README, its notes for a coding agent,
// and what to do next. The same for every channel whose bot or app is made on
// the platform's own pages, with the channel's name and settings in.
import { type ChannelStarter, type PackageManager, runScript } from './shared.js';

export interface Setting {
  key: string;
  description: string;
}

/** What the starter knows of a channel: read from Chat SDK's catalog and the channel's package when the starter is built. */
export interface ChannelInfo {
  /** The platform's name as people write it: "Telegram". */
  name: string;
  /** The adapter's package, and the version this starter was tested with. */
  package: string;
  version: string;
  /** Chat SDK's guide to the adapter: where each setting comes from. */
  guide: string;
  /** The settings a person brings from the platform. */
  required: Setting[];
  /** Ways to sign in, any one of which is enough. */
  modes: { label: string; settings: Setting[] }[];
  /** Secrets of your own that the platform sends back: connect makes each. */
  made: Setting[];
  /** Settings that can't be there at first, each with why. */
  later: (Setting & { why: string })[];
  /** Whether the channel's command gives the platform the server's address itself. */
  points: boolean;
  /** Where a person enters the address, when no command can. */
  addressGoes?: string;
}

/** The settings a person puts in the env file before connect: each needed one, and the first way of signing in. */
export function settingsOf(info: ChannelInfo): Setting[] {
  return [...info.required, ...(info.modes[0]?.settings ?? [])];
}

export function channelStarter(slug: string, info: ChannelInfo): ChannelStarter {
  const { name } = info;
  const settings = settingsOf(info);
  const names = settings.map((s) => `\`${s.key}\``).join(', ');
  const first = settings[0]?.key ?? 'VOICEFLOW_API_KEY';
  const others = info.modes.slice(1).map((mode) => mode.label);
  /** What happens to the server's address: given to the platform by the command, or by a person. */
  const address = info.points
    ? `gives ${name} the tunnel's address`
    : `prints the address to give ${name}${info.addressGoes ? `: it goes in ${info.addressGoes}` : ''}`;
  const made = info.made.map((s) => `\`${s.key}\``).join(' and ');
  const later = info.later.map((s) => `- \`${s.key}\` can't be set yet: ${s.why}`);

  const agentsMd = (app: string, pm: PackageManager, environment: string) => `# ${app}: notes for coding agents

This app puts a Voiceflow agent in ${name}. One route,
\`app/api/${slug}/route.ts\`, takes everything ${name} has for the bot.
\`README.md\` covers the same ground for a person.

## Setting it up

When you're asked to set this up, connect it to ${name} or get it running, do
these in order. No command here asks you anything: each stops when it needs
something, and says what.

1. **See the plan:** \`${runScript(pm, 'connect', '--dry-run')}\`. It changes nothing. It
   stops with code 3 while a setting ${name} needs is missing from
   \`.env.local\`, and names each one.
2. **Show the person the plan and ask whether to go ahead.** Give them, as
   the plan prints them, the Voiceflow project with its workspace and
   environment.
3. **Set it up, on their go-ahead:** \`${runScript(pm, 'connect', '--yes')}\`.
4. **Start it:** \`${runScript(pm, 'dev')}\`, as a background process. It keeps
   running, and it's ready when it prints \`pointed at\`.${
     info.points
       ? ''
       : ` It prints a line
   starting \`! Give ${name} this address\`: give the person that line as it
   is. Only they can enter it on ${name}'s page, and the address is new each
   time \`dev\` starts.`
   }

Then tell the person to write to the bot in ${name}.

### Read the exit code

| Code | Means | Do |
|---|---|---|
| 0 | Done | Go on |
| 3 | It's waiting on the person | Give them its message as it is, wait for them, then run the same command again |
| 2 | The command was wrong | Fix what its message names |
| 1 | It failed | Read its message. Running it again finishes what it started |

What a code 3 asks for is the person's to do, not yours:

- **${name}'s settings** (${names || 'none'}). They come from
  ${name}'s own pages: ${info.guide}
  Ask the person to put each in \`.env.local\` themselves. Don't ask them to
  paste one to you.
- **A Voiceflow API key.** The same: in \`.env.local\`, as
  \`VOICEFLOW_API_KEY\`, by them.
- **The Voiceflow project's ID.** Ask them for it, or look it up with
  Voiceflow's CLI or MCP server if you have one connected. It isn't a secret:
  put it in \`.env.local\` as \`VOICEFLOW_PROJECT_ID\` yourself.
- **A tool that isn't installed** (cloudflared). Give them the install
  command the message prints. Run an installer only if they say to.

One stop can ask for several of these: hand them all over together.
${made ? `\nConnect makes ${made} itself, and saves it in \`.env.local\`: leave it empty,\nand never print it.\n` : ''}${later.length ? `\n${later.join('\n')}\n` : ''}
### Nothing has to be published

Connect creates \`${slug}_*\` variables on the draft of the agent's
\`${environment}\` environment, for its prompts. The bot works without them
being live. Don't pass \`--publish\` unless the person asks for exactly that:
it makes the whole draft live, including changes that have nothing to do with
this app.

## Rules

- **Never show a secret.** Don't print, echo, log or commit anything from
  \`.env.local\`, or any token or key. To see whether a value is set, count
  it: \`grep -c '^${first}=.' .env.local\`.
- **Don't publish or disconnect** unless the person asked for exactly that.
- **One bot, one place.** While \`dev\` runs, ${name} sends this bot's
  messages to this machine. Don't run it against a bot that's deployed and in
  use: have the person make a second one for development.

## Where things are

- \`app/api/${slug}/route.ts\`: the route. \`app/api/${slug}/bot.ts\`:
  \`createChannels\`, where the agent and its channels are set.
- \`.env.local\`: the server's settings. \`.env.example\` names each one.
- Every option: \`npx voiceflow-channelkit connect ${slug} --help\` and
  \`npx voiceflow-channelkit dev --help\`.
- The rest: [Voiceflow ChannelKit](https://github.com/voiceflow/channelkit).
`;

  const readme = (app: string, pm: PackageManager, environment: string) => `# ${app}

A Voiceflow agent in ${name}, served by one Next.js route:
[\`app/api/${slug}/route.ts\`](app/api/${slug}/route.ts).

Made with [\`@voiceflow/create-channelkit\`](https://github.com/voiceflow/channelkit).

## Run it

With a coding agent, ask it to set this up: [\`AGENTS.md\`](AGENTS.md) tells it
how, and what to hand back to you. By hand, it's three steps.

You need Node.js 22 or later, a Voiceflow agent with an API key, and a bot or
app on ${name}. One tool is used on the way, and is offered to you when you
don't have it:
[cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/),
for the tunnel that gives this machine a public address. It needs no account.

1. Make the bot or app on ${name}'s own pages, and put its settings in
   \`.env.local\`: ${names || 'none are needed'}${others.length ? ` (or sign in another way: ${others.join(', ')})` : ''}.
   [Chat SDK's guide to the ${name} adapter](${info.guide}) says where each
   comes from, and [\`.env.example\`](.env.example) says what each is.

2. Set it up:

   \`\`\`bash
   ${runScript(pm, 'connect')}
   \`\`\`

   Connect says which settings are still missing. It reads your agent's
   details from \`.env.local\` and asks for what isn't there: your Voiceflow
   API key, in a hidden prompt, and your project's ID. It shows its plan and
   asks before it changes anything. Then it creates the \`${slug}_*\`
   variables on your agent's \`${environment}\` environment${made ? `, and makes\n   ${made}: a secret of your own that ${name} sends back with each message` : ''}.
   Nothing is published, and nothing has to be.

3. Start the server:

   \`\`\`bash
   ${pm} run dev
   \`\`\`

   It opens a tunnel to port 3000, starts the server, and ${address}.
   The address is new each time. Stop it with Ctrl-C. For another port, set
   \`PORT\`.

\`${pm} run dev\` alone runs step 2 first, the first time.
${later.length ? `\n${later.join('\n')}\n` : ''}
## Deploy it

- Deploy the app with the same environment variables as \`.env.local\`, then
  run connect with its address: \`${runScript(pm, 'connect', '--public-url https://<your deployment>')}\`.
- Set \`REDIS_URL\` to a Redis database: conversations live in memory without
  it, and end when the server restarts or a request reaches another instance.
- Use a second bot for development: while \`${pm} run dev\` runs, ${name}
  sends that bot's messages to your machine.

## Learn more

- [Voiceflow ChannelKit](https://github.com/voiceflow/channelkit): every
  ${name} option, and the other channels.
- [Voiceflow's documentation](https://www.voiceflow.com/docs), for building the
  agent itself.
`;

  return {
    label: name,
    readme,
    agentsMd,
    next: (pm, _environment, hasProject) => [
      `  1. Put ${name}'s settings in .env.local${settings.length ? `: ${settings.map((s) => s.key).join(', ')}` : ''}.`,
      `     They come from ${name}'s own pages: ${info.guide}`,
      '  2. Start it:',
      `       ${runScript(pm, 'dev')}`,
      `     The first time, it sets the channel up before it starts: it asks for your Voiceflow API key${hasProject ? '' : ' and project ID'}.`,
      `     Then it opens a tunnel, starts the server, and ${info.points ? `points ${name} at it` : `prints the address to give ${name}`}.`,
      `     (${runScript(pm, 'connect')} does the setting up alone.)`,
    ],
  };
}
