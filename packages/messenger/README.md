# @voiceflow/channels-messenger

A Voiceflow agent in Messenger, with one command to set it up.

> **Status:** an early release. Expect changes between versions before 1.0.
> Built on Chat SDK's Messenger adapter.

## Connect

```bash
npx voiceflow-channels connect messenger --dotenv .env.local
```

Messenger's side is made on Messenger's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the Messenger adapter](https://github.com/vercel/chat/tree/main/packages/adapter-messenger)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It makes `FACEBOOK_VERIFY_TOKEN`**, a secret of your own that Messenger sends back with each message, and saves it to the env file.
- **It creates the `messenger_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give Messenger**: your server's public address, then `/api/messenger`. It goes in the Meta app's dashboard → Messenger API Settings → Configure webhooks → Callback URL, with FACEBOOK_VERIFY_TOKEN as the Verify Token. `voiceflow-channels dev` prints the tunnel's each time it starts.
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
import { messenger } from '@voiceflow/channels-messenger';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [messenger()],
  state,
});
// One route takes everything: channels.webhook('messenger', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-messenger chat @chat-adapter/catalog @chat-adapter/messenger
```

### What happens in Messenger

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as text, with their choices numbered.
- **Each reply is posted whole**, with Messenger's typing indicator while the agent works.
- **A long answer** goes as several messages, cut where the text breaks, at 2,000 characters.
- **Text goes as plain words.** Messenger shows Markdown as it is typed, so its marks are taken out: a list keeps its numbers, and a link its address.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `messenger({ follow: false })` has it answer only where it is mentioned.

### Settings

The adapter reads these from the environment. `messenger({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `FACEBOOK_APP_SECRET` | Yes | App secret for webhook signature verification. |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Yes | Page access token for the Send API. |
| `FACEBOOK_VERIFY_TOKEN` | Yes | Webhook verification token. |
| `FACEBOOK_VERIFY_TOKEN` | Yes: connect makes it | The token Meta sends back when it checks your server's address: any text of your own, entered as the webhook's Verify Token. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Messenger adapter's own config. |
| `context` | `true` | Set who and where as `messenger_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{messenger_user_name}`).

| Variable | What it holds |
|---|---|
| `messenger_user_id` | The Messenger ID of the person in this conversation. |
| `messenger_user_name` | The person's name in Messenger. Empty when Messenger doesn't say. |
| `messenger_thread_id` | The Messenger conversation this turn is in, as Chat SDK names it. |
| `messenger_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
