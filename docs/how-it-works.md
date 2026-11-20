# How it works

What Voiceflow Channels is for, how a conversation runs through it, and the
rules its design follows. For a package's API and options, see its README:
[`@voiceflow/channels-sdk`](../packages/core/README.md),
[`@voiceflow/channels-slack`](../packages/slack/README.md).

## What it is, and what it isn't

**Channels SDK connects Voiceflow agents to third-party platforms, where Voiceflow
doesn't own the screen.** The web widget, SMS and phone are native Voiceflow channels
and are not part of this package.

| Do we own the screen? | Use |
|---|---|
| Yes: web widget, SMS, phone | Voiceflow's native channels |
| No: Slack, WhatsApp, Teams, email, … | **`@voiceflow/channels-sdk`** |

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

## Any Chat SDK adapter

A channel package such as `@voiceflow/channels-slack` brings everything its
platform has. Any other platform in
[Chat SDK's catalog](https://chat-sdk.dev/adapters) loads through the core on
its own, with the replies fitted to what the platform can show. Only Slack has
been tried live so far.

Install its adapter, and name it in `channels`:

```bash
npm install @chat-adapter/whatsapp
```

```ts
import * as whatsappAdapter from '@chat-adapter/whatsapp';
import { createRedisState } from '@chat-adapter/state-redis';
import { createChannels } from '@voiceflow/channels-sdk';
import { slack } from '@voiceflow/channels-slack';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  // The adapter reads its own env vars, as the catalog lists them.
  channels: [slack(), { slug: 'whatsapp', module: whatsappAdapter }],
  state: createRedisState(),
});
```

- **`module`** is the adapter's package, imported. A bundled server (Next.js,
  say) needs it: a bundler can't follow an import of a name it only learns at
  run time. On a server that isn't bundled, `'whatsapp'` alone is enough, and
  the package is imported by the name the catalog gives.
- **`options`** passes the adapter's own config instead of its env vars:
  `{ slug: 'whatsapp', module: whatsappAdapter, options: { … } }`. The same
  `options` turn on an adapter's own features.
- **`adapter`** uses an adapter you built yourself, as it is.

Route each platform's webhook to `channels.webhook(slug, request)`. In
Next.js, one dynamic route serves them all;
[`examples/nextjs-slack`](../examples/nextjs-slack/app/api/slack/route.ts)
shows how to make the bot on the first request rather than at build time.

```ts
// app/api/webhooks/[channel]/route.ts
export async function POST(request: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  return (await bot()).webhook(channel, request, { waitUntil: (task) => after(() => task) });
}
```

## Design rules

1. **The Chat SDK owns platforms, and we own Voiceflow.** This package contains no
   platform code. Webhooks, signatures and posting belong to `@chat-adapter/*`.
2. **The adapter catalog drives everything.** Supported platforms, what each one can
   render, and the credentials it needs all come from `@chat-adapter/catalog`. A new
   upstream adapter works with no change here.
3. **It ships no interface of its own.**
4. **Upstream first.** No forks, no patches, no private fields. A missing capability
   becomes an issue or a PR on `vercel/chat`.
