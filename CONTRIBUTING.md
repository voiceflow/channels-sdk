# Contributing

## Setup

Node 20 or later.

```bash
npm ci
npm run build
npm test
npm run typecheck
```

The tests run against fakes of Slack's and Voiceflow's APIs: they need no
accounts, secrets or network. CI runs the same steps on Node 20, 22 and 24 for
every pull request.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | `@voiceflow/channels-sdk`: the agent on any Chat SDK adapter, the extension API, the tool installer |
| `packages/slack` | `@voiceflow/channels-slack`: Slack's native features, its tools, and `connect slack` |
| `docs/upstream.md` | How this project tracks Vercel Chat SDK |

## Rules

- **The Chat SDK owns platforms.** Webhooks, signatures and posting belong to
  `@chat-adapter/*`, not to this repository. When an adapter is missing
  something, open an issue or a pull request on
  [vercel/chat](https://github.com/vercel/chat). No forks, patches or private
  fields.
- **A tool's code changes only with a higher version.** An install updates a
  tool on an agent only when its version rises, so `slack.versions.test.mjs`
  fails when a tool's code changes and its version doesn't. Raise the tool's
  `version` and add the new hash the failure prints to
  `packages/slack/test/tool-versions.json`.
- **Secrets are never printed.** Tests check plans, progress lines and saved
  records for token values. Keep it that way in anything new.
- **A change comes with a test**, and a test that can't fail isn't one: break
  the code once and watch the test go red before you rely on it.

## Trying it against real Slack

`packages/slack/scripts/live/slack.mjs` runs the packages against a real Slack
app and Voiceflow agent, and `packages/slack/scripts/live/drive.mjs` drives a test
conversation through it. You need a Slack workspace where you can create apps,
the [Slack CLI](https://tools.slack.dev/slack-cli) logged in to it, a Voiceflow
project and API key, and a public URL for your machine (a tunnel). The
script's header has the details. It makes a temporary app; `--delete` removes it.

## Security

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
