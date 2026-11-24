# @voiceflow/channelkit-x

A Voiceflow agent in X, with one command to set it up.

> **Status:** pre-release, local only. Not published. The package name is not final.
> Built on Chat SDK's X adapter.

## Connect

```bash
npx voiceflow-channelkit connect x --env-file .env.local
```

X's side is made on X's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the X adapter](https://github.com/vercel/chat/tree/main/packages/adapter-x)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It creates the `x_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give X**: your server's public address, then `/api/x`. It goes in in X's developer console, as a webhook subscribed to post.mention.create, dm.received and dm.sent. `voiceflow-channelkit dev` prints the tunnel's each time it starts.
- **With nobody at the terminal** (a script, a coding agent) connect asks
  nothing. It stops with exit code 3 and says, in the one stop, everything a
  person has to do. Exit 0 is done, 1 a failure, 2 a mistake in the command.
- **`voiceflow-channelkit dev` runs connect for you** the first time, when a
  person is there. So in an app the starter made, `npm run dev` is the one
  command.
- **Nothing is published.** The variables are live once you publish the
  environment. `--publish` does that here: the whole draft goes live.
- **`--dry-run`** shows the plan and changes nothing.

## In your server

```ts
import { x } from '@voiceflow/channelkit-x';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [x()],
  state,
});
// One route takes everything: channels.webhook('x', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channelkit @voiceflow/channelkit-x chat @chat-adapter/catalog @chat-adapter/x
```

### What happens in X

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as text, with their choices numbered.
- **Each reply is posted whole**.
- **A long answer** goes as several messages, cut where the text breaks, at 10,000 characters.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `x({ follow: false })` has it answer only where it is mentioned.
- **A reply to a public mention** is a post, and X takes 280 characters in one, as X counts them, on an account without Premium. The adapter sends a longer answer whole and X refuses it: keep the agent's public answers short, or have it answer in direct messages, which take 10,000.

### Settings

The adapter reads these from the environment. `x({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `X_CONSUMER_SECRET` | Yes | App API key secret used for webhook CRC and signature verification. |
| `X_USER_ACCESS_TOKEN` | One way to sign in (Static access token) | OAuth 2.0 user-context access token for outbound API calls. |
| `X_CLIENT_ID` | One way to sign in (Managed OAuth refresh) | OAuth 2.0 client ID. |
| `X_REFRESH_TOKEN` | One way to sign in (Managed OAuth refresh) | OAuth 2.0 refresh token (requires the offline.access scope). |
| `X_CLIENT_SECRET` | No | OAuth 2.0 client secret for confidential clients. |
| `X_ENCRYPTION_KEY` | No | AES-256-GCM key for encrypting stored OAuth tokens. |
| `X_USER_ID` | No | Bot account user ID. Fetched from /2/users/me when omitted. |
| `X_USERNAME` | No | Bot account handle used for mention detection. Fetched when omitted. |
| `X_API_BASE_URL` | No | Override the X API base URL. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The X adapter's own config. |
| `context` | `true` | Set who and where as `x_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{x_user_name}`).

| Variable | What it holds |
|---|---|
| `x_user_id` | The X ID of the person in this conversation. |
| `x_user_name` | The person's name in X. Empty when X doesn't say. |
| `x_thread_id` | The X conversation this turn is in, as Chat SDK names it. |
| `x_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
