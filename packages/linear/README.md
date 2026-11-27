# @voiceflow/channels-linear

A Voiceflow agent in Linear, with one command to set it up.

> **Status:** an early release. Expect changes between versions before 1.0.
> Built on Chat SDK's Linear adapter.

## Connect

```bash
npx voiceflow-channels connect linear --dotenv .env.local
```

Linear's side is made on Linear's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the Linear adapter](https://github.com/vercel/chat/tree/main/packages/adapter-linear)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It creates the `linear_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give Linear**: your server's public address, then `/api/linear`. It goes in Linear's Settings → API → Create webhook, with Comments among its events; its signing secret is LINEAR_WEBHOOK_SECRET. `voiceflow-channels dev` prints the tunnel's each time it starts.
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
import { linear } from '@voiceflow/channels-linear';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [linear()],
  state,
});
// One route takes everything: channels.webhook('linear', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-linear chat @chat-adapter/catalog @chat-adapter/linear
```

### What happens in Linear

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as cards, and one with choices as text, its choices numbered.
- **Each reply is posted whole**.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `linear({ follow: false })` has it answer only where it is mentioned.

### Settings

The adapter reads these from the environment. `linear({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `LINEAR_WEBHOOK_SECRET` | Yes | Webhook signing secret. |
| `LINEAR_BOT_USERNAME` | Yes | The bot's name in Linear, as people @mention it. |
| `LINEAR_API_KEY` | One way to sign in (Personal API key) | Personal API key. |
| `LINEAR_ACCESS_TOKEN` | One way to sign in (Access token) | Pre-obtained OAuth access token. |
| `LINEAR_CLIENT_CREDENTIALS_CLIENT_ID` | One way to sign in (Client credentials) | Client credentials OAuth client ID. |
| `LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET` | One way to sign in (Client credentials) | Client credentials OAuth client secret. |
| `LINEAR_CLIENT_ID` | One way to sign in (OAuth app) | OAuth client ID. |
| `LINEAR_CLIENT_SECRET` | One way to sign in (OAuth app) | OAuth client secret. |
| `LINEAR_CLIENT_CREDENTIALS_SCOPES` | No | Space-delimited scopes for client-credentials auth. |
| `LINEAR_ENCRYPTION_KEY` | No | AES-256-GCM key for encrypting stored OAuth tokens. |
| `LINEAR_API_URL` | No | Override the Linear API URL. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Linear adapter's own config. |
| `context` | `true` | Set who and where as `linear_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{linear_user_name}`).

| Variable | What it holds |
|---|---|
| `linear_user_id` | The Linear ID of the person in this conversation. |
| `linear_user_name` | The person's name in Linear. Empty when Linear doesn't say. |
| `linear_thread_id` | The Linear conversation this turn is in, as Chat SDK names it. |
| `linear_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
