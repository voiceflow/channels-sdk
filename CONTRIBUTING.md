# Contributing

## Setup

Node 22.11 or later (`.nvmrc` says 24; `nvm use`).

```bash
npm ci
npm run validate   # lint, build, typecheck and test, as CI does
npm run fix        # apply the formatter and the linter's safe fixes
```

The tests run against fakes of Slack's and Voiceflow's APIs: they need no
accounts, secrets or network. CI runs the same steps on Node 22 and 24 for
every pull request, and again against the oldest Chat SDK version the
packages support.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | `@voiceflow/channels-sdk`: the agent on any Chat SDK adapter, the extension API, the tool installer |
| `packages/slack` | `@voiceflow/channels-slack`: Slack's native features, its tools, and `connect slack` |
| `packages/create` | `create-voiceflow-channels`: the starter, `npm create voiceflow-channels` |
| `examples/` | Apps that use the packages, such as a Next.js Slack bot. The starter writes this app |
| `docs/` | How a conversation works, and how this project tracks Vercel Chat SDK |
| `.changeset/` | Pending changesets and the release configuration |

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
  `packages/slack/test/tool-versions.json`. For the same reason, the formatter
  leaves `packages/slack/src/tools/` and `packages/core/src/sandbox/` as they
  are. A server tool's code on the agent is the same for every tool, so its
  `version` rises when its name, description, inputs or outputs change; what
  its `run` does ships with the package and needs no new version.
- **A tool that acts for someone runs on the server.** It takes the person and
  the conversation from the turn (`turn.userId`, `turn.thread`), never from an
  input, and asks first (`askFirst`) before it writes outside the conversation.
- **Secrets are never printed.** Tests check plans, progress lines, errors and
  saved records for token values. Keep it that way in anything new: a command
  prints through its redactor (`createRedactor`), told of each secret as soon
  as it exists, and text from a server is cleaned (`redact`) before it is cut.
- **A change comes with a test**, and a test that can't fail isn't one: break
  the code once and watch the test go red before you rely on it.

## Changesets

A pull request that changes what a package does, or what it ships, adds a
changeset: a small Markdown file naming the packages, the kind of bump, and a
line for the changelog.

```bash
npx changeset
```

- **When:** a change to a package's `src`, `assets` or `package.json`: a fix, a
  feature, a changed default, a new tool version. Tests, CI, docs and the
  examples need none. CI's `changeset` check says when one is missing.
- **Which bump:** `patch` for a fix, `minor` for something new, `major` for a
  change that breaks existing code. Before 1.0, a breaking change is `minor`.
- **The example is the starter's app.** `create-voiceflow-channels` writes
  `examples/nextjs-slack`, so a change there changes what the starter makes:
  add a changeset for `create-voiceflow-channels`. The check can't tell, since
  examples need no changeset of their own.
- **One version:** `@voiceflow/channels-sdk`, `@voiceflow/channels-slack` and
  `create-voiceflow-channels` share a version number, so a changeset for one
  moves all three. The starter writes that version into the apps it makes.
- **Releasing:** when changesets reach `main`, the `release` workflow opens a
  "chore(release): version packages" pull request with the new versions and
  changelogs. Merging it publishes to npm with provenance, through npm's trusted
  publishing: no npm token is stored in this repository.

## Trying it against real Slack

`packages/slack/scripts/live/slack.mjs` runs the packages against a real Slack
app and Voiceflow agent, and `packages/slack/scripts/live/drive.mjs` drives a test
conversation through it. You need a Slack workspace where you can create apps,
the [Slack CLI](https://tools.slack.dev/slack-cli) logged in to it, a Voiceflow
project and API key, and a public URL for your machine (a tunnel). The
script's header has the details. It makes a temporary app; `--delete` removes it.

## Security

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
