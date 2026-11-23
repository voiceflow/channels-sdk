# @voiceflow/channels-slack

A Voiceflow agent in Slack at full fidelity: everything Slack has is on by
default, and Slack's tools are installed on the agent when you connect it.

> **Status:** pre-release, local only. Not published. The package name is not final.

## Connect

One command makes the Slack app, installs it, and installs Slack's tools on
your agent:

```bash
npx voiceflow-channels connect slack --public-url https://<your server> --env-file .env
```

It shows its whole plan and asks before it changes anything:

```
Slack: workspace Acme (T0123)
  + create app "Support" from the manifest: 21 bot scopes, 10 events, the assistant panel, the Home tab, /ask
    requests go to https://<your server>/api/slack (Slack checks it answers while it creates the app)
  + set its icon to the agent's avatar in Voiceflow: https://…/avatar.png
  + install it in Acme (its bot token is for your server alone: it never goes to Voiceflow)
Voiceflow: project "Support" (64f…) in workspace a1B2c3, environment development (nothing is published)
  + variable slack_user_id
  …
  + secret channels_tools_url (new, restricted; value: where your server runs the tools)
  + tool slack_react: create and attach
  …
  ~ compile the environment (nothing is published)
    Slack's tools run on your server: the agent calls them at https://<your server>/api/slack
```

- **Slack login:** the [Slack CLI](https://tools.slack.dev/slack-cli)'s
  (`slack login`). Pick a workspace with `--team` when it's logged in to several.
- **Which agent:** `--project` and `--environment`, or `VOICEFLOW_PROJECT_ID`
  and `VOICEFLOW_ENVIRONMENT` in the environment or in the `--env-file`. With
  neither, connect asks.
- **Voiceflow key:** `VOICEFLOW_API_KEY`, in the environment or in the
  `--env-file`; `--key-file`; or a hidden prompt. Never a command-line value.
- **The env file ends up complete.** Connect writes the app's
  `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` to the file you name with
  `--env-file`, readable by you alone, and anything it had to ask you for. It
  never changes a Voiceflow value that's already there. Without the flag,
  connect tells you where Slack shows the app's credentials. Slack gives out a
  new app's signing secret once, when connect makes the app.
- **Slack checks the request URL** while it makes the app. Point your tunnel at
  `--port` (default 3000) while connect runs, and connect answers the check
  itself. When your server already holds that port, it answers instead.
- **The bot token stays with your server.** The tools that act in Slack run
  on your server, so Voiceflow gets only the address the agent calls them at:
  the webhook URL, or `--tools-url` for a route of their own. When that
  address changes, run connect again.
- **It never publishes.** The tools land on the environment's draft, compiled.
  **Your bot runs the environment's published version**, so publish the
  environment in Voiceflow before you try the tools in Slack: until then the
  agent there doesn't have them. In Voiceflow's test chat the tools that act
  in Slack say they only work there.
- **`--workspace <id>`** stops connect, changing nothing in Slack or Voiceflow,
  unless the project is in that Voiceflow workspace.
- **Running it again only adds what's missing.** It reuses the app it made (kept
  in `.voiceflow/channels-slack-apps.json`, no secrets), and `--app <id>` adds
  what this package needs to an app you already have: scopes, events and
  features are only added, never taken away.
- **The app looks like your agent.** A new app takes the agent's name and its
  avatar from Voiceflow (the project's name and image). An agent with no avatar
  gets Voiceflow's icon (the butterfly on Voiceflow blue), and so does one whose
  avatar Slack won't take. `--name` and `--icon <url>` choose others;
  `--icon none` sets none. An app that already exists keeps its icon unless you
  name one. Slack takes a PNG, JPG or GIF from 512 to 2000 pixels, and fits a
  non-square one between white bars, so a square avatar looks best. When Slack
  refuses an icon you named, connect still finishes and says how to set one.
- `--dry-run` shows the plan and stops. `--yes` skips the question.
  `--no-tools` makes the app and installs no tools. `--no-workspace-tools`
  installs only the presentation tools (pass `workspaceTools: false` to
  `slack()` then). `--print-manifest` prints the app's manifest, to paste into
  api.slack.com ("Create New App", "From a manifest").
- `voiceflow-channels disconnect slack` deletes the app. The tools stay on the
  agent unless you add `--remove-tools`.

The same steps are a function, for your own scripts:
`connectSlack()` and `disconnectSlack()` from `@voiceflow/channels-slack/connect`.

## Run it

```ts
import { createRedisState } from '@chat-adapter/state-redis';
import { createChannels } from '@voiceflow/channels-sdk';
import { slack } from '@voiceflow/channels-slack';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: '64f…', environment: 'development' },
  channels: [slack()], // reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET
  state: createRedisState(),
});
```

Route `POST /api/slack` to `channels.webhook('slack', request)`. Events, button
clicks, dialogs and the slash command all arrive there, and so do the calls the
agent's Slack tools make. In Next.js, make the
bot on the first request rather than at build time, as
[`examples/nextjs-slack`](../../examples/nextjs-slack/app/api/slack/route.ts) does:
the build has no Slack signing secret. `slack()` carries the Slack adapter's
module, so the bundle needs nothing more.

## What it does in Slack

Each is on by default except the feedback buttons; `slack({ … })` turns any of
them off, or the buttons on.

| Behaviour | Option |
|---|---|
| 👀 on the person's message while the agent works, taken off when it's done | `workingReaction` |
| A reaction left when the reply is done | `doneReaction` (default none) |
| Mentioned partway through a thread, the agent reads the earlier messages first | `catchUp` (20) |
| The assistant panel: the launch turn runs when it opens, its buttons become suggested prompts | `launchOnOpen` |
| The panel's thread is named after the person's first message | `titles` |
| Who and where, as `slack_*` variables on every turn | `context` |
| 👍 / 👎 reactions someone adds to the agent's messages reach `onFeedback` (nothing shows in Slack) | `feedbackReactions` |
| Slack's 👍 / 👎 feedback buttons under each answer, reaching `onFeedback`: `true`, or `{ positiveLabel, negativeLabel }` | `feedbackButtons` (default off) |
| `/ask <question>` posts the question in the channel and answers in its thread | `slashCommands` |
| The App Home tab | `home` |

The `slack_*` variables: `slack_user_id`, `slack_user_name`, `slack_user_title`,
`slack_user_timezone`, `slack_user_email`, `slack_team_id`, `slack_channel_id`,
`slack_channel_name`, `slack_channel_type`, `slack_thread_ts`,
`slack_message_ts`, `slack_viewing_channel_id`.

**They are for the agent's prompts, and the agent sees only the ones you
reference.** It sees a variable only where its instructions or global prompt
reference it: a variable is stored data, not the model's context
([Voiceflow's docs](https://www.voiceflow.com/docs/documentation/build/data/variables#stored-values-and-model-context)).
Slack's tools don't read them: they take who is asking from the turn itself
([Who a tool acts for](#who-a-tool-acts-for)).
Without a reference, asked "what time zone am I in?", the agent rightly says
it can't tell. To let it know who it's talking to, add a line like this to the
global prompt:

```
You're talking to {slack_user_name}. Their title: {slack_user_title}. Their time zone: {slack_user_timezone}.
```

Use the values that stay the same through a conversation. Leave out the ones
that change every turn (the channel, thread and message): a prompt that changes
between turns makes every response slower and more expensive
([Global prompt, Variable consistency](https://www.voiceflow.com/docs/documentation/build/global-prompt)).

## Slack's tools

Connect installs these on the agent, as Voiceflow functions attached as tools.

- A **presentation** tool returns a trace this package shows natively.
- A **workspace** tool acts in Slack. Its function on the agent only passes the
  call to your server, which runs it with the Slack adapter's own client. No
  Slack credential goes to Voiceflow.

| Tool | Kind | Scopes | What it does | Asks the person first |
|---|---|---|---|---|
| `slack_react` | presentation | reactions:write | Add an emoji reaction to the person's latest message. | — |
| `slack_show_table` | presentation | — | Show data as a native Slack table. | — |
| `slack_show_chart` | presentation | — | Show numbers as a native Slack chart (bar, line, area or pie). | — |
| `slack_reply_privately` | presentation | — | Send the person a message only they can see. | — |
| `slack_ask_form` | presentation | — | A button that opens a Slack dialog; the answers come back as the person's next message. | — |
| `slack_post_to_channel` | workspace | chat:write, channels:read, groups:read, channels:history, groups:history | Post in a channel for the person. | Always |
| `slack_message_person` | workspace | chat:write, im:write, im:history, users:read, users:read.email | Send someone a direct message for the person. | Unless it's to themselves |
| `slack_read_channel` | workspace | channels:history, groups:history, channels:read, groups:read, users:read | Read a channel's recent messages. | No |
| `slack_find_person` | workspace | users:read, users:read.email | Look people up by name, title or email. | No |
| `slack_schedule_message` | workspace | chat:write, channels:read, groups:read, users:read | Schedule a message for later. | Unless it's a reply in this thread |
| `slack_pin_message` | workspace | pins:write, channels:read, groups:read | Pin a message. | For another channel |
| `slack_add_bookmark` | workspace | bookmarks:write, channels:read, groups:read | Add a link to a channel's bookmarks bar. | Outside a direct message |
| `slack_create_canvas` | workspace | canvases:write | Write a Slack canvas, shared with the person. | No |
| `slack_send_file` | workspace | files:write | Send a text file in the conversation. | No |

### Who a tool acts for

The bot can reach more than the person talking to it, so the workspace tools
act only within what that person can see, and only for the conversation they
were called from:

- **Who is asking comes from Slack, never the model.** On every turn your
  server makes a pass that names the thread and the person, from Slack's
  verified event, and signs it with a key only the server holds. The agent's
  tool sends the pass back with its call, and the server acts for the
  conversation the pass names: nothing in the call can name another.
- **A call from anywhere else does nothing.** Voiceflow's test chat, a web
  chat on the same agent, or anyone calling your server directly has no pass.
  A pass stops working when its turn ends, wherever the bot's state is shared
  (Redis). Otherwise it lasts as long as a turn can, plus 30 seconds: two
  minutes by default.
- **What leaves the conversation waits for approval.** Before a post in a
  channel, a message to someone else, or a link on a channel's bookmarks bar,
  the agent posts a request with **Approve** and **Cancel** in the thread.
  Only the person who asked can approve it, with a click Slack signs, and the
  tool then acts once. What stays in the conversation (a reminder in this
  thread, a file, a canvas) and what only reads needs no approval.
- **What they approve is what they see.** The request shows where it goes, by
  the channel or the person's real name and title, and the whole message,
  quoted. A message too long to show in full (12,000 characters) isn't asked
  about and isn't sent. What runs is the channel or person the request showed,
  by ID.
- **`requireApproval`** on `createChannels` changes when a tool asks: `false`
  never asks, `true` asks before every tool that acts, or say per tool
  (`{ slack_post_to_channel: false }`).
- **Only where the person is.** A tool that reads or posts in a channel checks
  the person is a member of it first (the conversation they're in always
  passes), and refuses otherwise. The refusal is the same whether the channel
  exists or not, so it says nothing about private channels.
- **What's read stays with those who could read it.** In a channel, the agent
  reads only that channel: everyone there sees what it says. Another channel is
  read only in a direct message (the assistant panel is one).
- **The directory is for full members.** Guests, people from another
  organization in a shared channel, and other apps can't look people up or
  message them through the agent. In a channel a lookup shows names and
  mentions, as a message would; titles and time zones are for a direct
  message. It never shows an email: a workspace can hide its members' emails
  from each other, and the bot sees them all.
- **A name means one person or it's a question.** Someone's full name picks
  them. A handle or display name, which its owner chose, picks them only when
  no one else matches: otherwise the agent asks which person.
- **Posts say who asked.** A post or message made for someone carries a line
  saying so ("Posted for @ada").
- **Times are the person's.** A relative time (`in 10 minutes`) counts from
  now, so the agent needn't know the time; a date without an offset is read in
  their time zone.
- **A repeated call posts once.** An agent retries a call it thinks was slow; a
  post or message with the same text, made for the same person in the last two
  minutes, is answered with the first one instead of going up twice.
- **Channels by name are the bot's own.** A `#name` is looked up among the
  channels the bot is in (the only ones it can read or post in), in one call.

Approval requests are kept in the bot's state for ten minutes
(`approvalTimeoutMs` on `createChannels` changes that), so on more than one
instance they need a shared state adapter (Redis), as conversations do.

The tools need the app's bot token as a plain value on the server
(`SLACK_BOT_TOKEN`), which is what connect sets up: one app in one workspace.
With a token the adapter looks up per workspace, they answer that the server
has no token to act with.

### After connect, the tools are yours

Edit their descriptions, detach or delete them in Voiceflow. A later connect
(or `installTools`) leaves your changes alone: a function you edited is never
overwritten, and a tool you deleted or detached is never added again unless
you name it with `--restore`. An unedited tool is updated when this package
ships a new version. What was installed is kept in
`.voiceflow/channels-install.json`: commit it with your server's code.

What a workspace tool does is in this package, on your server, and changes
when you update the package. For a tool of your own, write a
[server tool](../core/README.md#server-tools).

To install the tools without connect:

```ts
import { installTools } from '@voiceflow/channels-sdk/install';
import { slackTools } from '@voiceflow/channels-slack';

await installTools(slackTools(), {
  apiKey, projectID, environment: 'development',
  // Where the agent calls the tools: the route that runs channels.webhook('slack', request).
  secretValues: { channels_tools_url: 'https://<your server>/api/slack' },
});
```

If you connected an agent before the tools ran on your server, it still has a
`slack_bot_token` secret that nothing reads now. Connect says so; delete it in
Voiceflow (More → Secrets).

## Trying it against real Slack

`scripts/live/slack.mjs` runs this package against a real Slack app and agent,
through the same connect code. See its header.

## License

MIT, in [LICENSE](LICENSE). `assets/voiceflow-icon.png` is Voiceflow's logo,
which connect sets as the icon of an agent's Slack app when the agent has no
avatar. The Voiceflow name and logo are trademarks of Voiceflow, Inc. and are
not licensed under MIT.
