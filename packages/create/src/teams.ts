// The Teams starter's own words: its README, its notes for a coding agent, and what to do next.
import { type ChannelStarter, type PackageManager, runScript } from './shared.js';

/** Microsoft's own Teams command, which connect runs: how a person runs it themselves. */
const MS_CLI = 'npx @microsoft/teams.cli@3';
const ADMIN = 'https://admin.teams.microsoft.com/policies/app-setup';

function agentsMd(name: string, pm: PackageManager, environment: string): string {
  return `# ${name}: notes for coding agents

This app puts a Voiceflow agent in Microsoft Teams. One route,
\`app/api/teams/route.ts\`, takes everything Teams has for the bot.
\`README.md\` covers the same ground for a person.

## Setting it up

When you're asked to set this up, connect it to Teams or get it running, do
these in order. No command here asks you anything: each stops when it needs
something, and says what.

1. **See the plan:** \`${runScript(pm, 'connect', '--dry-run')}\`. It changes nothing. The
   first time, it stops with code 3: nobody is signed in to Microsoft 365.
   See "Signing in" below, then run it again.
2. **Show the person the plan and ask whether to go ahead.** Give them, as
   the plan prints them, the Microsoft 365 account and the Voiceflow project
   with its workspace and environment.
3. **Set it up, on their go-ahead:** \`${runScript(pm, 'connect', '--yes')}\`.
4. **Give them the link it prints**, whole. They open it, choose "Use the web
   app instead" if they don't have Teams' desktop app, and click **Add**.
   Then **Open** starts a chat with the bot, and picking a team's channel
   adds it there. You can't do this for them.
5. **Start it:** \`${runScript(pm, 'dev')}\`, as a background process. It keeps
   running. It's ready when it has printed \`pointed at\`.

Then tell the person to write to the bot in its chat, or to mention it in the
channel they added it to.

### Signing in

Connect runs Microsoft's own Teams command, and that command holds the
sign-in. To sign the person in, run this as a background process:

\`\`\`bash
${MS_CLI} login --device-code
\`\`\`

It prints a link and a code. Give the person both, and say what it is for:
letting Microsoft's command on this machine make a Teams app in their
organization. They open the link, enter the code, and approve. The command
ends when they have. Don't ask for their password, and don't enter the code
for them.

### Read the exit code

| Code | Means | Do |
|---|---|---|
| 0 | Done | Go on |
| 3 | It's waiting on the person | Give them its message as it is, wait for them, then run the same command again |
| 2 | The command was wrong | Fix what its message names |
| 1 | It failed | Read its message. Running it again finishes what it started |

What a code 3 asks for is the person's to do, not yours:

- **The Microsoft 365 sign-in.** As above.
- **Letting people add their own apps to Teams.** An admin of their
  organization turns that on, once (${ADMIN}).
  Give them the message as it is: it says exactly where. You can't do this.
- **A Voiceflow API key.** Ask them to put it in \`.env.local\` themselves, as
  \`VOICEFLOW_API_KEY\`. Don't ask them to paste it to you.
- **The Voiceflow project's ID.** Ask them for it, or look it up with
  Voiceflow's CLI or MCP server if you have one connected. It isn't a secret:
  put it in \`.env.local\` as \`VOICEFLOW_PROJECT_ID\` yourself.
- **A tool that isn't installed** (cloudflared). Give them the install
  command the message prints. Run an installer only if they say to.

One stop can ask for several of these: hand them all over together.

### Nothing has to be published

Connect creates \`teams_*\` variables on the draft of the agent's
\`${environment}\` environment, for its prompts. The bot works without them
being live. Don't pass \`--publish\` unless the person asks for exactly that:
it makes the whole draft live, including changes that have nothing to do with
this app.

## Rules

- **Never show a secret.** Don't print, echo, log or commit anything from
  \`.env.local\`, or any token or key. To see whether a value is set, count
  it: \`grep -c '^TEAMS_APP_PASSWORD=.' .env.local\`.
- **Don't publish or disconnect** unless the person asked for exactly that.
- **Don't change the app by hand.** Not in Teams' Developer Portal, and not
  with Microsoft's command: once an app has been added to Teams, a change to
  its permissions can make Teams refuse to add it again. Connect sets
  everything before the app is first added; run again, it keeps the app as it
  is. The address Teams sends to is the one thing changed afterwards, and
  \`dev\` does that.
- **One bot, one place.** While \`dev\` runs, Teams sends this bot's messages
  to this machine. Don't run it against a bot that's deployed and in use:
  have the person connect a second app for development, with an env file of
  its own.

## Where things are

- \`app/api/teams/route.ts\`: the route. \`app/api/teams/bot.ts\`:
  \`createChannels\`, where the agent and its channels are set.
- \`.env.local\`: the server's settings. \`.env.example\` names each one.
- A server that has an address of its own: \`README.md\`, "Deploy it".
- Every option: \`npx voiceflow-channels connect teams --help\` and
  \`npx voiceflow-channels dev --help\`.
- The rest: [Voiceflow Channels](https://github.com/voiceflow/channels-sdk).
`;
}

function readme(name: string, pm: PackageManager, environment: string): string {
  const connect = runScript(pm, 'connect');
  const deployed = runScript(pm, 'connect', '--public-url https://<your deployment>');
  return `# ${name}

A Voiceflow agent in Microsoft Teams, served by one Next.js route:
[\`app/api/teams/route.ts\`](app/api/teams/route.ts). Chats, channel threads,
mentions, buttons and cards all arrive there.

Made with [\`create-voiceflow-channels\`](https://github.com/voiceflow/channels-sdk).

## Run it

With a coding agent, ask it to set this up: [\`AGENTS.md\`](AGENTS.md) tells it
how, and what to hand back to you. By hand, it's two steps.

You need:

- Node.js 22.12 or later.
- A Voiceflow agent with an API key.
- A Microsoft 365 work or school account with Teams. A personal Microsoft
  account can't have a bot.
- An organization that lets people add apps of their own to Teams. Many do;
  where it's off, connect says so, and an admin turns it on once at
  [Teams admin center → Teams apps → Setup policies](${ADMIN}).

No Azure account is needed. Two tools are used on the way, and each is
fetched or offered when you don't have it: Microsoft's own Teams command
(\`@microsoft/teams.cli\`), which makes the app and holds your sign-in, and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/),
for the tunnel that gives this machine a public address.

Start it:

\`\`\`bash
${pm} run dev
\`\`\`

The first time, that sets Teams up before it starts the server, and then both
steps below happen in the one run. To set it up alone, run step 1 by itself.

1. Set it up:

   \`\`\`bash
   ${connect}
   \`\`\`

   Connect has you sign in to Microsoft 365, with the account you use Teams
   with: Microsoft's command opens your browser for it, or prints a link and
   a code where no browser can open. It reads your agent's details from
   \`.env.local\` and asks for what isn't there: your Voiceflow API key, in a
   hidden prompt, and your project's ID. It shows its plan and asks before it
   changes anything.

   Then it has Microsoft make the Teams app, its bot and the bot's secret,
   gives the bot your agent's name and picture, asks for the permission that
   lets it read a thread's replies, creates the \`teams_*\` variables on your
   agent's \`${environment}\` environment, and fills in \`.env.local\`:
   \`TEAMS_APP_ID\`, \`TEAMS_APP_PASSWORD\`, \`TEAMS_APP_TENANT_ID\`, and what it
   asked you for. The secret stays on this server: it never goes to
   Voiceflow. Nothing is published, and nothing has to be.

   Last, it opens the page that adds the bot in Teams. Choose **Use the web
   app instead** if you don't have Teams' desktop app, and click **Add**.
   Then **Open** starts a chat with the bot, and picking a team's channel
   adds it there. (\`--no-open\` prints the link and opens nothing.)

2. Start the server:

   \`\`\`bash
   ${pm} run dev
   \`\`\`

   It opens a tunnel to port 3000, starts the server, and gives Teams the
   tunnel's address for the bot's messages. The address is new each time, and
   Teams takes it at once: nobody adds the bot again. Stop it with Ctrl-C.
   For another port, set \`PORT\`.

Write to the bot in its chat, or mention it in a channel it was added to. In
a channel the bot answers in the thread on your post, and the conversation
carries on there with no mention needed.

That last part needs a permission (\`ChannelMessage.Read.Group\`), which
connect asks for: with it, Teams sends the bot everything written in a channel
it's added to, and the bot answers only in threads where it was mentioned.
\`${runScript(pm, 'connect', '--mentions-only')}\`, on a new app, leaves it out: then every
message to the bot in a channel needs a mention.

## Deploy it

- Deploy the app with the same environment variables as \`.env.local\`, then
  give Teams its address: \`${deployed}\`.
- Set \`REDIS_URL\` to a Redis database: conversations live in memory without
  it, and end when the server restarts or a request reaches another instance.
- Use a second Teams app for development, with an env file of its own. While
  \`${pm} run dev\` runs, Teams sends that bot's messages to your machine.
- To let other people in your organization add the bot, send them the link
  connect printed. For everyone to find it in Teams' app list, an admin
  publishes it to your organization from Teams' Developer Portal.

## Learn more

- [Voiceflow Channels](https://github.com/voiceflow/channels-sdk): every
  Teams option, and the other channels.
- [Voiceflow's documentation](https://www.voiceflow.com/docs), for building the
  agent itself.
`;
}

export const teams: ChannelStarter = {
  label: 'Microsoft Teams',
  readme,
  agentsMd,
  next: (pm, _environment, hasProject) => [
    '  Start it:',
    `       ${runScript(pm, 'dev')}`,
    '     The first time, it sets Teams up before it starts. It has you sign in to Microsoft 365, with',
    '     the account you use Teams with: no Azure account is needed.',
    `     It asks for your Voiceflow API key${hasProject ? '' : ' and project ID'}, makes the bot, and opens the page that adds it in Teams:`,
    '     click Add there.',
    '     Then it opens a tunnel, starts the server, and gives Teams its address.',
    `     (${runScript(pm, 'connect')} does the setting up alone.)`,
  ],
};
