# @voiceflow/channels-twilio

A Voiceflow agent in Twilio, with one command to set it up.

> **Status:** pre-release, local only. Not published. The package name is not final.
> Built on Chat SDK's Twilio adapter.

## Connect

```bash
npx voiceflow-channels connect twilio --env-file .env.local
```

Twilio's side is made on Twilio's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the Twilio adapter](https://github.com/vercel/chat/tree/main/packages/adapter-twilio)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It creates the `twilio_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give Twilio**: your server's public address, then `/api/twilio`. It goes in Console → Phone Numbers → Active numbers → your number → A message comes in. `voiceflow-channels dev` prints the tunnel's each time it starts.
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
import { twilio } from '@voiceflow/channels-twilio';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [twilio()],
  state,
});
// One route takes everything: channels.webhook('twilio', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-twilio chat @chat-adapter/catalog @chat-adapter/twilio
```

### What happens in Twilio

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as text, with their choices numbered.
- **Each reply is posted whole**.
- **A long answer** goes as several messages, cut where the text breaks, at 1,500 characters.
- **Text goes as plain words.** Twilio shows Markdown as it is typed, so its marks are taken out: a list keeps its numbers, and a link its address.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `twilio({ follow: false })` has it answer only where it is mentioned.
- **A picture with no words** is not passed on: the adapter takes a message with an empty body for a delivery report.

### Settings

The adapter reads these from the environment. `twilio({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio Account SID. |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Auth Token. |
| `TWILIO_PHONE_NUMBER` | No | Default sender phone number for openDM. |
| `TWILIO_MESSAGING_SERVICE_SID` | No | Default Messaging Service SID for openDM. |
| `TWILIO_RCS_SENDER_ID` | No | Direct RCS sender address for openDM when targeting RCS. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The Twilio adapter's own config. |
| `context` | `true` | Set who and where as `twilio_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{twilio_user_name}`).

| Variable | What it holds |
|---|---|
| `twilio_user_id` | The Twilio ID of the person in this conversation. |
| `twilio_user_name` | The person's name in Twilio. Empty when Twilio doesn't say. |
| `twilio_thread_id` | The Twilio conversation this turn is in, as Chat SDK names it. |
| `twilio_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
