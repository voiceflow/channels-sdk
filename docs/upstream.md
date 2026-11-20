# Staying current with Vercel Chat SDK

How `@voiceflow/channels-sdk` uses Chat SDK adapters for every platform it can, and
stays compatible as upstream ships.

## Upstream facts (checked 2026-11-19)

- `chat` is MIT and lives in `vercel/chat`. All packages (`chat`, `@chat-adapter/*`)
  release together under the same version number.
- It's on major version 4, with a minor release every 1–2 weeks: 4.38.0 on 2026-08-14,
  4.45.0 on 2026-11-13, 62 releases in 4.x so far.
- Public exports: `chat`, `chat/adapters`, `chat/ai`, `chat/workflow`,
  `chat/serialization`, `chat/jsx-runtime`.
- `chat/adapters` exports a machine-readable catalog: `ADAPTERS`, `ADAPTER_NAMES`,
  `getAdapter`, `getSecretEnvVars`, `listEnvVars`, `listPlatformAdapters`, and
  `listStateAdapters`. 36 entries (platform and state adapters).
  Each platform entry carries:
  - `slug`, `name`, `group` (`official` / vendor), `packageName`, `factoryExport`, `peerDeps`;
  - `features`: post / edit / delete, streaming, `cardFormat`, buttons, select menus,
    tables, typing indicator, mentions, DMs, `customApiEndpoint`, …;
  - `env.credentialModes`: every credential, with `key`, `description` and `secret: true|false`.

## 1. Adapters in three tiers

| Tier | What it takes | Example |
|---|---|---|
| **1: catalog-driven (the easy adapters)** | Nothing. Loaded and configured from the catalog alone | Most official adapters |
| 2: override hook | A small render or ID override, in this package, behind a documented hook | A platform whose thread IDs need mapping |
| 3: hosted connector | Hosted relay only: the setup handshake, reading the conversation ID before verification | Meta's `hub.challenge`, Slack's `url_verification` |

**How tier 1 works**

1. `channel({ slug, credentials })` looks the slug up in `ADAPTERS`.
2. It dynamically imports `packageName` and calls `factoryExport`.
3. Credential names come from `env.credentialModes`. Each catalog key maps to a
   Voiceflow secret by one rule (`SLACK_BOT_TOKEN` → `slack_bot_token`), so no list is
   kept by hand.
4. Rendering reads `features`:
   - `buttons` absent: a numbered text list;
   - `cardFormat` absent: markdown;
   - `streaming`: stream, else post whole replies;
   - `typingIndicator`: shown while the turn runs.
5. Credentials are passed as functions wherever the adapter accepts them. That's what
   lets the hosted version lend a secret for one turn.

**Promotion rule:** an adapter counts as supported only once it passes the contract
tests (section 4). The catalog says what exists; our tests say what works.

## 2. Dependency model

- `chat`: `peerDependencies` `>=4.44.0 <5`. The customer's copy is the one used.
- `@chat-adapter/*`: optional peers (`peerDependenciesMeta.optional`). Customers install
  only the adapters they use. Dev dependencies pin every supported adapter for tests.
- **Never** bundle, fork or `patch-package` upstream code.
- **Only public exports.** Lint bans:
  - deep imports (`chat/dist/...`, `@chat-adapter/*/dist/...`);
  - underscore-prefixed fields.

  The relay spike sets `slack._botUserId`. That goes away: use the `botUserId` option,
  or file upstream for a public way.

## 3. Tracking upstream

| Mechanism | What it catches | Cadence |
|---|---|---|
| Renovate, one grouped PR for `chat` + `@chat-adapter/*` | New releases | On release |
| CI matrix: the oldest supported `chat` version + `latest` | Breaking the floor or the ceiling | Every PR |
| Nightly against `chat@latest` + every adapter's latest | Upstream breakage before customers see it | Daily; opens an issue on failure |
| Catalog drift check: `ADAPTERS` diffed against `catalog.snapshot.json` | New adapters, changed features, renamed credentials | Daily; opens a PR updating the snapshot and the docs table |
| Release watch on `vercel/chat` | Changelog notes, deprecations | On release |

- **The peer range moves only by a person**, after the matrix passes. A bump of
  upstream's minor version widens our range in our own minor release.
- **A major version (5.x)** gets a migration branch. The 4.x line keeps receiving
  fixes for 90 days.

## 4. Contract tests (what makes an adapter "supported")

Per tier-1 adapter, with fixtures picked by shape, never by content:

1. A recorded inbound webhook, signed with a test secret.
2. Run through the real adapter, then through our handler.
3. Replies go to a fake platform API. Use the catalog's API base-URL override where the
   adapter has one (`customApiEndpoint` feature; for Slack, `SLACK_API_URL`).
4. Assert:
   - a reply is posted;
   - a forged signature is refused;
   - a follow-up in the same thread reaches the same Voiceflow session;
   - an unsupported rich element falls back to text.

## 5. Upstream first

- Anything missing goes to `vercel/chat` as an issue or a PR, never a local patch.
  Current candidates:
  - a documented public way to set the bot user ID;
  - a stable, documented deferred-verification hook (`webhookVerifier`) for the hosted lease.
- **Goal:** a Voiceflow guide or template on chat-sdk.dev / vercel.com/kb/chat-sdk.

## 6. Keeping the Voiceflow side current

- **Trace translation:** reuse `@voiceflow/interface-core`'s translator (Pat Eidt and
  Andrew Lawrence's work in `creator-app`) instead of writing a second one. Agree
  the entry point with them first.
- **Runtime types:** generated from the v4 runtime spec, plus a spec diff in CI.
- **Live check:** a nightly conversation against a TypeGlish test agent.
- **Transcripts:** tag every conversation with `vf-sdk` = `@voiceflow/channels-sdk@<version>`
  (`platform#4521`).

## 7. Before the public release

- [x] License: MIT (matches Chat SDK)
- [ ] Reserve `@voiceflow/channels-sdk` on npm
- [ ] Translator reuse agreed with Pat and Andrew
- [ ] Contract tests passing for Phase 1: Slack, WhatsApp, Messenger, Instagram, Teams, Resend, Gmail
- [ ] Docs: the Channels page (native vs Channels SDK) and one page per channel
- [ ] Security review of credential handling
- [ ] Remove `"private": true`
