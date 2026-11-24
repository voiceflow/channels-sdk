# AGENTS.md

Guidance for coding agents working in this repository. People: start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

```bash
npm ci                 # install (npm workspaces; commit package-lock.json changes)
npm run build          # tsc, every package
npm run typecheck      # tsc --noEmit, every package
npm test               # builds, then node --test, every package
npm run lint           # Biome: lint, formatting, import order
npm run fix            # apply Biome's safe fixes and formatting
npm run validate       # lint + build + typecheck + test: run it before you're done
npm run channels       # write the channel packages that share one template (-- --check: fail if one was edited by hand)
npx changeset          # describe a change to a published package
```

Per package: `npm test -w @voiceflow/channelkit-slack` (or `-w @voiceflow/channelkit`).
One file: `npm run build -w @voiceflow/channelkit-slack && node --test packages/slack/test/slack.contract.test.mjs`.

Node 22.11 or later (`.nvmrc` says 24). CI runs build, typecheck and test on
Node 22 and 24, and again against the oldest Chat SDK the packages support,
and lints. Biome (`biome.jsonc`) leaves `packages/slack/src/tools/` unformatted:
a tool's code is its functions' text, so restyling it would change the tool.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | `@voiceflow/channelkit`: `createChannels`, the agent loop, rendering, the extension API, the tool installer, test fakes, the `voiceflow-channelkit` bin |
| `packages/core/src/agent.ts` | One Chat SDK thread is one Voiceflow conversation: the turn loop |
| `packages/core/src/catalog.ts`, `loader.ts` | Adapters loaded from `@chat-adapter/catalog`: slug, package, factory, features, env vars |
| `packages/core/src/render.ts`, `deliver.ts`, `translate.ts` | Voiceflow traces become Chat SDK posts, fitted to what the channel can show; streaming |
| `packages/core/src/extension.ts` | `ChannelExtension`: what a channel package can add |
| `packages/core/src/install.ts`, `tools.ts` | Puts a channel's tools (Voiceflow functions) on an agent, versioned |
| `packages/core/src/server-tools.ts`, `tool-server.ts`, `pass.ts` | Server tools: tools that run in the developer's app. The turn's signed pass, the endpoint that answers a tool's call, approvals |
| `packages/core/src/sandbox/` | `callServerTool`: the one Voiceflow function behind every server tool |
| `packages/core/src/testing.ts` | `fakeVoiceflow`, `fakeVoiceflowApi`, `runFunction` (runs a tool as Voiceflow's sandbox does) |
| `packages/slack` | `@voiceflow/channelkit-slack`: `slack()`, Slack's extension, its tools, `connect slack` |
| `packages/slack/src/tools/` | What goes on the agent: `presentation.ts` (functions that show native Slack UI) and the install set |
| `packages/slack/src/workspace.ts` | The workspace tools (act in Slack): server tools, run with the adapter's own client |
| `packages/core/src/channel.ts`, `connect.ts`, `contract.ts`, `plain.ts` | What every channel's package is built from: `channel()`, the `connect`/`point`/`disconnect` commands, the conversation contract every channel's tests run, and Markdown as plain words |
| `packages/core/src/log.ts` | What every adapter logs goes through `cleanLogger` first: no access token, no secret of the channel's, and no request an error carries reaches a log. `createChannels` gives it to every adapter it makes |
| `packages/<channel>` | A channel's package. Discord and Teams are written by hand like Slack; the rest are written by `scripts/channels.mjs` from one template, with what a platform needs beyond it in the package's `traits.json`, `src/platform.ts`, `src/connect/point.ts` and `test/stand-in.mjs` (never written by the script) |
| `scripts/channels.mjs` | Writes those packages and the README's table of channels. `--check` fails when one was edited by hand. Change the template, then run it |
| `packages/core/src/dev.ts`, `tunnel.ts` | `voiceflow-channelkit dev`: a tunnel, your server, and each channel pointed at it |
| `packages/slack/src/connect/` | `connect slack` and `point slack`: manifest, Slack CLI login, app creation, the Voiceflow install |
| `packages/slack/test/helpers/fake-slack.mjs` | A fake of Slack's Web API and events |
| `packages/slack/scripts/live/` | The live harness: real Slack, real Voiceflow (see below) |
| `packages/create` | `@voiceflow/create-channelkit`: the starter. Its templates are built from the example apps (`scripts/template.mjs`), so there is one copy of each app; a channel with no example of its own gets `examples/nextjs-telegram` with its name in |
| `examples/` | Apps that use the packages; workspaces named `example-*`, never published |
| `docs/` | How a conversation works; how this project tracks Vercel Chat SDK |

## Architecture

- **Chat SDK owns platforms; this project owns Voiceflow.** Webhooks, signature
  checks, posting and editing belong to `@chat-adapter/*`. Nothing here talks to
  a platform's API to deliver a reply.
- **The catalog drives the core.** Which adapters exist, what each can render
  (`features`), and which env vars it reads come from `@chat-adapter/catalog`.
  A new upstream adapter needs no change here.
- **The core knows no platform.** Anything only one platform has lives in that
  channel's package, as a `ChannelExtension`: context variables, input rewrites,
  `turnStarted`/`turnEnded`, custom trace handlers, the bot's own events,
  adapter defaults. Never add a platform check to `packages/core`.
- **A conversation's state is the thread's state.** The Voiceflow session key and
  the last turn's choices live in the Chat SDK state adapter, not in memory.
- **Tools are Voiceflow functions, sent as source text.** `functionSource(main,
  helpers)` serialises a TypeScript function and its helpers into one
  self-contained function. They run in Voiceflow's sandbox, not Node: no
  imports, no `Buffer`, no `URL`; `fetch` answers `.json` as a property.
  `runFunction` in tests enforces the same limits.
- **A tool that needs a credential or an identity is a server tool.** Its
  function on the agent (`callServerTool`, the same for every one) only sends
  the model's inputs to the developer's server with the turn's pass. The
  server (`tool-server.ts`) reads the thread and the person from the pass and
  runs the tool's `run`. No platform credential is ever a Voiceflow secret.

## Rules

- **Upstream first.** No forks, patches, monkey-patching or private fields of
  `chat` or `@chat-adapter/*`. A missing capability is an issue or pull request
  on [vercel/chat](https://github.com/vercel/chat); see `docs/upstream.md`.
- **Never print a secret.** No token, signing secret or API key in output,
  progress lines, plans, errors, logs, saved files or test snapshots. Tests
  assert this; extend them when you add output. A command prints only through
  its redactor (`createRedactor` in `packages/core/src/redact.ts`), and an
  error built from a server's words is cleaned with `redact` before it is cut.
  The same holds for what an adapter logs on a server: it goes through the
  core's `cleanLogger`, and the shared tests fail if a credential a stand-in
  was given turns up in any line.
- **The person comes from the verified event, never from the model.** A tool
  that acts for someone is a server tool: it reads them from `turn.userId`,
  which the server took from the turn's pass, and acts only where that person
  could. Never from an input, and never from a variable.
- **What leaves the conversation asks first.** A server tool that writes
  outside the thread it was called from returns `askFirst(…)` until
  `turn.approved`, after its own checks, so nobody is asked to approve what
  would be refused.
- **A tool's code changes only with a higher version.** `slack.versions.test.mjs`
  fails when a tool's code changes and its `version` doesn't: raise the
  `version` and record the hash the failure prints in
  `packages/slack/test/tool-versions.json`.
- **Installs never take away.** Re-running connect or `installTools` only adds
  what's missing or upgrades a tool whose version rose; a person's edits on the
  agent stay. An install never publishes a Voiceflow environment; `connect`
  does only on a person's yes or `--publish`, after showing what the draft holds.
- **Every channel is said the same way.** One package per channel, the same
  commands, the same README shape, the same row in the README's table. What a
  platform lacks or needs is said as a fact about that platform, in its own
  package: never as a kind or a level of channel.
- **A test that can't fail isn't one.** Break the code once and watch the new
  test go red before relying on it.
- **Add a changeset** for any change a package's users would notice
  (`npx changeset`). Both packages share one version.

## Testing

- `node --test` over `test/*.test.mjs`, against the built `dist/`. No network,
  no accounts: Voiceflow and Slack are fakes (`@voiceflow/channelkit/testing`,
  `packages/slack/test/helpers/fake-slack.mjs`).
- Contract tests (`*.contract.test.mjs`) pin behaviour a channel promises;
  behaviour tests cover the turn loop end to end through the fakes.
- A channel's package written from the template runs the conversation every
  channel has to carry (`channelContract`): Chat SDK's real adapter against a
  stand-in for the platform (`test/stand-in.mjs`). Slack's, Discord's and
  Teams' contract tests are their own, of the same shape. A stand-in is written from the adapter's source and
  the platform's documentation. Never loosen one to make a test pass: a test
  that fails there is a fact about the platform or a bug in the adapter.
- **Live checks** (`packages/slack/scripts/live/slack.mjs`, `drive.mjs`) run
  against a real Slack workspace and Voiceflow agent. They need the Slack CLI,
  a Voiceflow API key file and a public URL. Only a person runs them; don't
  start them unasked. Their headers explain the flags.

## Code style

- TypeScript, strict, ESM (`NodeNext`): relative imports end in `.js`;
  `import type` for types (`verbatimModuleSyntax`).
- A module opens with a comment saying what it is for and the decisions behind
  it (index and type-only files excepted). Keep it true when you change the file.
- Errors a caller can act on are `ChannelsError` with a code
  (`packages/core/src/errors.ts`).
- Prose (docs, comments, messages) is plain and short: say what happens, in
  the active voice.
