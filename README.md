# Voiceflow Channels SDK

[![CI](https://github.com/voiceflow/channels-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/voiceflow/channels-sdk/actions/workflows/ci.yml)
[![@voiceflow/channels-sdk](https://img.shields.io/npm/v/@voiceflow/channels-sdk?label=%40voiceflow%2Fchannels-sdk)](https://www.npmjs.com/package/@voiceflow/channels-sdk)
[![@voiceflow/channels-slack](https://img.shields.io/npm/v/@voiceflow/channels-slack?label=%40voiceflow%2Fchannels-slack)](https://www.npmjs.com/package/@voiceflow/channels-slack)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Put your Voiceflow agent in Slack, with everything Slack has: streamed answers,
the assistant panel, buttons, forms, tables and charts, and tools that act in
Slack for the person asking. One command makes the Slack app; one route runs
it. The same agent runs in Discord, Microsoft Teams, Telegram, WhatsApp and
[nine more channels](#channels), each with a package of its own and the same
commands. Built on [Vercel Chat SDK](https://chat-sdk.dev).

> **Status:** an early release. Expect changes between versions before 1.0.
> Every channel is tested end to end on one machine: Chat SDK's real adapter
> for it, against a stand-in for its platform.

## Quickstart

One command makes the app:

```bash
npm create @voiceflow/channels-sdk@latest my-bot
```

It writes a small Next.js server with the route Slack calls, an env file, and
a README with the steps from there: add your Voiceflow API key, run connect,
publish, and start the server. For another channel, name it:
`npm create @voiceflow/channels-sdk@latest my-bot -- --channel telegram`.

### Or add it to an app you have

Install the packages, Chat SDK and a state adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-slack chat @chat-adapter/catalog @chat-adapter/slack @chat-adapter/state-redis
```

Add the route Slack calls. In Next.js:

```ts
// app/api/slack/route.ts
import { after } from 'next/server';
import { createRedisState } from '@chat-adapter/state-redis';
import { createChannels, type Channels } from '@voiceflow/channels-sdk';
import { slack } from '@voiceflow/channels-slack';

let channels: Promise<Channels> | undefined;

export async function POST(request: Request) {
  channels ??= createChannels({
    voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
    channels: [slack()], // reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET
    state: createRedisState(),
  });
  return (await channels).webhook('slack', request, { waitUntil: (task) => after(() => task) });
}
```

Make the Slack app. Connect signs you in to Slack through the
[Slack CLI](https://tools.slack.dev/slack-cli), offering to install it when
you don't have it. It installs the app in your workspace, installs Slack's
tools on your agent, and writes the app's credentials to your env file. It
shows its plan and asks before it changes anything:

```bash
npx voiceflow-channels connect slack --env-file .env.local
```

It reads `VOICEFLOW_API_KEY`, `VOICEFLOW_PROJECT_ID` and `VOICEFLOW_ENVIRONMENT`
from that file, asks for the ones that aren't there, and saves them. Then it
asks whether to publish the environment, and the app's bot messages you in
Slack.

Start your server. Slack, and the agent's tools, have to reach it, so on your
own machine that takes a tunnel. Dev opens one, starts the server and points
both at it:

```bash
npx voiceflow-channels dev --env-file .env.local -- next dev
```

For a server that has an address of its own, give it to connect instead
(`--public-url https://<your server>`), and set `REDIS_URL` there.
[`examples/nextjs-slack`](examples/nextjs-slack) is the whole thing, ready to
run.

## Channels

Each channel is a package: `slack()`, `telegram()` and the rest go in
`createChannels`, and `voiceflow-channels connect <channel>` sets each one up.
A reply fits what the channel can show.

<!-- channels:start -->
| Channel | Package | Choices | Cards | Answers | Your server's address |
|---|---|---|---|---|---|
| Slack | [`@voiceflow/channels-slack`](packages/slack) | Buttons | Cards | Streamed | `connect` gives it |
| Discord | [`@voiceflow/channels-discord`](packages/discord) | Buttons | Cards | Posted whole | `connect` gives it |
| Microsoft Teams | [`@voiceflow/channels-teams`](packages/teams) | Buttons | Cards | Posted whole | `connect` gives it |
| Google Chat | [`@voiceflow/channels-gchat`](packages/gchat) | A numbered list | Cards | Posted whole | You enter it |
| GitHub | [`@voiceflow/channels-github`](packages/github) | A numbered list | Cards | Posted whole | You enter it |
| GitLab | [`@voiceflow/channels-gitlab`](packages/gitlab) | A numbered list | Cards | Posted whole | You enter it |
| Instagram | [`@voiceflow/channels-instagram`](packages/instagram) | A numbered list | Text | Posted whole | You enter it |
| Linear | [`@voiceflow/channels-linear`](packages/linear) | A numbered list | Cards | Posted whole | You enter it |
| Messenger | [`@voiceflow/channels-messenger`](packages/messenger) | A numbered list | Text | Posted whole | You enter it |
| Notion | [`@voiceflow/channels-notion`](packages/notion) | A numbered list | Cards | Posted whole | You enter it |
| Telegram | [`@voiceflow/channels-telegram`](packages/telegram) | A numbered list | Text | Posted whole | `connect` gives it |
| Twilio | [`@voiceflow/channels-twilio`](packages/twilio) | A numbered list | Text | Posted whole | You enter it |
| WhatsApp Business Cloud | [`@voiceflow/channels-whatsapp`](packages/whatsapp) | Buttons, up to 3 | Text | Posted whole | You enter it |
| X | [`@voiceflow/channels-x`](packages/x) | A numbered list | Text | Posted whole | You enter it |
<!-- channels:end -->

Each package's README has its settings, its options and its variables.

## Packages

| Package | What it is |
|---|---|
| [`@voiceflow/channels-sdk`](packages/core) | The core: a Voiceflow agent on any Chat SDK adapter, the extension API, the tool installer, and the `voiceflow-channels` CLI. |
| `@voiceflow/channels-<channel>` | A channel: its adapter, its variables, what only its platform has, and `connect <channel>`. One for each [channel above](#channels). |
| [`@voiceflow/create-channels-sdk`](packages/create) | The starter: `npm create @voiceflow/channels-sdk@latest` makes a new app, for any channel. |

## Features

- **Answers stream** into one live message as the agent writes them, with a
  progress card for each tool call.
- **Native Slack.** Buttons and cards, the assistant panel with the agent's
  launch buttons as suggested prompts, forms in Slack dialogs, tables and
  charts, reactions, `/ask`, the App Home tab and feedback buttons.
  `slack({ … })` turns each of Slack's own behaviours on or off.
- **Tools for the agent.** Connect installs 14 tools: post in a channel,
  message someone, read a channel, find a person, schedule, pin, bookmark,
  write a canvas, send a file, reply privately, and more.
- **They act only for the person asking.** Who that is comes from Slack's
  verified event, never from the model, and a tool reads or posts only where
  that person can. Anything that leaves the conversation waits for their
  approval.
- **Your credentials stay on your server.** The tools that act in Slack run
  there, so the bot token never goes to Voiceflow.
- **No secret reaches your log.** What an adapter logs is cleaned first, for
  every channel: access tokens, the channel's own secrets, and the request a
  failed call carries.
- **Your own tools, the same way.** A server tool is a function in your app
  that the agent can call, with the conversation and the person it is for.
- **One command to set up.** Connect makes the Slack app from a manifest,
  installs it, and wires the tools to your agent. It publishes your agent
  only when you say so, and never prints a secret.
- **Your edits stay yours.** After connect, edit or delete the tools in
  Voiceflow; running it again only adds what's missing.
- **Any platform Chat SDK has.** Replies fit what each channel can show:
  native buttons where it has them, a numbered list where it doesn't.

## AI coding agents

- [AGENTS.md](AGENTS.md) gives coding agents this repository's commands,
  layout, architecture and rules. Claude Code reads it through
  [CLAUDE.md](CLAUDE.md).
- Voiceflow's documentation is available to agents as
  [llms.txt](https://www.voiceflow.com/docs/llms.txt), and as an MCP server at
  `https://www.voiceflow.com/docs/mcp`.

## Documentation

- [How it works](docs/how-it-works.md): how a conversation runs, using other
  Chat SDK adapters, and the design rules.
- [`@voiceflow/channels-slack`](packages/slack/README.md): `connect slack`, every
  Slack option, the tools, and the `slack_*` variables.
- [`@voiceflow/channels-discord`](packages/discord/README.md): `connect discord`,
  how Discord reaches your server, the options, and the `discord_*` variables.
- [`@voiceflow/channels-teams`](packages/teams/README.md): `connect teams`, what
  Microsoft has to allow, the options, and the `teams_*` variables.
- Every other channel's README, from the [table above](#channels): its
  settings, what happens in it, its options and its variables.
- [`@voiceflow/channels-sdk`](packages/core/README.md): the API, server tools,
  channel extensions, and installing tools.
- [Staying current with Chat SDK](docs/upstream.md).
- [Voiceflow's documentation](https://www.voiceflow.com/docs), for building the
  agent itself.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup,
tests, changesets and the rules. To ask for a new channel, open a
[channel request](https://github.com/voiceflow/channels-sdk/issues/new?template=channel_request.yml).

## Support

See [SUPPORT.md](.github/SUPPORT.md). Questions are welcome in the
[Voiceflow community](https://community.voiceflow.com).

## Security

Please don't open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).

## License

MIT, in [LICENSE](LICENSE). The license covers the code. The Voiceflow name and
logo, including the default bot icon in `packages/core/assets/`, are
trademarks of Voiceflow, Inc. and are not licensed under MIT.
