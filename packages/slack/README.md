# @voiceflow/channels-slack

A Voiceflow agent in Slack at full fidelity: everything Slack has is on by
default, and Slack's tools are installed on the agent when you connect it.

> **Status:** pre-release, local only. Not published. The package name is not final.

## Connect

One command makes the Slack app, installs it, and installs Slack's tools on
your agent:

```bash
npx voiceflow-channels connect slack \
  --project <voiceflow project id> --environment development \
  --public-url https://<your server> --env-file .env
```

It shows its whole plan and asks before it changes anything:

```
Slack: workspace Acme (T0123)
  + create app "Voiceflow agent" from the manifest: 21 bot scopes, 10 events, the assistant panel, the Home tab, /ask
    requests go to https://<your server>/api/slack (Slack checks it answers while it creates the app)
  + install it in Acme (its bot token stays in memory and goes to Voiceflow as the slack_bot_token secret)
Voiceflow: project "Support" (64f…) in workspace a1B2c3, environment development (nothing is published)
  + variable slack_user_id
  …
  + secret slack_bot_token (new, restricted; value: the app's bot token)
  + tool slack_react: create and attach
  …
  ~ compile the environment (nothing is published)
```

- **Slack login:** the [Slack CLI](https://tools.slack.dev/slack-cli)'s
  (`slack login`). Pick a workspace with `--team` when it's logged in to several.
- **Voiceflow key:** `VOICEFLOW_API_KEY`, `--key-file`, or a hidden prompt.
  Never a command-line value.
- **The app's credentials** go only to the file you name with `--env-file`
  (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`), written readable by you alone.
  Without one, connect tells you where Slack shows them. Slack gives out a new
  app's signing secret once, when connect makes the app.
- **Slack checks the request URL** while it makes the app. Point your tunnel at
  `--port` (default 3000) while connect runs, and connect answers the check
  itself. When your server already holds that port, it answers instead.
- **It never publishes.** The tools land on the environment's draft, compiled,
  so you can try them before you publish in Voiceflow.
- **`--workspace <id>`** stops connect, changing nothing in Slack or Voiceflow,
  unless the project is in that Voiceflow workspace.
- **Running it again only adds what's missing.** It reuses the app it made (kept
  in `.voiceflow/channels-slack-apps.json`, no secrets), and `--app <id>` adds
  what this package needs to an app you already have: scopes, events and
  features are only added, never taken away.
- `--dry-run` shows the plan and stops. `--yes` skips the question.
  `--no-tools` makes the app and installs no tools. `--no-workspace-tools`
  installs only the presentation tools. `--print-manifest` prints the app's
  manifest, to paste into api.slack.com ("Create New App", "From a manifest").
- `voiceflow-channels disconnect slack` deletes the app. The tools stay on the
  agent unless you add `--remove-tools`.

The same steps are a function, for your own scripts:
`connectSlack()` and `disconnectSlack()` from `@voiceflow/channels-slack/connect`.

## Run it

```ts
import { createChannels } from '@voiceflow/channels-sdk';
import { slack } from '@voiceflow/channels-slack';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: '64f…', environment: 'development' },
  channels: [slack()], // reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET
  state: createRedisState(),
});
```

Route `POST /api/slack` to `channels.webhook('slack', request)`. Events, button
clicks, dialogs and the slash command all arrive there.

## What it does in Slack

Each is on by default; `slack({ … })` turns any of them off.

| Behaviour | Option |
|---|---|
| 👀 on the person's message while the agent works, taken off when it's done | `workingReaction` |
| A reaction left when the reply is done | `doneReaction` (default none) |
| Mentioned partway through a thread, the agent reads the earlier messages first | `catchUp` (20) |
| The assistant panel: the launch turn runs when it opens, its buttons become suggested prompts | `launchOnOpen` |
| The panel's thread is named after the person's first message | `titles` |
| Who and where, as `slack_*` variables on every turn | `context` |
| 👍 / 👎 reactions on the agent's messages reach `onFeedback` (so do Slack's feedback buttons) | `feedbackReactions` |
| `/ask <question>` posts the question in the channel and answers in its thread | `slashCommands` |
| The App Home tab | `home` |

The `slack_*` variables: `slack_user_id`, `slack_user_name`, `slack_user_title`,
`slack_user_timezone`, `slack_user_email`, `slack_team_id`, `slack_channel_id`,
`slack_channel_name`, `slack_channel_type`, `slack_thread_ts`,
`slack_message_ts`, `slack_viewing_channel_id`.

## Slack's tools

Connect installs these on the agent, as Voiceflow functions attached as tools.
Presentation tools return a trace this package shows natively; workspace tools
call Slack from Voiceflow with the `slack_bot_token` secret.

| Tool | Kind | Scopes | What it does |
|---|---|---|---|
| `slack_react` | presentation | reactions:write | Add an emoji reaction to the person's latest message. |
| `slack_show_table` | presentation | — | Show data as a native Slack table. |
| `slack_show_chart` | presentation | — | Show numbers as a native Slack chart (bar, line, area or pie). |
| `slack_reply_privately` | presentation | — | Send the person a message only they can see. |
| `slack_ask_form` | presentation | — | A button that opens a Slack dialog; the answers come back as the person's next message. |
| `slack_post_to_channel` | workspace | chat:write, channels:read, groups:read | Post in a channel for the person. |
| `slack_message_person` | workspace | chat:write, im:write, users:read, users:read.email | Send someone a direct message for the person. |
| `slack_read_channel` | workspace | channels:history, groups:history, channels:read, groups:read, users:read | Read a channel's recent messages. |
| `slack_find_person` | workspace | users:read, users:read.email | Look people up by name, title or email. |
| `slack_schedule_message` | workspace | chat:write, channels:read, groups:read | Schedule a message for later. |
| `slack_pin_message` | workspace | pins:write, channels:read, groups:read | Pin a message. |
| `slack_add_bookmark` | workspace | bookmarks:write, channels:read, groups:read | Add a link to a channel's bookmarks bar. |
| `slack_create_canvas` | workspace | canvases:write | Write a Slack canvas, shared with the person. |
| `slack_send_file` | workspace | files:write | Send a text file in the conversation. |

### Who a tool acts for

The bot can reach more than the person talking to it, so the workspace tools
act only within what that person can see:

- **Identity comes from Slack, never the model.** The person, channel and thread
  are wired from the `slack_*` variables this package sets from the verified
  event, so the agent can't fill them in.
- **Only where the person is.** A tool that reads or posts in a channel checks
  the person is a member of it first (the conversation they're in always
  passes), and refuses otherwise.
- **Posts say who asked.** A post or message made for someone carries a line
  saying so ("Posted for @ada").
- **Times are the person's.** A time without an offset is read in their time
  zone.

### After connect, the tools are yours

Edit, detach or delete them in Voiceflow. A later connect (or `installTools`)
leaves your changes alone: a function you edited is never overwritten, and a
tool you deleted or detached is never added again unless you name it with
`--restore`. An unedited tool is updated when this package ships a new version.
What was installed is kept in `.voiceflow/channels-install.json`: commit it with
your server's code.

To install the tools without connect:

```ts
import { installTools } from '@voiceflow/channels-sdk/install';
import { slackTools } from '@voiceflow/channels-slack';

await installTools(slackTools(), {
  apiKey, projectID, environment: 'development',
  secretValues: { slack_bot_token: process.env.SLACK_BOT_TOKEN! },
});
```

## Trying it against real Slack

`scripts/live/slack.mjs` runs this package against a real Slack app and agent,
through the same connect code. See its header.
