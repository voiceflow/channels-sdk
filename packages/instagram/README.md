# @voiceflow/channelkit-instagram

A Voiceflow agent in Instagram, with one command to set it up.

> **Status:** pre-release, local only. Not published. The package name is not final.
> Built on Chat SDK's Instagram adapter.

## Connect

```bash
npx voiceflow-channelkit connect instagram --env-file .env.local
```

Instagram's side is made on Instagram's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the Instagram adapter](https://github.com/vercel/chat/tree/main/packages/adapter-instagram)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It makes `INSTAGRAM_VERIFY_TOKEN`**, a secret of your own that Instagram sends back with each message, and saves it to the env file.
- **It creates the `instagram_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give Instagram**: your server's public address, then `/api/instagram`. It goes in Meta's app dashboard, in the Instagram product's webhook settings, with INSTAGRAM_VERIFY_TOKEN as the verify token. `voiceflow-channelkit dev` prints the tunnel's each time it starts.
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
import { instagram } from '@voiceflow/channelkit-instagram';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [instagram()],
  state,
});
// One route takes everything: channels.webhook('instagram', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channelkit @voiceflow/channelkit-instagram chat @chat-adapter/catalog @chat-adapter/instagram
```

### What happens in Instagram

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as text, with their choices numbered.
- **Each reply is posted whole**, with Instagram's typing indicator while the agent works.
- **A long answer** goes as several messages, cut where the text breaks, at 333 characters.
- **Text goes as plain words.** Instagram shows Markdown as it is typed, so its marks are taken out: a list keeps its numbers, and a link its address.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `instagram({ follow: false })` has it answer only where it is mentioned.

### Settings

The adapter reads these from the environment. `instagram({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `INSTAGRAM_ACCESS_TOKEN` | Yes | Instagram access token for the Messaging API. |
| `INSTAGRAM_APP_SECRET` | Yes | Meta app secret for webhook signature verification. |
| `INSTAGRAM_VERIFY_TOKEN` | Yes | Webhook verification token. |
| `INSTAGRAM_ACCOUNT_ID` | Yes | Instagram professional account ID used to send messages. |
| `INSTAGRAM_VERIFY_TOKEN` | Yes: connect makes it | The token Meta sends back when it checks your server's address: any text of your own, entered as the webhook's verify token. |
| `INSTAGRAM_API_VERSION` | No | Meta Graph API version. Defaults to the adapter's supported version. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Instagram adapter's own config. |
| `context` | `true` | Set who and where as `instagram_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{instagram_user_name}`).

| Variable | What it holds |
|---|---|
| `instagram_user_id` | The Instagram ID of the person in this conversation. |
| `instagram_user_name` | The person's name in Instagram. Empty when Instagram doesn't say. |
| `instagram_thread_id` | The Instagram conversation this turn is in, as Chat SDK names it. |
| `instagram_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
