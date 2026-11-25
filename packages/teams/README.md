# @voiceflow/channels-teams

A Voiceflow agent in Microsoft Teams: chats, channel threads, mentions,
buttons and cards, with one command to set it up.

> **Status:** an early release. Expect changes between versions before 1.0.
> Built on Chat SDK's Teams adapter. Tested against a stand-in for Teams' bot
> API, and run in Teams itself: a chat, a mention and its thread, a reply with
> no mention, buttons, a card, and a bot made by `connect teams`.

## Connect

```bash
npx voiceflow-channels connect teams --env-file .env.local
```

Connect runs Microsoft's own Teams command
([`@microsoft/teams.cli`](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-developer-cli-overview))
to make the app, its bot and the bot's secret. **No Azure account is needed.**
The first time, that command has you sign in to Microsoft 365 with the account
you use Teams with: in your browser, or with a link and a code where no
browser can open.

It shows its whole plan and asks before it changes anything:

```
Microsoft 365: signed in as ada@contoso.com (organization 2f6c…)
  + make a Teams app and its bot, named "Support" after your agent in Voiceflow (--name gives another)
  + give it the agent's avatar in Voiceflow as its picture, made the 192 by 192 pixels Teams takes (Voiceflow's icon if it can't be): https://…/avatar.png
  + let it read a thread's replies, so they need no mention (the permission ChannelMessage.Read.Group: Teams then sends it everything written in a channel it's added to, and it answers only in threads where it was mentioned)
  · Teams needs your server's address: `voiceflow-channels dev` gives it one each time it starts
Voiceflow: project "Support" (64f…) in workspace a1B2c3, environment development: the variables go on its draft
  + 9 variables for your agent's prompts (teams_user_id, teams_user_aad_id, …)
  ~ compile the environment's draft
Then:
  · nothing is published, and nothing has to be: the variables are live once you publish development
  + .env.local gets TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID
  + you get the link that adds the bot in Teams
```

- **Two things are Microsoft's to allow.** Your organization has to let people
  add apps of their own to Teams (an admin turns it on, once: connect says
  exactly where when it's off), and you click **Add** in Teams yourself.
  A personal Microsoft account can't have a bot.
- **The bot looks like your agent.** A new app gets the agent's name in
  Voiceflow (Teams allows 30 characters) and its avatar, or Voiceflow's icon
  when the agent has none. Teams takes only a PNG of exactly 192 by 192
  pixels, so the picture is cut square and scaled here; an avatar that isn't a
  PNG gives way to Voiceflow's icon, and connect says so. `--name` and
  `--icon <url>` set them; `--icon none` leaves Teams' placeholder.
- **Everything goes in before the app is first added.** A permission added to
  an app that was already in Teams made Teams refuse to add it again, in a
  live run. So connect sets the name, the picture and the permission as it
  makes the app, and run again it keeps the app as it is. The address Teams
  sends to is the one thing changed afterwards, and Teams takes that at once.
- **What it writes:** `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` and
  `TEAMS_APP_TENANT_ID` go in the `--env-file` the moment the app is made, with
  anything it had to ask for. The secret is Microsoft's to make and shown
  once: it goes to that file, readable by you alone, and never to Voiceflow or
  the screen.
- **Your Microsoft 365 sign-in is Microsoft's command's.** This package never
  sees your password or its tokens.
- **A page is opened only for a person who is there**, in a browser that is
  theirs: never for a script or a coding agent, never over SSH or in CI, and
  never with `--no-open`. The link is always printed.
- **With nobody at the terminal** (a script, a coding agent) connect asks
  nothing. It stops with exit code 3 and says, in the one stop, everything a
  person has to do: the sign-in, which agent, its key. Exit 0 is done, 1 a
  failure, 2 a mistake in the command.
- **Adding the bot** is a page connect opens, and a link it prints. Teams
  first offers its desktop app ("Use the web app instead" goes on in the
  browser), then **Add**. From there **Open** starts a chat with the bot, and
  picking a team's channel adds it there.
- **`voiceflow-channels dev` runs connect for you** the first time, when no
  bot was connected from here and a person is there. So in an app the starter
  made, `npm run dev` is the one command.
- **Nothing is published.** The bot works as soon as it's added. The
  `teams_*` variables are for your agent's prompts, and are live once you
  publish the environment. `--publish` does that here: the whole draft goes live.
- **`--dry-run`** shows the plan and changes nothing.
- **`disconnect teams`** says how to remove the bot. Microsoft gives no
  command for it, so the three steps are yours, each with its link.

## How Teams reaches your server

Teams sends everything it has for the bot to one address, each request
signed by Microsoft: a message in a chat or a channel, a button's click, the
bot being added somewhere. The adapter checks the signature before anything
is done.

**On your machine,** `voiceflow-channels dev -- <your server's command>` opens
a tunnel and gives Teams the tunnel's address (`point teams`), each time it
starts. Teams takes a new address at once, for an app already added: nobody
adds it again.

**Deployed,** give Teams your address with
`connect teams --env-file <path> --public-url https://<host>`. Use a second
Teams app for development, with an env file of its own: while `dev` runs,
Teams sends that bot's messages to your machine.

## In your server

```ts
import { teams } from '@voiceflow/channels-teams';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [teams()], // reads TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID
  state,
});
// One route takes everything: channels.webhook('teams', request, { waitUntil })
```

In a bundled server, keep the Teams adapter out of the bundle: Microsoft's
Teams SDK loads parts of itself by name. In Next.js that is
`serverExternalPackages: ['@chat-adapter/teams']`.

### What happens in Teams

- **A chat with the bot** is answered where it was written.
- **A mention in a channel** is answered in the thread on that post, and the
  conversation carries on there with no mention needed. The bot's own mention
  is taken out of what the agent is sent, whatever the bot is called.
- **Buttons, cards, carousels and images** from the agent are Adaptive Cards.
  A click sends the button's own request, as the person who clicked, and the
  buttons come off once one is chosen.
- **A long answer** goes as several messages, cut where the text breaks, at
  20,000 characters: Teams refuses a message that is too large whole.
- **A heading** is sent as a bold line: Teams shows no headings.

Threads with no mention need the permission `ChannelMessage.Read.Group`, which
connect asks for. With it Teams sends the bot everything written in a channel
it's added to; the bot answers only in threads where it was mentioned, and
does nothing with the rest. `connect teams --mentions-only`, on a new app,
leaves the permission out: then every message to the bot in a channel needs a
mention.

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Teams adapter's own config: `appId`, `appPassword`, `appTenantId`, `logger`, … |
| `context` | `true` | Set who and where as `teams_*` variables on every turn. |
| `headings` | `true` | Send a heading as a bold line. |

By default the adapter's warnings and errors are printed, each a line. A
failed call to Teams is its name, its message, its status and what Teams
answered: never the request, which carries the bot's access token. Pass
`adapter: { logger }` for a logger of your own: it gets the same lines, with
the token and the app's secret taken out the same way.

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{teams_user_name}`).

| Variable | What it holds |
|---|---|
| `teams_user_id` | The person's ID in Teams, as this bot knows them (`29:…`). |
| `teams_user_aad_id` | The person's Microsoft Entra object ID: the same in every app of their organization. |
| `teams_user_name` | The person's name in Teams. |
| `teams_user_email` | The person's email address in Teams. Empty when Teams doesn't say. |
| `teams_tenant_id` | The ID of the person's Microsoft 365 organization (tenant). |
| `teams_team_id` | The team's ID. Empty outside a team's channel. |
| `teams_channel_id` | The channel's ID. Empty outside a team's channel. |
| `teams_conversation_type` | `personal` (a chat with the bot), `channel` or `groupChat`. |
| `teams_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |

## What it doesn't do yet

- **No Teams tools for the agent.** Slack's package installs tools that act
  in Slack; this one installs none.
- **No forms, tables or charts as cards.** Buttons, cards and carousels are
  shown, and a markdown table is a table; Slack's other presentation traces
  have no Teams equivalent here yet.
- **No streamed answers.** Each reply is posted whole, with Teams' typing
  indicator while the agent works.
- **No files.** The agent's images are shown; a file sent as an attachment
  was refused by Teams when tried.
- **One organization.** A bot made by connect is for the Microsoft 365
  organization that made it. Listing it for other organizations is Microsoft's
  store, and not this package's.
