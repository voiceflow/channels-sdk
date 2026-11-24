# How it works

What Voiceflow ChannelKit is for, how a conversation runs through it, and the
rules its design follows. For a package's API and options, see its README:
[`@voiceflow/channelkit`](../packages/core/README.md),
[`@voiceflow/channelkit-slack`](../packages/slack/README.md).

## What it is, and what it isn't

**ChannelKit connects Voiceflow agents to third-party platforms, where Voiceflow
doesn't own the screen.** The web widget, SMS and phone are native Voiceflow channels
and are not part of this package.

| Do we own the screen? | Use |
|---|---|
| Yes: web widget, SMS, phone | Voiceflow's native channels |
| No: Slack, WhatsApp, Teams, email, … | **`@voiceflow/channelkit`** |

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

## How a tool call works

Some tools need a credential, or need to know who is asking: posting in a
Slack channel for someone, say. Those run on your server, and are called
server tools.

1. Each turn, your server makes a **pass**: the thread and the person, from the
   platform's verified event, signed with a key only your server holds. It sets
   the pass as a variable on the Voiceflow session.
2. The agent decides to call a tool. The tool's function in Voiceflow holds no
   logic and no credential: it sends the model's inputs and the pass to your
   server, at the same address the platform's webhook uses.
3. Your server checks the pass, looks the tool up among those it offers on
   that channel, and runs it for the conversation the pass names. A call
   without a pass it made, or with one whose turn has ended, does nothing.
4. A tool that reaches outside the conversation asks first. The server posts a
   request in the thread, and acts once the person who asked approves it.

The agent's own reply still streams while this happens: a tool's call is a
second request, answered in the middle of the turn. Presentation tools (a
table, a chart, a reaction) need none of this: they return a trace in the
turn's own stream, and your server shows it.

## Any Chat SDK adapter

A channel's package ([each one is in the README's table](../README.md#channels))
brings its adapter and what only its platform has. A platform in
[Chat SDK's catalog](https://chat-sdk.dev/adapters) with no package here, one
of the adapters its own vendor makes, say, loads through the core by its name
in the catalog, with the replies fitted to what the catalog says it can show.
None of those has been run here.

Install its adapter, and name it in `channels`:

```bash
npm install @larksuite/vercel-chat-adapter
```

```ts
import * as larkAdapter from '@larksuite/vercel-chat-adapter';
import { createRedisState } from '@chat-adapter/state-redis';
import { createChannels } from '@voiceflow/channelkit';
import { slack } from '@voiceflow/channelkit-slack';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  // Each adapter reads its own env vars, as the catalog lists them.
  channels: [slack(), { slug: 'lark', module: larkAdapter }],
  state: createRedisState(),
});
```

- **`module`** is the adapter's package, imported. A bundled server (Next.js,
  say) needs it: a bundler can't follow an import of a name it only learns at
  run time. On a server that isn't bundled, `'lark'` alone is enough, and
  the package is imported by the name the catalog gives.
- **`options`** passes the adapter's own config instead of its env vars:
  `{ slug: 'lark', module: larkAdapter, options: { … } }`. The same
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
