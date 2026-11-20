# Voiceflow Channels

Connect Voiceflow agents to Slack, WhatsApp, Teams, email and more, through
[Vercel Chat SDK](https://chat-sdk.dev) adapters.

> **Status:** pre-release, local only. Not published; package names are not final.
> Slack passes its contract tests, its native features and tools included. See
> [docs/upstream.md](docs/upstream.md).

## Packages

| Package | What it is |
|---|---|
| [`@voiceflow/channels-sdk`](packages/core) | The core: a Voiceflow agent on any adapter in the catalog, the extension API, and the tool installer. |
| [`@voiceflow/channels-slack`](packages/slack) | Slack at full fidelity: its native behaviours, its tools, and `connect slack`. |

Each channel package carries that channel's default tool install. Connecting a
channel puts its tools on the agent; after that they're yours to edit, detach or
delete in Voiceflow, and later installs leave your changes alone.

```bash
npx voiceflow-channels connect slack --project <id> --environment development --public-url https://<your server>
```

## What it is, and what it isn't

**Channels SDK connects Voiceflow agents to third-party platforms, where Voiceflow
doesn't own the screen.** The web widget, SMS and phone are native Voiceflow channels
and are not part of this package.

| Do we own the screen? | Use |
|---|---|
| Yes: web widget, mobile app | `@voiceflow/interface-core` / `@voiceflow/interface-react` |
| Yes: SMS, phone | Voiceflow's native channels |
| No: Slack, WhatsApp, Teams, email, … | **`@voiceflow/channels-sdk`** |

## Design rules

1. **The Chat SDK owns platforms, and we own Voiceflow.** This package contains no
   platform code. Webhooks, signatures and posting belong to `@chat-adapter/*`.
2. **The adapter catalog drives everything.** Supported platforms, what each one can
   render, and the credentials it needs all come from `@chat-adapter/catalog`. A new
   upstream adapter works with no change here.
3. **It ships no interface of its own.**
4. **Upstream first.** No forks, no patches, no private fields. A missing capability
   becomes an issue or a PR on `vercel/chat`.

## Usage

Install the SDK, Chat SDK, the adapters you use and a state adapter:

```bash
npm install @voiceflow/channels-sdk chat @chat-adapter/catalog @chat-adapter/slack @chat-adapter/state-redis
```

Create the bot once, and route each platform's webhook to it. A Next.js route:

```ts
// app/api/webhooks/[channel]/route.ts
import { after } from 'next/server';
import { createChannels } from '@voiceflow/channels-sdk';
import { createRedisState } from '@chat-adapter/state-redis';

const channels = createChannels({
  voiceflow: {
    apiKey: process.env.VOICEFLOW_API_KEY!,
    projectID: process.env.VOICEFLOW_PROJECT_ID!,
  },
  // Each adapter reads its own env vars: Slack reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.
  channels: ['slack'],
  state: createRedisState(),
});

export async function POST(request: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  return (await channels).webhook(channel, request, { waitUntil: (task) => after(() => task) });
}
```

`'slack'` is the bare adapter. For Slack at full fidelity, use `slack()` from
[`@voiceflow/channels-slack`](packages/slack) instead.

To pass credentials yourself, or to bring an adapter you built, use the object form:
`{ slug: 'slack', options: { botToken, signingSecret } }` or `{ slug: 'slack', adapter }`.
The same `options` turn on an adapter's own features, such as Slack's
`feedbackButtons: true`.

## How a conversation works

- **One platform thread is one Voiceflow conversation.** The session key and the
  choices offered last turn live in the thread's Chat SDK state, so use a durable
  state adapter (Redis, Postgres) in production.
- **A mention or a direct message starts it.** Replies in that thread continue it. The
  bot's own @-mention is removed before the text reaches the agent.
- **Replies render to what the channel can show**, read from the catalog: native
  buttons and cards where it has them, a numbered list where it doesn't. A typed
  number or label picks a choice either way.
- **URL buttons open their link and still send their request**, as Voiceflow's web
  chat does, on channels that report link clicks. Without link buttons they become
  numbered markdown links.
- **Answers stream** where the catalog says streaming is fully supported (Slack):
  the agent's text is written into one live message as it's generated, with a
  progress card for each tool call. Buttons, cards and images close that message
  and post below it. Elsewhere, or with `streaming: false`, replies post whole.
- **Opening the assistant thread runs the agent's launch turn** (`launchOnOpen`,
  on by default). Its messages are posted, and up to four of its buttons are
  pinned as suggested prompts. Clicking one sends the button's own request.
- **Feedback buttons** are off by default. Turned on (Slack:
  `slack({ feedbackButtons: true })`), they reach `onFeedback`. A rating is not
  a turn: the agent doesn't answer it.
- **Only the latest turn's buttons are live**, as in Voiceflow's web chat. When the
  next turn starts, the last turn's buttons come off their messages: a card keeps
  its title, image and text; buttons alone keep their labels as plain text; a
  clicked (or typed) choice shows as "✓ label". On channels that can't edit a sent
  message (WhatsApp), old buttons stay. A click on one, or one that beats the edit,
  is refused as stale (`staleChoiceMessage`), never replayed.
- **A post the channel refuses goes as text instead**: a card whose image Slack
  can't download, say. The text keeps its choices, numbered as they were, and the
  rest of the turn still arrives. `onError` reports it as `post_refused`.
- **When the agent ends the conversation**, the next message starts a new one.
- **A failed turn posts an error message** (`errorMessage`, or `null` for none) and
  calls `onError`.

## Hosted version

The hosted version is **Voiceflow Channels**: the same SDK, run by Voiceflow,
with channel secrets kept in Voiceflow's secrets manager.
