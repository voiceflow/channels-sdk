# @voiceflow/channels-whatsapp

A Voiceflow agent in WhatsApp Business Cloud, with one command to set it up.

> **Status:** an early release. Expect changes between versions before 1.0.
> Built on Chat SDK's WhatsApp Business Cloud adapter.

## Connect

```bash
npx voiceflow-channels connect whatsapp --env-file .env.local
```

WhatsApp Business Cloud's side is made on WhatsApp Business Cloud's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the WhatsApp Business Cloud adapter](https://github.com/vercel/chat/tree/main/packages/adapter-whatsapp)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It makes `WHATSAPP_VERIFY_TOKEN`**, a secret of your own that WhatsApp Business Cloud sends back with each message, and saves it to the env file.
- **It creates the `whatsapp_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give WhatsApp Business Cloud**: your server's public address, then `/api/whatsapp`. It goes in the Meta app's dashboard → WhatsApp → Configuration → Callback URL, with WHATSAPP_VERIFY_TOKEN as the Verify token, subscribed to messages. `voiceflow-channels dev` prints the tunnel's each time it starts.
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
import { whatsapp } from '@voiceflow/channels-whatsapp';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [whatsapp()],
  state,
});
// One route takes everything: channels.webhook('whatsapp', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-whatsapp chat @chat-adapter/catalog @chat-adapter/whatsapp
```

### What happens in WhatsApp Business Cloud

- **Choices** from the agent are buttons. A click sends the button's own request, as the person who clicked. WhatsApp Business Cloud shows 3 on a message: a longer list is numbered, and a person answers with the number, or the words.
- **Cards and carousels** are shown as text, with their choices numbered.
- **Each reply is posted whole**, with WhatsApp Business Cloud's typing indicator while the agent works.
- **A long answer** goes as several messages, cut where the text breaks, at 4,000 characters.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `whatsapp({ follow: false })` has it answer only where it is mentioned.
- **A button's label** longer than 20 characters is cut short by the adapter, with an ellipsis. The click still sends the whole choice.

### Settings

The adapter reads these from the environment. `whatsapp({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Yes | Meta access token. |
| `WHATSAPP_APP_SECRET` | Yes | App secret for webhook verification. |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | Bot phone number ID. |
| `WHATSAPP_VERIFY_TOKEN` | Yes | Webhook verification token. |
| `WHATSAPP_VERIFY_TOKEN` | Yes: connect makes it | The token Meta sends back when it checks your server's address: any text of your own, entered as the webhook's Verify token. |
| `WHATSAPP_BOT_USERNAME` | No | Bot display name. |
| `WHATSAPP_API_URL` | No | Override the WhatsApp Graph API URL. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The WhatsApp Business Cloud adapter's own config. |
| `context` | `true` | Set who and where as `whatsapp_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{whatsapp_user_name}`).

| Variable | What it holds |
|---|---|
| `whatsapp_user_id` | The WhatsApp Business Cloud ID of the person in this conversation. |
| `whatsapp_user_name` | The person's name in WhatsApp Business Cloud. Empty when WhatsApp Business Cloud doesn't say. |
| `whatsapp_thread_id` | The WhatsApp Business Cloud conversation this turn is in, as Chat SDK names it. |
| `whatsapp_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
