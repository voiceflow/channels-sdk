# @voiceflow/channels-notion

A Voiceflow agent in Notion, with one command to set it up.

> **Status:** pre-release, local only. Not published. The package name is not final.
> Built on Chat SDK's Notion adapter.

## Connect

```bash
npx voiceflow-channels connect notion --env-file .env.local
```

Notion's side is made on Notion's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the Notion adapter](https://github.com/vercel/chat/tree/main/packages/adapter-notion)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It creates the `notion_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give Notion**: your server's public address, then `/api/notion`. It goes in the Webhooks tab of the connection's own page in Notion → Create a subscription, with comment.created among its events. `voiceflow-channels dev` prints the tunnel's each time it starts.
- **With nobody at the terminal** (a script, a coding agent) connect asks
  nothing. It stops with exit code 3 and says, in the one stop, everything a
  person has to do. Exit 0 is done, 1 a failure, 2 a mistake in the command.
- **`voiceflow-channels dev` runs connect for you** the first time, when a
  person is there. So in an app the starter made, `npm run dev` is the one
  command.
- **Nothing is published.** The variables are live once you publish the
  environment. `--publish` does that here: the whole draft goes live.
- **`--dry-run`** shows the plan and changes nothing.

## In your server

```ts
import { notion } from '@voiceflow/channels-notion';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [notion()],
  state,
});
// One route takes everything: channels.webhook('notion', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-notion chat @chat-adapter/catalog @chat-adapter/notion
```

### What happens in Notion

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as cards, and one with choices as text, its choices numbered.
- **Each reply is posted whole**.
- **A long answer** goes as several messages, cut where the text breaks, at 1,900 characters.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `notion({ follow: false })` has it answer only where it is mentioned.
- **Notion locks a webhook's address once it is verified.** For another address (a tunnel's is new each time `dev` starts), delete the subscription and make it again.

### Settings

The adapter reads these from the environment. `notion({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `NOTION_TOKEN` | Yes | Connection access token (Bearer token). |
| `NOTION_VERIFICATION_TOKEN` | Yes, later | Webhook HMAC key from the subscription verification handshake. Notion sends it to your server as the webhook is saved, and the server's log shows it. Paste it into Notion to verify the subscription, set it here, and start the server again. |
| `NOTION_BOT_USERNAME` | Yes | The bot's name in Notion, as people write it after an @ in a comment. |
| `NOTION_MENTION_MODE` | No | Mention detection mode: "mention" | "all-comments" | "keyword" (default "mention" = plain-text @userName/@botUserId). |
| `NOTION_KEYWORDS` | No | Comma-separated keywords when NOTION_MENTION_MODE=keyword. |
| `NOTION_VERSION` | No | Override Notion-Version header (default 2026-03-11). |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Notion adapter's own config. |
| `context` | `true` | Set who and where as `notion_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{notion_user_name}`).

| Variable | What it holds |
|---|---|
| `notion_user_id` | The Notion ID of the person in this conversation. |
| `notion_user_name` | The person's name in Notion. Empty when Notion doesn't say. |
| `notion_thread_id` | The Notion conversation this turn is in, as Chat SDK names it. |
| `notion_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
