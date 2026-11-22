# Voiceflow Channels

[![CI](https://github.com/voiceflow/channels-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/voiceflow/channels-sdk/actions/workflows/ci.yml)
[![@voiceflow/channels-sdk](https://img.shields.io/npm/v/@voiceflow/channels-sdk?label=%40voiceflow%2Fchannels-sdk)](https://www.npmjs.com/package/@voiceflow/channels-sdk)
[![@voiceflow/channels-slack](https://img.shields.io/npm/v/@voiceflow/channels-slack?label=%40voiceflow%2Fchannels-slack)](https://www.npmjs.com/package/@voiceflow/channels-slack)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Put your Voiceflow agent in Slack, with everything Slack has: streamed answers,
the assistant panel, buttons, forms, tables and charts, and tools that act in
Slack for the person asking. One command makes the Slack app; one route runs
it. Built on [Vercel Chat SDK](https://chat-sdk.dev), so the same agent reaches
any platform it has an adapter for.

> **Status:** pre-release, local only. Not published; package names are not final.
> Slack is supported and tested end to end, in Slack itself as well as in the
> tests. Other adapters load through the same catalog, but none has been tried
> live yet.

## Quickstart

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

Make the Slack app. You need the [Slack CLI](https://tools.slack.dev/slack-cli),
logged in to your workspace (`slack login`). Point a tunnel at port 3000 first: connect answers
Slack's check of the URL while it runs. It installs the app in your workspace,
installs Slack's tools on your agent, and writes the app's credentials to your
env file. It shows its plan and asks before it changes anything:

```bash
npx voiceflow-channels connect slack --project <project id> --environment production \
  --public-url https://<your tunnel> --env-file .env.local
```

Set `VOICEFLOW_API_KEY`, `VOICEFLOW_PROJECT_ID` and `REDIS_URL`, start your
server, publish the environment in Voiceflow, and mention the app in Slack.
[`examples/nextjs-slack`](examples/nextjs-slack) is the whole thing, ready to
run.

## Packages

| Package | What it is |
|---|---|
| [`@voiceflow/channels-sdk`](packages/core) | The core: a Voiceflow agent on any Chat SDK adapter, the extension API, the tool installer, and the `voiceflow-channels` CLI. |
| [`@voiceflow/channels-slack`](packages/slack) | Slack at full fidelity: its native features, its tools, and `connect slack`. |

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
- **Your own tools, the same way.** A server tool is a function in your app
  that the agent can call, with the conversation and the person it is for.
- **One command to set up.** Connect makes the Slack app from a manifest,
  installs it, and wires the tools to your agent. It never publishes your
  agent, and never prints a secret.
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
logo, including the default Slack app icon in `packages/slack/assets/`, are
trademarks of Voiceflow, Inc. and are not licensed under MIT.
