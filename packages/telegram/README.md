# @voiceflow/channels-telegram

A Voiceflow agent in Telegram, with one command to set it up.

> **Status:** an early release. Expect changes between versions before 1.0.
> Built on Chat SDK's Telegram adapter.

## Connect

```bash
npx voiceflow-channels connect telegram --env-file .env.local
```

Telegram's side is made on Telegram's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the Telegram adapter](https://github.com/vercel/chat/tree/main/packages/adapter-telegram)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It makes `TELEGRAM_WEBHOOK_SECRET_TOKEN`**, a secret of your own that Telegram sends back with each message, and saves it to the env file.
- **It creates the `telegram_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It gives Telegram your server's address**, when you pass one (`--public-url`). `voiceflow-channels dev` gives it the tunnel's each time it starts, and `disconnect` takes it back.
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
import { telegram } from '@voiceflow/channels-telegram';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [telegram()],
  state,
});
// One route takes everything: channels.webhook('telegram', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-telegram chat @chat-adapter/catalog @chat-adapter/telegram
```

### What happens in Telegram

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as text, with their choices numbered.
- **Each reply is posted whole**, with Telegram's typing indicator while the agent works.
- **A long answer** goes as several messages, cut where the text breaks, at 4,000 characters.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `telegram({ follow: false })` has it answer only where it is mentioned.

### Settings

The adapter reads these from the environment. `telegram({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Yes: connect makes it | The secret Telegram sends back with each message, which is how the server knows a message is Telegram's. |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Comma-separated Telegram user IDs allowed to trigger the adapter. |
| `TELEGRAM_ALLOW_UNVERIFIED_WEBHOOKS` | No | Set to true to accept unverified webhooks for local fixtures. |
| `TELEGRAM_BOT_USERNAME` | No | Bot username for mention detection. |
| `TELEGRAM_MENTION_ON_REPLY` | No | Set to "true" to treat a reply to the bot as a mention. |
| `TELEGRAM_API_BASE_URL` | No | Override the Telegram API base URL. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Telegram adapter's own config. |
| `context` | `true` | Set who and where as `telegram_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{telegram_user_name}`).

| Variable | What it holds |
|---|---|
| `telegram_user_id` | The Telegram ID of the person in this conversation. |
| `telegram_user_name` | The person's name in Telegram. Empty when Telegram doesn't say. |
| `telegram_thread_id` | The Telegram conversation this turn is in, as Chat SDK names it. |
| `telegram_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
