// The Slack starter's own words: its README, its notes for a coding agent, and what to do next.
import { type ChannelStarter, type PackageManager, runScript } from './shared.js';

/**
 * The app's notes for a coding agent: how to set it up without a person at the
 * terminal, and what never to do. The commands are the source of truth (they
 * stop and say what they need), so this says how to run them and how to read
 * what they answer. Next.js adds a block of its own to the same file when it
 * runs; the two share it.
 */
function agentsMd(name: string, pm: PackageManager, environment: string): string {
  return `# ${name}: notes for coding agents

This app puts a Voiceflow agent in Slack. One route,
\`app/api/slack/route.ts\`, takes everything Slack sends and every call the
agent's Slack tools make. \`README.md\` covers the same ground for a person.

## Setting it up

When you're asked to set this up, connect it to Slack or get it running, do
these in order. No command here asks you anything: each stops when it needs
something, and says what.

1. **See the plan:** \`${runScript(pm, 'connect', '--dry-run')}\`. It changes nothing. It
   prints what connect would make in Slack, what it would put on the agent,
   and what publishing would carry.
2. **Show the person the plan, and ask two things in one message:** whether
   to go ahead, and whether to publish. Give them, as the plan prints them,
   the Slack workspace, the Voiceflow project with its workspace and
   environment, and what a publish would carry.
3. **Make the Slack app, on their go-ahead:** \`${runScript(pm, 'connect', '--yes')}\`. Add
   \`--publish\` only if they said to publish.
4. **Start it:** \`${runScript(pm, 'dev')}\`, as a background process. It keeps
   running, and it's ready when it prints \`pointed at\`.

Then tell the person the app's bot has messaged them in Slack, and to reply
to it there.

### Read the exit code

| Code | Means | Do |
|---|---|---|
| 0 | Done | Go on |
| 3 | It's waiting on the person | Give them its message as it is, wait for them, then run the same command again with what the message says to add |
| 2 | The command was wrong | Fix what its message names |
| 1 | It failed | Read its message. Running it again finishes what it started |

What a code 3 asks for is the person's to do, not yours:

- **A Voiceflow API key.** Ask them to put it in \`.env.local\` themselves, as
  \`VOICEFLOW_API_KEY\`. Don't ask them to paste it to you.
- **Signing in to Slack.** The message has a \`/slackauthticket …\` command for
  them to paste into Slack. Slack gives them a code. Run the same command
  again with \`--slack-ticket <ticket> --slack-code <code>\` added. The
  sign-in is kept: leave the ticket and code off every run after that.
- **The Voiceflow project's ID.** Ask them for it, or look it up with
  Voiceflow's CLI or MCP server if you have one connected. It isn't a secret:
  put it in \`.env.local\` as \`VOICEFLOW_PROJECT_ID\` yourself.
- **A tool that isn't installed** (the Slack CLI, cloudflared). Give them the
  install command the message prints. Run an installer only if they say to.

One stop can ask for several of these: hand them all over together.

### Publishing is the person's decision

The bot runs the published version of the agent's \`${environment}\`
environment, so the agent in Slack has its Slack tools only once that
environment is published. Publishing makes the whole draft live, including
changes that have nothing to do with this app. That is why the plan lists
what the draft holds, and why you ask.

- Never pass \`--publish\` without their yes to publishing itself. A yes to
  the plan isn't one.
- If they said no, or didn't say: leave it. They can publish in Voiceflow, or
  ask you later: \`${runScript(pm, 'connect', '--yes --publish')}\`.
- If connect says the environment is published, there's nothing to do.

## Rules

- **Never show a secret.** Don't print, echo, log or commit anything from
  \`.env.local\`, or any token or key. To see whether a value is set, count
  it: \`grep -c '^VOICEFLOW_API_KEY=.' .env.local\`.
- **Don't publish, disconnect or remove tools** unless the person asked for
  exactly that.
- **Don't fix it by hand.** Don't change the app in Slack's settings or the
  tools in Voiceflow to make something work. Run connect again: it only adds
  what's missing.
- **Keep \`.voiceflow/\`.** It records which Slack app and tools are this
  app's.

## Where things are

- \`app/api/slack/route.ts\`: the route, and \`createChannels\`, where the
  agent and its channels are set.
- \`.env.local\`: the server's settings. \`.env.example\` names each one.
- A server that has an address of its own: \`README.md\`, "Deploy it".
- Every option: \`npx voiceflow-channels connect slack --help\` and
  \`npx voiceflow-channels dev --help\`.
- Tools of your own, and the rest:
  [Voiceflow Channels SDK](https://github.com/voiceflow/channels-sdk).
`;
}

function readme(name: string, pm: PackageManager, environment: string): string {
  const connect = runScript(pm, 'connect');
  const deployed = runScript(pm, 'connect', '--public-url https://<your deployment>');
  return `# ${name}

A Voiceflow agent in Slack, served by one Next.js route:
[\`app/api/slack/route.ts\`](app/api/slack/route.ts). Mentions, direct messages,
the assistant panel, buttons, forms and \`/ask\` all arrive there, and so do the
calls the agent's Slack tools make.

Made with [\`@voiceflow/create-channels-sdk\`](https://github.com/voiceflow/channels-sdk).

## Run it

With a coding agent, ask it to set this up: [\`AGENTS.md\`](AGENTS.md) tells it
how, and what to hand back to you. By hand, it's two commands.

You need Node.js 22 or later, a Voiceflow agent with an API key, and a Slack
workspace where you can create apps. Two tools are used on the way, and each
is offered to you when you don't have it: the
[Slack CLI](https://tools.slack.dev/slack-cli), to sign you in to Slack, and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/),
for the tunnel that gives this machine a public address. Neither needs an
account of its own.

1. Make the Slack app. Run this before the server, so that connect can answer
   Slack's check of the address itself:

   \`\`\`bash
   ${connect}
   \`\`\`

   It signs you in to Slack (it runs \`slack login\` for you, and offers to
   install the Slack CLI first when you don't have it). It reads your agent's
   details from \`.env.local\` and asks for what isn't there: your Voiceflow
   API key, in a hidden prompt, and your project's ID. It shows its plan and
   asks before it changes anything. Then it makes and
   installs the app, installs Slack's tools on the agent, and fills in
   \`.env.local\`: the app's \`SLACK_BOT_TOKEN\` and \`SLACK_SIGNING_SECRET\`,
   and what it asked you for. The bot token stays on this server: it never
   goes to Voiceflow.

   The bot runs the published version of the agent's \`${environment}\`
   environment, so connect then shows what that environment's draft holds and
   asks whether to publish it. The whole draft goes live, not only these
   tools: say no to publish it in Voiceflow yourself. The new app's bot then
   messages you in Slack.

2. Start the server:

   \`\`\`bash
   ${pm} run dev
   \`\`\`

   It opens a tunnel to port 3000, starts the server, and points the Slack app
   and the agent's tools at the tunnel's address, which is new each time. That
   needs no publish. Stop it with Ctrl-C. For another port, set \`PORT\`.

Mention the app in a channel, send it a direct message, or open it from
Slack's assistant panel.

## Deploy it

- Set the same environment variables on your host, with \`REDIS_URL\` pointing at
  a Redis database: conversations live in memory without it, and end when the
  server restarts or a request reaches another instance.
- Run connect again with your deployment's address: \`${deployed}\`. It
  reuses the app it made and points it there. \`${pm} run start\` runs the server
  with no tunnel.

## Learn more

- [Voiceflow Channels SDK](https://github.com/voiceflow/channels-sdk): every Slack
  option, the tools, and tools of your own.
- [Voiceflow's documentation](https://www.voiceflow.com/docs), for building the
  agent itself.
`;
}

export const slack: ChannelStarter = {
  label: 'Slack',
  readme,
  agentsMd,
  next: (pm, environment, hasProject) => [
    '  1. Make the Slack app:',
    `       ${runScript(pm, 'connect')}`,
    `     It signs you in to Slack, asks for your Voiceflow API key${hasProject ? '' : ' and project ID'}, and saves ${hasProject ? 'it' : 'them'} in .env.local.`,
    `     Then it asks whether to publish the ${environment} environment, and the bot messages you in Slack.`,
    '  2. Start it:',
    `       ${runScript(pm, 'dev')}`,
    '     It opens a tunnel, starts the server, and points Slack at it.',
  ],
};
