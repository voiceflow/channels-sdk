// The Discord starter's own words: its README, its notes for a coding agent, and what to do next.
import { type ChannelStarter, type PackageManager, runScript } from './shared.js';

const PORTAL = 'https://discord.com/developers/applications';
/** The portal with its "new application" dialog open. */
const NEW_APPLICATION = `${PORTAL}?new_application=true`;

function agentsMd(name: string, pm: PackageManager, environment: string): string {
  return `# ${name}: notes for coding agents

This app puts a Voiceflow agent in Discord. One route,
\`app/api/discord/route.ts\`, takes everything Discord has for the bot.
\`README.md\` covers the same ground for a person.

## Setting it up

When you're asked to set this up, connect it to Discord or get it running, do
these in order. No command here asks you anything: each stops when it needs
something, and says what.

1. **See the plan:** \`${runScript(pm, 'connect', '--dry-run')}\`. It changes nothing. The
   first time, it stops with code 3: Discord has no way to make an
   application from a command, so the person makes one and copies its bot
   token. Give them the message as it is, and wait.
2. **Show the person the plan and ask whether to go ahead.** Give them, as
   the plan prints them, the Discord app and the Voiceflow project with its
   workspace and environment.
3. **Set it up, on their go-ahead:** \`${runScript(pm, 'connect', '--yes')}\`.
4. **Give them the link it prints**, whole. They open it, pick a server, and
   authorize: that adds the bot. You can't do this for them.
5. **Start it:** \`${runScript(pm, 'dev')}\`, as a background process. It keeps
   running. It's ready when it has printed \`pointed at\` and
   \`connected to Discord\`.

Then tell the person to mention the bot in a channel of that server, send it
a direct message, or use \`/ask\`.

### Read the exit code

| Code | Means | Do |
|---|---|---|
| 0 | Done | Go on |
| 3 | It's waiting on the person | Give them its message as it is, wait for them, then run the same command again |
| 2 | The command was wrong | Fix what its message names |
| 1 | It failed | Read its message. Running it again finishes what it started |

What a code 3 asks for is the person's to do, not yours:

- **The Discord bot token.** They make the application at
  ${NEW_APPLICATION}, named as the message says, and copy the token from its
  Bot page. Ask them to put it in \`.env.local\`
  themselves, as \`DISCORD_BOT_TOKEN\`. Don't ask them to paste it to you.
- **A Voiceflow API key.** The same: in \`.env.local\`, as
  \`VOICEFLOW_API_KEY\`, by them.
- **The Voiceflow project's ID.** Ask them for it, or look it up with
  Voiceflow's CLI or MCP server if you have one connected. It isn't a secret:
  put it in \`.env.local\` as \`VOICEFLOW_PROJECT_ID\` yourself.
- **A tool that isn't installed** (cloudflared). Give them the install
  command the message prints. Run an installer only if they say to.

One stop can ask for several of these: hand them all over together.

### Nothing has to be published

Connect creates \`discord_*\` variables on the draft of the agent's
\`${environment}\` environment, for its prompts. The bot works without them
being live. Don't pass \`--publish\` unless the person asks for exactly that:
it makes the whole draft live, including changes that have nothing to do with
this app.

## Rules

- **Never show a secret.** Don't print, echo, log or commit anything from
  \`.env.local\`, or any token or key. To see whether a value is set, count
  it: \`grep -c '^DISCORD_BOT_TOKEN=.' .env.local\`.
- **Don't publish or disconnect** unless the person asked for exactly that.
- **Don't fix it by hand.** Don't change the app in Discord's Developer
  Portal to make something work. Run connect again: it only adds what's
  missing.
- **One bot, one place.** While \`dev\` runs, Discord sends this bot's slash
  commands and buttons to this machine. Don't run it against a bot that's
  deployed and in use: have the person make a second application for
  development.

## Where things are

- \`app/api/discord/route.ts\`: the route. \`app/api/discord/bot.ts\`:
  \`createChannels\`, where the agent and its channels are set.
- \`app/api/discord/gateway/route.ts\`: for a deployment only. On this machine
  \`dev\` does its job.
- \`.env.local\`: the server's settings. \`.env.example\` names each one.
- A server that has an address of its own: \`README.md\`, "Deploy it".
- Every option: \`npx voiceflow-channels connect discord --help\` and
  \`npx voiceflow-channels dev --help\`.
- The rest: [Voiceflow Channels SDK](https://github.com/voiceflow/channels-sdk).
`;
}

function readme(name: string, pm: PackageManager, environment: string): string {
  const connect = runScript(pm, 'connect');
  const deployed = runScript(pm, 'connect', '--public-url https://<your deployment>');
  return `# ${name}

A Voiceflow agent in Discord, served by one Next.js route:
[\`app/api/discord/route.ts\`](app/api/discord/route.ts). Mentions, threads,
direct messages, buttons and \`/ask\` all arrive there.

Made with [\`@voiceflow/create-channels-sdk\`](https://github.com/voiceflow/channels-sdk).

## Run it

With a coding agent, ask it to set this up: [\`AGENTS.md\`](AGENTS.md) tells it
how, and what to hand back to you. By hand, it's four steps, and the first is
the only one in Discord's own pages.

You need Node.js 22 or later, a Voiceflow agent with an API key, and a
Discord server you can add apps to. One tool is used on the way, and is
offered to you when you don't have it:
[cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/),
for the tunnel that gives this machine a public address. It needs no account.

Start it:

\`\`\`bash
${pm} run dev
\`\`\`

The first time, that sets Discord up before it starts the server, and then
both steps below happen in the one run. To set it up alone, run step 1 by itself.

1. Set it up:

   \`\`\`bash
   ${connect}
   \`\`\`

   Discord has no way to make an application from a command, so connect
   opens [the page for it](${NEW_APPLICATION}) and waits:

   - Name the application as connect says (your agent's name), tick the box
     and click **Create**.
   - Open its **Bot** page, click **Reset Token**, and copy the token.
   - Paste it at connect's prompt, which shows nothing as you type.

   That's all you do there. Don't set anything else in the portal.

   Connect reads your agent's details from \`.env.local\` and asks for what
   isn't there: your Voiceflow API key, in a hidden prompt, and your project's
   ID. It shows its plan and asks before it changes
   anything. Then it gives the bot your agent's name and picture, turns on
   the intent that lets the bot read what people write, adds the \`/ask\`
   command, creates the \`discord_*\` variables on your agent's
   \`${environment}\` environment, and fills in \`.env.local\`:
   the app's \`DISCORD_PUBLIC_KEY\` and \`DISCORD_APPLICATION_ID\`, and what it
   asked you for. The bot token stays on this server: it never goes to
   Voiceflow. Nothing is published, and nothing has to be.

   Last, it opens the page that adds the bot to a server: pick the server,
   and authorize. Connect waits for that, says which server the bot is in,
   and has the bot message you in Discord. (\`--server <id>\` has the page
   open with your server chosen, and \`--no-open\` prints the links and
   opens nothing.)

2. Start the server:

   \`\`\`bash
   ${pm} run dev
   \`\`\`

   It opens a tunnel to port 3000, starts the server, gives Discord the
   tunnel's address for slash commands and buttons, and holds the connection
   Discord sends messages over. The address is new each time. Stop it with
   Ctrl-C. For another port, set \`PORT\`.

Mention the bot in a channel, send it a direct message, or use \`/ask\`. A
mention opens a thread, and the conversation carries on there with no
mention needed.

## Deploy it

Discord reaches a bot two ways, and a deployment needs both.

- **Slash commands and buttons** are sent to an address. Run connect again
  with your deployment's: \`${deployed}\`. Discord checks
  the server answers there, so deploy first, with the same environment
  variables as \`.env.local\`.
- **What people write** comes over a standing connection that something has
  to hold. [\`app/api/discord/gateway/route.ts\`](app/api/discord/gateway/route.ts)
  holds it for ten minutes each time it's called, and
  [\`vercel.json\`](vercel.json) calls it every nine. Set \`CRON_SECRET\` to a
  long random value: the route refuses a call without it. Anywhere else, have
  a scheduler send \`GET /api/discord/gateway\` with the header
  \`Authorization: Bearer <CRON_SECRET>\` every nine minutes. Your host has to
  allow a request that long and a schedule that often: check its plan.
- Set \`REDIS_URL\` to a Redis database: conversations live in memory without
  it, and end when the server restarts or a request reaches another instance.
- Use a second Discord application for development. While \`${pm} run dev\`
  runs, Discord sends that bot's slash commands and buttons to your machine,
  and a bot connected from two places answers twice.

## Learn more

- [Voiceflow Channels SDK](https://github.com/voiceflow/channels-sdk): every
  Discord option, and the other channels.
- [Voiceflow's documentation](https://www.voiceflow.com/docs), for building the
  agent itself.
`;
}

export const discord: ChannelStarter = {
  label: 'Discord',
  readme,
  agentsMd,
  next: (pm, _environment, hasProject) => [
    '  Start it:',
    `       ${runScript(pm, 'dev')}`,
    '     The first time, it sets Discord up before it starts. It opens the page for the one step in',
    '     Discord itself: make the application, open its Bot page, click Reset Token, and paste the',
    '     token at the hidden prompt.',
    `     It asks for your Voiceflow API key${hasProject ? '' : ' and project ID'}, adds the /ask command, and opens the page that adds the bot to a server.`,
    '     Then it opens a tunnel, starts the server, and connects it to Discord.',
    `     (${runScript(pm, 'connect')} does the setting up alone.)`,
  ],
};
