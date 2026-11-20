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
3. Credential names come from `listEnvVars`. Each catalog key maps to a Voiceflow
   secret by one rule (`secretName`: `SLACK_BOT_TOKEN` → `slack_bot_token`), so no list
   is kept by hand.
4. Rendering reads `features` (`packages/core/src/render.ts`). Only a full `yes` counts; `partial`
   gets the fallback:
   - no `buttons`: a numbered list, and a typed number or label picks the choice;
   - no `linkButtons`: a group with a URL button goes as numbered markdown links;
   - no `cardFormat`: a card goes as markdown, its choices numbered;
   - no `imagesInCards`: the image goes as its URL;
   - `typingIndicator`: shown while the turn runs.
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
- **Live check:** a nightly conversation against a Voiceflow test agent.
- **Transcripts:** tag every conversation with `vf-sdk` = `@voiceflow/channels-sdk@<version>`.

## 7. Before the public release

- [x] License: MIT (matches Chat SDK)
- [ ] Reserve `@voiceflow/channels-sdk` and `@voiceflow/channels-slack` on npm
- [ ] Contract tests passing for Phase 1: Slack (done), WhatsApp, Messenger, Instagram, Teams, Resend, Gmail
- [ ] Upstream tracking (section 3) running
- [ ] Docs: the Channels page (native vs Channels SDK) and one page per channel
- [x] Security review of credential handling (2026-11-20): the API-key
      prompt, the bot token's secret, the env file, and what the workspace
      tools show and to whom were fixed with tests
- [ ] Sign the identity variables the workspace tools trust (an HMAC keyed by
      a second restricted secret), so a session variable set outside Slack
      can't act for someone
- [ ] Strip known secret values from every error the CLI prints
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
