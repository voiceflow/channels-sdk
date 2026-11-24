# Staying current with Vercel Chat SDK

How `@voiceflow/channels-sdk` uses Chat SDK adapters for every platform it can, and
stays compatible as upstream ships.

## Upstream facts (checked 2026-11-19, against 4.45.0)

- `chat` is MIT and lives in `vercel/chat`. All packages (`chat`, `@chat-adapter/*`)
  release together under the same version number.
- It's on major version 4, with a minor release every 1–2 weeks: 4.38.0 on 2026-08-14,
  4.45.0 on 2026-11-13, 62 releases in 4.x so far.
- Public exports: `chat`, `chat/ai`, `chat/workflow`, `chat/serialization`,
  `chat/jsx-runtime`. `chat/adapters` is deprecated: it re-exports `@chat-adapter/catalog`.
- **`@chat-adapter/catalog`** is the machine-readable catalog, released with `chat`
  (`chat` 4.44 and later depend on it at the same exact version). It exports `getAdapter`,
  `listPlatformAdapters`, `listStateAdapters`, `getFeatureSupport`, `listEnvVars` and
  `getSecretEnvVars`. 4.45.0 lists 32 platforms and 5 state adapters.
  Each platform entry carries:
  - `slug`, `name`, `group` (`official` / vendor), `packageName`, `factoryExport`, `peerDeps`;
  - `features`: post / edit / delete, streaming, `cardFormat`, buttons, select menus,
    tables, typing indicator, mentions, DMs, `customApiEndpoint`, …, each `yes`, `partial` or `no`;
  - `env`: every credential, with `key`, `description` and `secret: true|false`. Some entries
    group them as `credentialModes`, others as `required` / `optional`; `listEnvVars` reads both.
- **An adapter called with no options reads its own env vars**, the catalog's names
  (`createSlackAdapter()` reads `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`).

## 1. Adapters in three tiers

| Tier | What it takes | Example |
|---|---|---|
| **1: catalog-driven (the easy adapters)** | Nothing. Loaded and configured from the catalog alone | Most official adapters |
| 2: override hook | A small render or ID override, in this package, behind a documented hook | A platform whose thread IDs need mapping |
| 3: hosted connector | Hosted relay only: the setup handshake, reading the conversation ID before verification | Meta's `hub.challenge`, Slack's `url_verification` |

**How tier 1 works**

1. `createChannels({ channels: ['slack'] })` looks each slug up with `getAdapter`
   (`packages/core/src/catalog.ts`). An unknown slug, or a state adapter, is refused with a code.
2. `loadAdapter` dynamically imports `packageName` and calls `factoryExport`
   (`packages/core/src/loader.ts`). With no options the adapter reads its own env vars. A missing
   package is refused with the `npm install` line that fixes it.
3. Credential names come from `listEnvVars`. A platform's credentials stay in
   your server's environment: none is ever a Voiceflow secret.
4. Rendering reads `features` (`packages/core/src/render.ts`). Only a full `yes` counts; `partial`
   gets the fallback:
   - no `buttons`: a numbered list, and a typed number or label picks the choice;
   - no `linkButtons`: a group with a URL button goes as numbered markdown links;
   - no `cardFormat`: a card goes as markdown, its choices numbered;
   - no `imagesInCards`: the image goes as its URL;
   - `typingIndicator`: shown while the turn runs.
   An image goes as a card's own image (`Card({ imageUrl })`), the way a card with a picture
   does: Discord's adapter drops an image inside a card. And a channel's extension can say
   the longest text its platform shows (`maxTextLength`): a longer reply goes as several
   messages (`packages/core/src/split.ts`), counted as the adapter formats it.
5. `streaming` (`packages/core/src/deliver.ts`): a full `yes` streams the turn from
   `/v4/interact/stream` into one live message, `markdown_text` chunks for text and a
   `task_update` chunk per tool call. Anything else posts whole replies from
   `/v4/interact`. `partial` doesn't count because Chat SDK's fallback for an adapter
   without native streaming edits the message, and most of those channels can't edit.
6. Credentials pass through to the adapter as given. Where an adapter accepts a
   function (Slack's `botToken` does), the hosted version can lend a secret for one turn.

**Promotion rule:** an adapter counts as supported only once it passes the contract
tests (section 4). The catalog says what exists; our tests say what works.

## 2. Dependency model

- `chat`: `peerDependencies` `>=4.44.0 <5`. The customer's copy is the one used.
- `@chat-adapter/catalog`: a peer with the same range. It must be the copy `chat` uses,
  or our capabilities and upstream's would disagree.
- `@chat-adapter/*` adapters: **not dependencies at all.** Customers install the adapters
  they use, and the loader imports them by the catalog's package name. Dev dependencies
  pin every supported adapter for the contract tests.
- **Never** bundle, fork or `patch-package` upstream code.
- **Only public exports.** Lint bans:
  - deep imports (`chat/dist/...`, `@chat-adapter/*/dist/...`);
  - underscore-prefixed fields.

  An earlier prototype set `slack._botUserId`. This package uses Slack's public `botUserId`
  option instead.

## 3. Tracking upstream

Built: Dependabot opens one grouped pull request a month for `chat` and
`@chat-adapter/*` (`.github/dependabot.yml`).

Not built yet: the plan for before the public release.

| Mechanism | What it catches | Cadence |
|---|---|---|
| CI matrix: the oldest supported `chat` version + `latest` | Breaking the floor or the ceiling | Every PR |
| Nightly against `chat@latest` + every adapter's latest | Upstream breakage before customers see it | Daily; opens an issue on failure |
| Catalog drift check: `ADAPTERS` diffed against `catalog.snapshot.json` | New adapters, changed features, renamed credentials | Daily; opens a PR updating the snapshot and the docs table |
| Release watch on `vercel/chat` | Changelog notes, deprecations | On release |

- **The peer range moves only by a person**, after the matrix passes. A bump of
  upstream's minor version widens our range in our own minor release.
- **A major version (5.x)** gets a migration branch. The 4.x line keeps receiving
  fixes for 90 days.

## 4. Contract tests (what makes an adapter "supported")

Slack's is `test/slack.contract.test.mjs`: the real Chat SDK and the real Slack adapter,
loaded from the catalog, against a fake Slack Web API and a fake Voiceflow runtime
(`packages/slack/test/helpers/fake-slack.mjs`, and `@voiceflow/channels-sdk/testing`). Each new adapter gets one of the same shape.

Per tier-1 adapter, with fixtures picked by shape, never by content:

1. A recorded inbound webhook, signed with a test secret.
2. Run through the real adapter, then through our handler.
3. Replies go to a fake platform API. Use the catalog's API base-URL override where the
   adapter has one (`customApiEndpoint` feature; for Slack, `SLACK_API_URL`).
4. Assert:
   - a reply is posted;
   - a forged signature is refused;
   - a follow-up in the same thread reaches the same Voiceflow session;
   - buttons render natively, and a click sends the button's Voiceflow request;
   - a click from an earlier turn is answered as stale, never replayed;
   - a typed number picks an offered choice;
   - a Voiceflow failure posts the error message instead of going silent;
   - where the catalog says the feature is a full `yes`: streaming into one live message,
     progress cards, link buttons, and the adapter's own extras (Slack: feedback
     buttons, suggested prompts from the launch turn).

Slack's native features are in `test/slack.native.contract.test.mjs`. Each one was
fault-injected (the feature removed from the build) to prove its test goes red.

Read what was posted the way the platform writes it: Slack's adapter sends markdown
as `markdown_text` and a card as `blocks` with a `text` fallback.

## 5. Upstream first

- Anything missing goes to `vercel/chat` as an issue or a PR, never a local patch.
  Current candidates:
  - a stable, documented deferred-verification hook (`webhookVerifier`), for a relay that reads a
    webhook's conversation before it verifies the signature;
  - Slack's adapter ignores `PostableCard.fallbackText`. It builds the `text` fallback from
    the card, and a card of buttons alone has none, so Slack logs a warning and a
    notification shows nothing. We already pass the labels as `fallbackText`.
  - **Slack's native Card and Carousel blocks** (Block Kit, April 2026). Chat SDK 4.45
    renders a card as the older section, image and actions blocks, and has no carousel,
    so we post one message per card. [vercel/chat#1126](https://github.com/vercel/chat/pull/1126)
    (open) adds `Section(children, { layout: 'carousel' })` with native Slack carousels.
    Test it against our Slack contract test and report on the PR. A single native card
    is not in its scope: that needs an issue of its own.
  - A tool call's name. Voiceflow's `tool-call` trace carries only `callID` and
    `state`, so every progress card has the same title (`progressTitle`). The name is
    only in `debug` traces, which this package never reads. That one is a Voiceflow
    runtime ask, not Chat SDK's.
  - **Slack message and global shortcuts.** The Slack adapter answers an interactive
    payload of type `message_action` or `shortcut` with an empty 200 and dispatches
    nothing, so "Ask the agent about this message" can't be built without verifying
    Slack's signature ourselves, which this package never does. Ask for an
    `onShortcut` handler (`callbackId`, the message, `triggerId`, the user).
  - **Discord (`@chat-adapter/discord` 4.45.0), found building `@voiceflow/channels-discord`:**
    - `apiUrl` (and `DISCORD_API_URL`) isn't used for an interaction's own webhook or for a
      message with files: those calls go to `https://discord.com/api/v10` whatever it says
      (`discordInteractionFetch`, `postMessageWithFiles`). Our tests send them to the stand-in
      by replacing `fetch` while it's up (`packages/discord/test/helpers/fake-discord.mjs`).
    - `createDiscordThread(channelId, messageId)` is `protected`. The slash command uses it,
      where it's there, to answer in a thread as a mention does; without it the answer goes in
      the channel. Ask for a public way to start a thread from a message, with a name: the
      adapter names every thread "Thread" and the date, and we rename it after the question.
    - `startGatewayListener` hands back at once and reports a login Discord refuses only
      through its logger. `forwardGateway` reads the logger to say why a connection ended,
      and to say when it's up (the line "Discord Gateway connected"). Ask for the promise to
      reject, and for a connected callback.
    - In forwarding mode the listener passes on every Gateway packet, not only the three the
      webhook handles (a message, a reaction added or removed), and the webhook logs each at
      `info`. We default the adapter's logger to `warn`.
    - A slash command or a button click that arrives over the Gateway isn't handled once it's
      forwarded, so a local server still needs an address: `dev` keeps its tunnel for Discord.
    - **Found running it in Discord itself (2026-11-23)**, each with a fix here and a test
      against a stand-in that now refuses what Discord refused:
      - A card of buttons alone (a turn's choices) is sent with an embed that holds only the
        adapter's colour, and Discord refuses the message: 400, `embeds.0.description: This
        field is required`. The reply fell back to numbered text. `fitMessages`
        (`packages/discord/src/adapter.ts`) leaves the empty embed out. Ask for no embed when a
        card has nothing for one.
      - A card with no buttons, edited over a message that had them, is sent with no
        `components` at all, so Discord keeps the old buttons: after a choice they'd stay to be
        clicked. `fitMessages` sends `components: []`. Ask for the same in `editMessage`.
      - A slash command is answered "thinking…" in the reply to Discord's request, and its
        handler starts at once. A post sent straight away reaches Discord before that reply does
        (always, through `dev`'s tunnel), and is refused: 404, `Unknown Webhook` (10015). The
        person is left at "thinking…". The slash command's first post is tried again for three
        seconds (`firstAnswer`, `packages/discord/src/extension.ts`). The adapter marks the first
        answer sent before it is, so the retry goes as a follow-up, which Discord takes as the
        edit of "thinking…". Ask for the deferred answer to be sent through the interaction's
        callback, so the adapter knows when Discord has it.
      - Text over 2,000 characters is cut there and ended "...", with nothing said to anyone:
        the end of a long answer was lost. The core now sends a long reply as several messages
        (`maxTextLength`, 1,900 for Discord). Ask for the adapter to split, or to refuse.
      - An image inside a card is dropped in the adapter's embeds mode, so an image the agent
        sent went as an empty embed, which Discord refused, and its link was posted instead.
        The core now sends an image as the card's own (`imageUrl`), which the adapter keeps.
        Ask for image children to be kept, and for no embed where there is nothing to put in it.
      - When a post to an interaction's webhook fails, the adapter logs its path, and the path
        holds the interaction's token (good for fifteen minutes). This package's logger takes
        it out (`packages/discord/src/log.ts`). Ask for it to be left out at the source.
      - Renaming a thread leaves "changed the channel name" in it, so every conversation
        opened with that line. `nameThreads` (`packages/discord/src/adapter.ts`) puts the name
        in as the adapter asks Discord for the thread: the question for a slash command, and
        for a mention what the message says, read back from Discord (one more call per new
        conversation). It goes through `discordFetch`, which isn't public: without it, or
        where the message can't be read, the thread is renamed afterwards as before. Ask for
        `createDiscordThread` to take a name, and to be public.
      - Discord's check of a new address includes a request with a bad signature, which the
        adapter rightly refuses, and logs as a failure in a dozen lines, with the key's first
        and last characters, on every `dev` start. This package's logger makes it one line.
        Ask for one line, and for none of the key.
    - **Settled by that run:** the Message Content intent can be turned on through the API;
      Discord takes a quick tunnel's address; a message in a thread arrives marked as one
      (`channel_type`), so a follow-up needs no mention; a thread started on a slash command's
      answer can be named and written in; a click's answer and the buttons' removal both land.
      Discord's own install link waits forever on "Opening Discord App." while another Discord
      tab is open in the same browser: nothing of ours, but worth knowing when it's reported.
      A bot can be given a name and a picture through the API, and an application an icon; an
      application's name can't (Discord answers 200 and leaves it), so the name on the page
      that adds the bot is the one typed in the portal.
- **Chat SDK's own agent tools** (`createChatTools`, in `chat/ai`). They run in
  the app with the bot's access, are confined to the conversation being handled
  (`scope`), and ask for approval before writes. Our server tools follow the same
  model: they run in the app, act for the conversation the turn's pass names, and
  ask before leaving it. Slack's are our own, written against Slack's Web API, and
  add a per-person membership check, which `scope` doesn't make. Open: build the
  channel-neutral ones (post, read, react) on Chat SDK's operations, or on
  `createChatTools` itself, which needs `ai` and `zod` as dependencies.
- **Goal:** a Voiceflow guide or template on chat-sdk.dev / vercel.com/kb/chat-sdk.

## 6. Keeping the Voiceflow side current

- **URL buttons** keep their link in an `open_url` action on the button's request
  (`@voiceflow/base-types` `ActionType.OPEN_URL`). Voiceflow's web chat opens the link
  and still sends the request, and so do we where the channel reports link clicks.
- **Trace translation is ours** (`packages/core/src/translate.ts`). It depends on no other Voiceflow
  package: traces become platform-neutral replies (text, choices, card, carousel, image).
  Internal traces are dropped silently. Unknown ones are reported in `skipped`, never thrown.
- **The runtime client is ours** (`packages/core/src/voiceflow.ts`): `POST /v4/project/{projectID}/environment/{environmentID}/session`,
  then `POST /v4/interact`, or `POST /v4/interact/stream` with `config.completionEvents`
  (server-sent `trace` events, then `end`), written from Voiceflow's public v4 runtime API.
  Planned: types generated from its published spec, plus a spec diff in CI.
- **Server tools use only what Voiceflow documents today**: a function tool's
  `fetch`, an input filled from a variable or a secret, and variables set on a
  turn. Two things the platform could add would make them simpler. Neither is
  needed, and a tool's `run` would stay the same with either:
  - **An agent tool that pauses for a result from the app**, as a workflow's
    function step can (`next: { listen: true }`). The tool's call would come back
    in the turn's own stream, so the tools URL and the pass would go.
  - **A per-conversation value in an MCP tool's headers.** Voiceflow's MCP tool
    takes a URL and fixed headers, so a call can't say whose turn it is. With
    one, the server could offer its tools over MCP, and nothing would be
    installed on the agent.
- **Live check:** a nightly conversation against a Voiceflow test agent.
- **Transcripts:** tag every conversation with `vf-sdk` = `@voiceflow/channels-sdk@<version>`.

## 7. Before the public release

- [x] License: MIT (matches Chat SDK)
- [ ] Reserve `@voiceflow/channels-sdk`, `@voiceflow/channels-slack`,
      `@voiceflow/channels-discord` and `create-voiceflow-channels` on npm. And `voiceflow-channels`, the
      command's own name: `npx voiceflow-channels` run where the core isn't
      installed looks that name up on npm, and nobody owns it
- [x] A starter (2026-11-23): `npm create voiceflow-channels@latest` makes the
      app, as `npm create chat-sdk` does for Chat SDK. CI makes one from the
      packed packages, builds it and sends it what Slack sends
- [x] Connect reads the server's env file (2026-11-23): the agent's key,
      project and environment come from `--env-file`, a person is asked for
      what's missing, and what was asked for is saved there. Setup is the
      starter, then one command with the server's address
- [x] Connect does the Slack sign-in (2026-11-23): it refreshes an expired
      Slack CLI login, asks which workspace, runs `slack login`, and offers
      Slack's installer. With nobody at the terminal it stops (exit 3) with
      what a person has to do. `--manual` connects an app made by hand, with
      no Slack CLI
- [x] Connect offers to publish, and a new app says hello (2026-11-23):
      it shows what the environment's draft holds that isn't live and
      publishes on a yes or `--publish`, never for a script that didn't ask.
      The new app's bot then messages whoever connected it. A changed tools
      address is written to the published version's secret as well as the
      draft's, and needs no publish: seen live 2026-11-23, twice, through dev
- [x] A server on your own machine needs no address from you (2026-11-23):
      connect opens a temporary tunnel when it's given none, and
      `voiceflow-channels dev` opens one on each start, starts the server and
      points each channel at it. `point` is the channel's half of that, and
      asks the server the platform's signed check first. A new tunnel's name
      is asked of a public resolver before this machine's own, which remembers
      a miss: found live, where asking too soon cost the whole wait
- [x] The starter's app carries notes for a coding agent (2026-11-23):
      `AGENTS.md`, and a `CLAUDE.md` that points to it. They say to show the
      plan first (`--dry-run`), ask the person to go ahead and whether to
      publish in one message, and never to show a secret. Tried with fresh
      agents against a stand-in for the commands that replays their output
- [x] A second channel, built the same way (2026-11-23): Discord. Its
      package adds a slash command, thread names and `discord_*` variables to
      what the core and Chat SDK's adapter do. `connect discord` starts from a
      bot token (Discord has no way to make an application from a command),
      and `dev` holds Discord's standing connection beside the server: a
      channel's connect module can export `listen` for that. What every
      channel's command shares moved into the core
      (`@voiceflow/channels-sdk/setup`). The starter takes `--channel discord`
- [x] Discord, run in Discord itself (2026-11-23): a new application, `connect`,
      `dev` through a tunnel, then a mention and its thread, a follow-up with no
      mention, a direct message, buttons and a click, and `/ask`. Two things
      were broken and are fixed (a turn's buttons were refused, and `/ask`
      stayed at "thinking…"); section 5 has them, and what is left to ask
      upstream
- [x] Discord: a conversation's thread is named when it's made, not after, so
      it doesn't open with "changed the channel name" (2026-11-23, seen in
      Discord itself for a mention and for `/ask`)
- [x] Discord's setup, as close to Slack's as Discord allows (2026-11-23):
      connect opens the pages for the steps Discord leaves to a person, waits
      for the bot to be added and has it message whoever made it; `dev` runs
      connect first for a bot that was never connected (a channel's connect
      module exports `connected` for that); and `dev` says when the first
      message came through. What stays by hand: making the application,
      copying its token, and authorizing the server
- [ ] Slack: let `dev` run connect first too. It needs `connected` and
      `--from-dev` in Slack's connect module, as Discord's has
- [ ] Uninstall with a key that can't delete functions stops after detaching
      the tool (seen live 2026-11-23, a 401 on the delete): check the key
      first, or finish the step and say what was left
- [ ] Voiceflow sign-in instead of a pasted key. The `vf` CLI signs in through
      the browser but can't hand its session to another program, and a key
      for the server can only be issued in a signed-in browser. Both are
      Voiceflow's to change; until then connect takes a key
- [ ] Contract tests passing for Phase 1: Slack (done), WhatsApp, Messenger, Instagram, Teams, Resend, Gmail
- [ ] Upstream tracking (section 3) running
- [ ] Docs: the Channels page (native vs Channels SDK) and one page per channel
- [x] Security review of credential handling (2026-11-20): the API-key
      prompt, the env file, and what the workspace tools show and to whom
      were fixed with tests
- [x] The workspace tools run on the server (2026-11-20), so no platform
      credential goes to Voiceflow, and a tool's call acts only with the
      turn's signed pass. This replaces signing the identity variables: there
      are none to sign. What leaves the conversation waits for approval.
- [x] Server tools run against real Slack and a real agent (2026-11-22): a
      Voiceflow function reached the server through a tunnel in about 0.3
      seconds a call, against the function's 20-second default; a pin in the
      thread happened at once; a post to another channel waited for an
      Approve click in a direct message with no thread, then posted once; and
      the model, asked to, couldn't set an input wired to a variable or a
      secret (it is offered only the tool's own inputs). The run also found
      that a session ended while a conversation sat idle answers 404, which
      the client now recovers from
- [ ] Slack's tools with a bot token the adapter resolves per workspace (an
      app installed in many): outside a webhook the adapter has no client, so
      they answer that the server has no token. Needs `withBotToken`, and the
      workspace in the pass
- [ ] Tell the agent how an approved call ended. Today the request shows it in
      the thread, and the agent learns it only if the person says so
- [ ] A tool that outlives its time limit keeps running (Slack's client waits
      out a rate limit), so a write can land after the agent was told it
      timed out. Posts and messages are checked for a repeat; the others aren't
- [x] Known secret values are stripped from everything the CLI prints, errors
      included (2026-11-23): where an error is made, before it is cut to
      length, and from every line on its way out
- [ ] Remove `"private": true`

### The first publish

The release workflow publishes through npm's trusted publishing, which needs a
few things done by hand, once:

- [ ] Make the repository public first: npm makes provenance only for a public
      repository, and `release.yml` asks for it.
- [ ] Publish each package once by hand, since a trusted publisher is set on a
      package that already exists. Then, on npmjs.com, add this repository's
      `release.yml` as each package's trusted publisher.
- [ ] Check CI's `changeset` check goes red once: changesets skips private
      packages, so the check passes every pull request until `"private": true`
      comes off.
- [ ] Turn on private vulnerability reporting (Settings, Security), which
      SECURITY.md promises.
- [ ] Protect `main`: require pull requests, CI's `all checks` check and code
      owners' review.
- [ ] Give the release workflow a GitHub App token (changesets/action's
      `github-token`), so CI runs on the version pull request it opens. One
      opened with the default `GITHUB_TOKEN` starts no workflows.
- [x] Decide the oldest Node version supported: 22. Node 20's support ended
      on 2026-04-30; Vercel Chat SDK tests 22 and 24.
