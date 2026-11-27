# @voiceflow/channels-discord

A Voiceflow agent in Discord: mentions, threads, direct messages, buttons,
cards and a slash command, with one command to set it up.

> **Status:** an early release. Expect changes between versions before 1.0.
> Built on Chat SDK's Discord adapter. Tested against a stand-in for Discord's
> API, and run in Discord itself: a mention and its thread, a direct message,
> buttons and `/ask`.

## Connect

```bash
npx voiceflow-channels connect discord --dotenv .env.local
```

Discord has no way to make an application from a command, so that one step is
by hand, and connect walks you through it. It opens
[the page that makes one](https://discord.com/developers/applications?new_application=true)
and says what to name it (your agent's name: Discord has no way to fill that
in). You create it, open its **Bot** page, click **Reset Token**, and paste the
token at connect's hidden prompt. That is all you do in the portal.

It shows its whole plan and asks before it changes anything:

```
Discord: app "My app" (1234567890), bot My app
  ~ name the bot "Support", your agent's name in Voiceflow (it is "My app" now; --name keep leaves it)
  + set the bot's picture to the agent's avatar in Voiceflow (Voiceflow's icon if Discord won't take it): https://…/avatar.png
  + turn on the Message Content intent, so the bot is sent what people write
  + add the /ask command
  · slash commands and buttons need your server's address: `voiceflow-channels dev` gives it to Discord each time it starts
Voiceflow: project "Support" (64f…) in workspace a1B2c3, environment development: the variables go on its draft
  + 8 variables for your agent's prompts (discord_user_id, discord_user_name, …)
  ~ compile the environment's draft
Then:
  · nothing is published, and nothing has to be: the variables are live once you publish development
  + you get the link that adds the bot to a server
```

- **The bot looks like your agent.** A new app's bot gets the agent's name in
  Voiceflow, and a bot with no picture gets the agent's avatar, or Voiceflow's
  icon when the agent has none. A bot connected before keeps its name, and a
  bot with a picture keeps it: `--name <name>` and `--icon <url>` set them
  anyway, and `--name keep` and `--icon none` leave a new bot as it is. The
  application's own name, shown on the page that adds the bot, is the one you
  typed in the portal: Discord has no call to change it.
- **What it writes:** `DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID`, read
  from Discord, go in the `--dotenv` with anything it had to ask for. A value
  already there is never changed. The bot token goes to Discord and that file,
  and never to Voiceflow.
- **The bot token** comes from `--token-file`, `DISCORD_BOT_TOKEN` in the
  environment, the same name in `--dotenv`, or a hidden prompt.
- **Pages are opened only for a person who is there**, in a browser that is
  theirs: never for a script or a coding agent, never over SSH or in CI, and
  never with `--no-open`. The links are always printed.
- **With nobody at the terminal** (a script, a coding agent) connect asks
  nothing. It stops with exit code 3 and says, in the one stop, everything a
  person has to do: the token, which agent, its key. Exit 0 is done, 1 a
  failure, 2 a mistake in the command.
- **Adding the bot to a server** is a page connect opens, and a link it
  prints: whoever opens it picks the server and authorizes. `--server <id>` has
  it open with your server chosen. It asks for the permissions the bot uses:
  to see channels, send messages (in threads too), open and manage threads,
  read history, react, embed links, attach files and use slash commands.
- **Connect waits for the bot to be added**, when a person is there: up to
  five minutes, then it says which server the bot is in, and the bot messages
  you in Discord to say it's connected (you, because the application is
  yours; nothing is posted in the server). `--no-wait` and `--no-greeting`
  turn each off.
- **`voiceflow-channels dev` runs connect for you** the first time, when the
  bot was never connected from here and a person is there. So in an app the
  starter made, `npm run dev` is the one command.
- **Nothing is published.** The bot works as soon as it's connected. The
  `discord_*` variables are for your agent's prompts, and are live once you
  publish the environment. `--publish` does that here: the whole draft goes live.
- **Running it again** only adds what's missing. `--dry-run` shows the plan
  and changes nothing.
- **`disconnect discord`** deletes the slash command and clears the address
  Discord sends to. The application and its bot are yours to remove.

## How Discord reaches your server

Discord reaches a bot two ways, and this package uses both.

| What | How it arrives |
|---|---|
| Slash commands, button clicks | Discord sends them to an address, signed with the app's key. |
| What people write, reactions | Over a standing connection (Discord's Gateway) that something has to hold. Whatever holds it passes each event on to the same route. |

**On your machine,** `voiceflow-channels dev -- <your server's command>` does
both: it opens a tunnel, gives Discord the tunnel's address
(`point discord`), and holds the connection, passing events to your server.

**Deployed,** give Discord your address with
`connect discord --public-url https://<host>` (it checks your server answers
there), and hold the connection yourself. On a host that doesn't keep a
process running, a scheduled route does it:
[`examples/nextjs-discord`](../../examples/nextjs-discord) has one, with its
schedule. Use a second Discord application for development: while `dev` runs,
Discord sends that bot's slash commands and buttons to your machine, and a
bot connected from two places answers twice.

## In your server

```ts
import { discord } from '@voiceflow/channels-discord';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [discord()], // reads DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY and DISCORD_APPLICATION_ID
  state,
});
// One route takes everything: channels.webhook('discord', request, { waitUntil })
```

In a bundled server, keep the Discord adapter out of the bundle: it loads
optional native modules by name. In Next.js that is
`serverExternalPackages: ['@chat-adapter/discord']`.

### What happens in Discord

- **A mention in a channel** opens a thread on the message, named after what
  was asked, and the agent answers there. The conversation carries on in the
  thread with no mention needed.
- **A direct message** is answered where it was sent.
- **`/ask question: …`** posts the question where everyone can see it, and
  answers in a thread on it. In a direct message or a thread, it answers in place.
- **Buttons, cards, carousels and images** from the agent are Discord buttons
  and embeds. A click sends the button's own request, as the person who clicked.
- **A long answer** goes as several messages, cut where the text breaks:
  Discord shows 2,000 characters in one.

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Discord adapter's own config: `botToken`, `publicKey`, `applicationId`, `respondToChannelIds`, `mentionRoleIds`, `logger`, … |
| `context` | `true` | Set who and where as `discord_*` variables on every turn. |
| `titles` | `true` | Name the thread opened for a conversation after the first message. A thread people made is never renamed. |
| `slashCommands` | `true` | Answer the app's slash command. |

The adapter logs every event it's passed, and Discord's connection passes on
many that aren't for the bot. By default only its warnings and errors are
printed: pass `adapter: { logger }` for more.

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{discord_user_name}`).

| Variable | What it holds |
|---|---|
| `discord_user_id` | The Discord user ID of the person in this conversation. |
| `discord_user_name` | The person's display name in Discord. |
| `discord_user_handle` | The person's Discord username (their unique handle). |
| `discord_guild_id` | The Discord server (guild) ID. Empty in a direct message. |
| `discord_channel_id` | The channel this conversation is in: for a thread, the channel it was started in. |
| `discord_thread_id` | The thread this conversation is in. Empty when it isn't in one. |
| `discord_channel_type` | `channel`, `thread` or `dm`. |
| `discord_message_id` | The ID of the person's latest message. Empty when the turn came from a button or a slash command. |

## What it doesn't do yet

- **No Discord tools for the agent.** Slack's package installs tools that act
  in Slack; this one installs none.
- **No forms, tables or charts.** Buttons, cards and carousels are shown;
  Slack's other presentation traces have no Discord equivalent here yet.
- **No streamed answers.** Each reply is posted whole, with Discord's typing
  indicator while the agent works: the core streams only where a platform
  streams natively.
