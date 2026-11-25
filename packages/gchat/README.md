# @voiceflow/channels-gchat

A Voiceflow agent in Google Chat, with one command to set it up.

> **Status:** pre-release, local only. Not published. The package name is not final.
> Built on Chat SDK's Google Chat adapter.

## Connect

```bash
npx voiceflow-channels connect gchat --env-file .env.local
```

Google Chat's side is made on Google Chat's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the Google Chat adapter](https://github.com/vercel/chat/tree/main/packages/adapter-gchat)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It creates the `gchat_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give Google Chat**: your server's public address, then `/api/gchat`. It goes in the Google Cloud console → Google Chat API → Configuration → Connection settings → App URL, with Authentication audience set to Project number. `voiceflow-channels dev` prints the tunnel's each time it starts.
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
import { gchat } from '@voiceflow/channels-gchat';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [gchat()],
  state,
});
// One route takes everything: channels.webhook('gchat', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-gchat chat @chat-adapter/catalog @chat-adapter/gchat
```

### What happens in Google Chat

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as cards, and one with choices as text, its choices numbered.
- **Each reply is posted whole**.
- **A long answer** goes as several messages, cut where the text breaks, at 4,000 characters.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `gchat({ follow: false })` has it answer only where it is mentioned.
- **In a space**, set `GOOGLE_CHAT_BOT_USER_ID` (the `users/…` name of your Chat app) so the bot knows a mention of itself. In a direct message it answers every message without it.

### Settings

The adapter reads these from the environment. `gchat({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `GOOGLE_CHAT_PROJECT_NUMBER` | Yes | Your Google Cloud project's number: requests from Google Chat are signed for it. |
| `GOOGLE_CHAT_CREDENTIALS` | One way to sign in (Service account credentials) | Service account credentials JSON or path. |
| `GOOGLE_CHAT_USE_ADC` | One way to sign in (Application Default Credentials) | Set to true to use Application Default Credentials. |
| `GOOGLE_CHAT_BOT_USER_ID` | No | Canonical users/... resource name of this Chat app. |
| `GOOGLE_CHAT_PUBSUB_TOPIC` | No | Pub/Sub topic for Workspace Events. |
| `GOOGLE_CHAT_IMPERSONATE_USER` | No | User email for domain-wide delegation. |
| `GOOGLE_CHAT_PUBSUB_AUDIENCE` | No | Audience used for Workspace Events push verification. |
| `GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT_EMAIL` | No | Service account your Pub/Sub push subscription authenticates as. Required to accept Pub/Sub pushes. |
| `GOOGLE_CHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL` | No | Your Workspace Add-on service account identity. Required to accept add-on webhooks. |
| `GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION` | No | Set to true to disable signature verification for local fixtures. |
| `GOOGLE_CHAT_API_URL` | No | Override the Google Chat API URL. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Google Chat adapter's own config. |
| `context` | `true` | Set who and where as `gchat_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{gchat_user_name}`).

| Variable | What it holds |
|---|---|
| `gchat_user_id` | The Google Chat ID of the person in this conversation. |
| `gchat_user_name` | The person's name in Google Chat. Empty when Google Chat doesn't say. |
| `gchat_thread_id` | The Google Chat conversation this turn is in, as Chat SDK names it. |
| `gchat_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
