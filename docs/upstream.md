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

## 1. How a channel is built

Every channel is a package, `@voiceflow/channels-<name>`, and every package is
the same four things:

- Chat SDK's adapter for the platform, with its module imported so a bundled
  server needs nothing loaded by name;
- the channel's variables (`<name>_user_id` and the rest), set on every turn;
- the commands `connect`, `point` and `disconnect` for it;
- what only that platform has, or needs.

The last is where packages differ, and only there. Slack's holds its native
features and its tools; Discord's, the standing connection a bot reads
messages over; Teams', Microsoft's own command for making the app. The
packages written from one template (`scripts/channels.mjs`) hold it in three
small files that the script reads and never writes:

- `traits.json`: facts about the platform the catalog doesn't carry, each with
  its reason under `why`. The longest text in a message; whether text is shown
  as typed, so Markdown goes as plain words; a secret of your own that connect
  makes; a setting the catalog calls optional and the adapter can't answer
  without; where a person enters the server's address.
- `src/platform.ts`: the same, where it has to be code. Twilio's puts the
  address a request was signed for back together behind a tunnel; Notion's
  writes a list in marks a comment keeps.
- `src/connect/point.ts`: gives the platform the server's address, where the
  platform takes one from a command. Telegram's does.

**How an adapter is loaded and fitted**

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
   messages (`packages/core/src/split.ts`), counted as the adapter formats it. It can also
   put a text reply into what its platform shows before it's sent (`text`): Teams has no
   headings, so its package makes each a bold line.
5. `streaming` (`packages/core/src/deliver.ts`): a full `yes` streams the turn from
   `/v4/interact/stream` into one live message, `markdown_text` chunks for text and a
   `task_update` chunk per tool call. Anything else posts whole replies from
   `/v4/interact`. `partial` doesn't count because Chat SDK's fallback for an adapter
   without native streaming edits the message, and most of those channels can't edit.
6. Credentials pass through to the adapter as given. Where an adapter accepts a
   function (Slack's `botToken` does), the hosted version can lend a secret for one turn.

**The rule for adding one:** a platform gets a package only once it passes the
contract (section 4). The catalog says what exists; the tests say what works.

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

## 4. The contract (what every channel has to pass)

`channelContract`, in `@voiceflow/channels-sdk/testing`
(`packages/core/src/contract.ts`), is the conversation every channel carries.
Each package's tests run it with the real Chat SDK, the platform's real
adapter, the core's agent, a scripted Voiceflow runtime, and a stand-in for
the platform (`test/stand-in.mjs`): a server on this machine that signs what
it sends as the platform signs, refuses what the platform refuses, and records
what the bot sends. Slack's, Discord's and Teams' packages have contract tests
of the same shape, written before this one was shared.

It asserts, for every channel:

- the channel is the adapter, with its module and its four variables;
- a request that isn't the platform's is refused, and nothing happens;
- a message gets the agent's answer, and a choice can be taken: by a click
  where the platform has buttons, by its number where it doesn't;
- who and where are set as variables, every one on every turn;
- what isn't said to the bot is answered only in a conversation it is
  following (where the platform has conversations with other people in them);
- a long answer arrives whole, each part within the platform's limit;
- what the agent writes is readable there: a link keeps its address, a list
  its numbers, and where text is shown as typed, no Markdown marks are sent;
- a card and a picture are shown, or said in words;
- the commands are the same as every channel's, and know what it needs;
- `connect` sets it up (the variables, any secret it makes), prints no
  secret, and changes nothing on a second run;
- nothing the adapter logs in any test, at any level, holds a credential it
  was given;
- nothing is reached outside this machine.

What it can't assert is that the stand-in is right about the platform. A
stand-in is written from the adapter's source and the platform's
documentation; where a fact in one comes from memory of the platform's
documentation, the package's `traits.json` says so under `why`. Section 8 is
the record of what has been run on the platforms themselves.

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
  - **Teams (`@chat-adapter/teams` 4.45.0), found building `@voiceflow/channels-teams` and
    running it in Teams itself (2026-11-23, a new Microsoft 365 trial organization):**
    - **A failed call is logged with the bot's access token.** `Teams API: send failed` is
      logged with the error the adapter caught, which is its HTTP client's: the whole request
      rides on it, `Authorization: Bearer …` included, with a stack of some sixty lines. A
      test here proves it with the Chat SDK's own console logger
      (`packages/teams/test/teams.contract.test.mjs`). This package's logger prints the
      error's name, message, status and what Teams answered (`packages/teams/src/log.ts`).
      And since 2026-11-24 it doesn't rest on the package: the core cleans what every
      adapter logs (`packages/core/src/log.ts`), so Teams used with a logger of your own,
      or with no package at all, prints no token either. Nothing here waits on a fix at
      the source.
    - The adapter always passes `skipAuth` to Microsoft's SDK, which prints
      `[DEPRECATED] skipAuth is deprecated. Use dangerouslyAllowUnauthenticatedRequests
      instead.` on every start. And it doesn't hand its `logger` to the SDK, so the SDK's own
      lines (a request with no token, a token it refuses with a stack) go to the console
      whatever logger the adapter is given: only `LOG_LEVEL` in the environment reaches
      them. Ask for the option to be passed only when set, and for the logger to be passed on.
    - The bot's own mention is taken out of a message only when the adapter's `userName` is
      the bot's display name, which a server doesn't know. Teams says which mention is the
      bot's (the entity whose `mentioned.id` is the activity's recipient) and under what
      words: this package takes it out by that (`withoutOwnMention`,
      `packages/teams/src/text.ts`). Ask for the adapter to do the same.
    - A heading is sent as its words alone, and `~~struck~~` as written, which Teams shows
      as plain text. This package makes a heading a bold line (`forTeams`); strikethrough
      is left. Ask for both in the adapter's converter.
    - No limit on a message's size. Teams refused one of 110,000 characters whole (HTTP
      413), and the person got the apology in place of the answer; 60,000 went through.
      Microsoft documents about 28 KB. The core sends a long reply as several messages
      (`maxTextLength`, 20,000 for Teams). Ask for the adapter to split, or to say its limit.
    - The sender lookup (`getMemberById`) goes to the activity's `serviceUrl`, not to
      `apiUrl`, so a test that only sets `apiUrl` reaches Microsoft. The stand-in here puts
      itself in each activity's `serviceUrl` (`packages/teams/test/helpers/fake-teams.mjs`),
      and the tests fail if anything is reached beyond this machine.
    - `getUser` asks Microsoft Graph (`/users/{id}`), which a bot may not read without an
      admin's consent, where the sender of a message is looked up through the conversation's
      members, which needs none. So a click by someone the bot has had no message from has no
      name or email (`teams_user_name` is empty), and each such person costs one refused call.
      Ask for `getUser` to try the members API first.
    - A file (`files: [{ data, filename, mimeType }]`) is sent as a data URI, which Teams
      refused with 400 in a chat and in a channel. The core sends no files today. Not looked
      into further.
    - `adapter.stream` outside a turn posts once at the end; `app` (Microsoft's SDK) is
      protected, so there is no public way to its client.
    - **Settled by that run:** a bot Microsoft's command makes with no Azure account
      ("Teams-managed") sends and receives; `teams login` asked the organization's admin for
      no consent (a non-admin is untried); `teams app update --endpoint` takes effect for an
      app already added, in about twenty seconds, with no reinstall, though the command says
      `needsReinstall`; choices as an Adaptive Card of buttons alone render; a click arrives
      as a message with a `value`; a 25-second turn is answered once; reactions, edits and
      targeted ("only you can see this") messages work; with `ChannelMessage.Read.Group` in
      the manifest before the first install, a thread's replies arrive with no mention, no
      extra consent was asked of the team's owner, and Graph thread history reads (200).
    - **Not ours, and worth knowing when it's reported:** custom app upload was off in the
      new organization (`teams status --json` says so, and connect stops with where an admin
      turns it on). A permission added AFTER the app was first installed made Teams refuse to
      add it again ("AppDefinitionDoesntExist"), three times, with the app removed from
      everywhere first: so connect sets everything as it makes the app, and never changes an
      app's permissions afterwards. Microsoft's command takes an icon only at exactly 192 by
      192 pixels (`packages/teams/src/connect/icon.ts` makes one). Each `--endpoint` update
      adds the new host to the manifest's `validDomains` and keeps the old ones: a long-lived
      development app's list grows by one per `dev` start. Seventeen were taken when tried, and
      `teams app manifest update <id> --set-json 'validDomains=["*.botframework.com"]' --yes`
      empties it, should it ever be refused. The install link opens "use the desktop app" first,
      every time. Microsoft's app secrets have a `~` in them, which the core's env-file
      writer refused until it was taught where a `~` is safe (`BARE`, `packages/core/src/setup.ts`).
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
- [x] The names are settled (2026-11-24), and every package is under the
      `@voiceflow` scope, which only Voiceflow's npm organization can publish
      to: `@voiceflow/channels-sdk`, one `@voiceflow/channels-<channel>` for
      each of the 14 channels in the README's table, and
      `@voiceflow/create-channels-sdk`, the starter
      (`npm create @voiceflow/channels-sdk`). A name with no scope can belong
      only to people's accounts, never to an organization, which is why what
      people install is all under the scope. For part of that day the project
      was called ChannelKit and its repository `channelkit`: both went back
      before anything was published, and GitHub sends that address on to
      this one
- [x] Hold the command's name on npm: `voiceflow-channels`. The command
      comes with `@voiceflow/channels-sdk`, but where the core isn't
      installed, `npx voiceflow-channels` looks that name up on npm, and
      whoever owns it decides what runs
      Done 2026-11-24: a placeholder, version 0.0.0, that only says which
      package the command comes with
- [x] Two names from the day as ChannelKit are held on npm and used by
      nothing here (2026-11-24): `voiceflow-channelkit` and
      `create-voiceflow-channelkit`. Each was published as a placeholder, and
      npm staged it: what is public under the name is npm's own stub,
      version `0.0.0-stage`. The bare name `channelkit` is someone else's
      package, a messaging gateway
- [ ] Give each of the three names held outside the scope more than one
      owner (`npm owner add`): `voiceflow-channels`, `voiceflow-channelkit`
      and `create-voiceflow-channelkit` each have the one account that
      published them. The 16 packages under the scope list the
      organization's accounts as their maintainers
- [x] A starter (2026-11-23): `npm create @voiceflow/channels-sdk@latest` makes the
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
- [x] A third channel (2026-11-23): Microsoft Teams. Its package adds
      `teams_*` variables, takes the bot's mention out of what people write,
      and keeps a failed call's access token out of the log. `connect teams`
      runs Microsoft's own Teams command, so it needs a Microsoft 365 sign-in
      and no Azure account; what it can't do (an admin allowing custom apps,
      the click on Add) it says. The core gained a way for a channel to
      reshape text before it's sent (`text`). The starter takes
      `--channel teams`. Run in Teams itself the same day: a bot made by
      `connect`, started with `dev`, answering a chat, a mention and a
      thread's replies
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
- [x] Eleven more channels (2026-11-24): Telegram, WhatsApp, Messenger,
      Instagram, Twilio, Google Chat, GitHub, GitLab, Linear, Notion and X,
      each a package written from one template (section 1) that passes the
      contract (section 4). The starter takes any of them. X Chat, Web, Gmail
      and Twitch were set aside (section 8)
- [x] Every channel with a package passes its contract tests (2026-11-24):
      Slack's, Discord's and Teams' own, and the shared one for the eleven
- [ ] The eleven run on their own platforms: none has been yet. Section 8 is
      the record, and says what to check first on each. Telegram first: it is
      the one whose address connect gives
- [ ] The platforms where a command could give the address and doesn't yet
      (checked against each platform's documentation, 2026-11-24, and not
      run): GitHub (a GitHub App from a manifest, and `PATCH /app/hook/config`),
      GitLab (`/projects/:id/hooks`), Twilio (a number's `SmsUrl`), Messenger
      (`/{app-id}/subscriptions`) and X (`/2/webhooks`, then the Activity
      API's subscriptions). WhatsApp, Instagram and Notion take it only on
      their own pages
- [ ] Telegram's buttons: the adapter refuses a message of buttons alone, so
      the core has to put a line of text on a turn's choices before Telegram
      can be told it has them
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
- [x] Take "pre-release, local only" and "the package name is not final" off
      the 17 READMEs that say it, and choose the first version (every
      package is at 0.0.0)
      Done 2026-11-24: the first version is 0.1.0, for every package
- [x] Remove `"private": true` from the 16 packages (2026-11-24)
- [x] No open advisory in what the repository installs (2026-11-24): `npm
      audit` finds none. Two were open, on `glob` and `minimatch`, which come
      in under Google Chat's adapter and are never loaded (section 5); the
      root `package.json` overrides the package that brought them

### Before the repository is public

The repository went public on 2026-11-24. Checked that day, before it did:
the 62 commits on every branch, and the 23 pull requests with their review
comments, hold no credential, no real ID, no address of a tunnel and no path
on anyone's machine. The logs of CI's runs were not read; CI is given no
secret of ours. What is left is not in the code:

- [x] Nothing an adapter logs can hold a secret, whatever the adapter does
      (2026-11-24): every adapter `createChannels` makes logs through the
      core's cleaner, which takes out the request an error carries, anything
      shaped like an access token, and every secret the channel was given. It
      was built for the Teams adapter's log (section 5), which is no longer a
      thing to wait on. That section, and pull request 17, still say what the
      adapter does: cut them before the repository is public if that should
      not be said here
- [x] Decide whether this file goes public as it is: it holds plans, and the
      record of what has and hasn't been run
      Decided 2026-11-24: it does
- [x] Turn on private vulnerability reporting (Settings, Security), which
      SECURITY.md promises
      Done 2026-11-24
- [x] Turn on secret scanning and push protection
      Done 2026-11-24: no alert was open when read that day
- [x] Protect `main`: require pull requests, CI's `all checks` check and code
      owners' review. It had no protection on 2026-11-24
      Done 2026-11-24, without the review: pull requests and `all checks`
      are required, for admins too, and force pushes and deleting it are
      off. An approving review isn't asked for while one person is both the
      only code owner and every pull request's author, who can't approve
      their own
- [ ] Confirm the address SECURITY.md gives for reports is read

### The first publish

The release workflow publishes through npm's trusted publishing, which needs a
few things done by hand, once:

- [x] Make the repository public first: npm makes provenance only for a public
      repository, and `release.yml` asks for it.
      Done 2026-11-24
- [x] Publish each of the 16 packages once by hand, since a trusted publisher
      is set on a package that already exists.
      Done 2026-11-24, at 0.1.0. npm staged each one: for a few minutes none
      was to be seen, and the stub it made, `0.0.0-stage`, is still listed as
      a version of each
- [ ] On npmjs.com, add this repository's `release.yml` as the trusted
      publisher of each of the 16 packages. Until then the workflow can't
      publish, so a version pull request must not be merged
- [x] Whoever does that first publish has rights on npm's `@voiceflow` scope,
      which other packages of Voiceflow's are already published under.
      A `developer` member of the organization has them (2026-11-24)
- [x] Check CI's `changeset` check goes red once: changesets skips private
      packages, so the check passes every pull request until `"private": true`
      comes off.
      Checked 2026-11-24 with the command the job runs, on a change to every
      package's `package.json`: it fails with no changeset and passes with
      one
- [x] What npm serves is what was checked (2026-11-24): each of the 16 is,
      byte for byte, the file that was packed, and 543 of their 546 files
      are, byte for byte, a clean build of the commit they were packed from.
      A new app made with `npm create @voiceflow/channels-sdk@latest` from
      npm itself, for Slack and for Telegram, installs, builds, starts and
      answers; the 15 libraries install together, and each one loads
- [x] The other three files are in `@voiceflow/channels-slack` 0.1.0:
      `dist/tools/workspace.js`, its types and its map, left in `dist` by a
      build from before their source was removed. Nothing loads them. Every
      build now empties `dist` first (`scripts/clean.mjs`), and the starter's
      smoke test fails on a built file with no source (2026-11-24). They go
      with the next release
- [ ] 0.1.0 has no git tag and no GitHub release: the workflow makes them
      for what it publishes, and these were published by hand
- [ ] Give the release workflow a GitHub App token (changesets/action's
      `github-token`), so CI runs on the version pull request it opens. One
      opened with the default `GITHUB_TOKEN` starts no workflows.
- [x] Decide the oldest Node version supported: 22. Node 20's support ended
      on 2026-04-30; Vercel Chat SDK tests 22 and 24.

## 8. What has been run where

The record of each channel on its own platform, with a real account. A
channel with no date has passed the contract and nothing more.

| Channel | Run on the platform | What was run |
|---|---|---|
| Slack | 2026-11-22 and 2026-11-23 | `connect` and `dev` through the starter's app; server tools against a real agent (section 7 has each run) |
| Discord | 2026-11-23 | A new application, `connect`, and what section 5 lists as found there |
| Microsoft Teams | 2026-11-23 | `connect`, `dev`, a 1:1 chat, a button, a channel mention, a thread's replies. On a new trial organization, as its admin |
| Google Chat, GitHub, GitLab, Instagram, Linear, Messenger, Notion, Telegram, Twilio, WhatsApp, X | Not yet | |

Before a channel is first run live, read its `traits.json`: each `why` says
what the fact rests on, and the ones that rest on memory of a platform's
documentation are the first to check. Known ahead of any run:

- **Telegram.** The catalog marks its buttons as partial, so choices are a
  numbered list. The adapter does send inline keyboards, but refuses a message
  of buttons alone ("Message text cannot be empty"), and the core posts a
  turn's choices as one. Buttons there need the core to put a line of text on
  such a message.
- **X.** Only direct messages are stood in for. A public reply is limited to
  280 characters as X counts them, without Premium: the adapter sends a
  longer one whole and X refuses it, so a long answer to a public mention is
  lost. The 10,000-character limit in its `traits.json` is the direct
  message's.
- **Notion.** The verification token arrives at the running server as the
  webhook is saved, so connect doesn't wait for it; and Notion locks a
  webhook's address once verified, so a tunnel's new address each `dev` means
  a new subscription.
- **WhatsApp, Messenger, Instagram, GitHub, GitLab, Linear, Google Chat,
  Twilio, X.** The address is entered by a person on the platform's page, and
  a tunnel's address is new each time `dev` starts. A fixed address
  (`dev --public-url`) avoids entering it again.
- **Google Chat.** Choices are a numbered list everywhere, because of the
  adapter's thread naming in direct messages (below).

### Platforms set aside (2026-11-24)

Four of Chat SDK's own adapters have no package, each for a reason that a
stand-in can't settle. The work done on each is kept outside the repository.

- **X Chat** (`xchat`). End-to-end encrypted: every message is decrypted with
  keys held in X's key service (Juicebox), which nothing on this machine can
  stand in for honestly. Its adapter also needs three packages of X's that
  this repository doesn't install. The core does load it by name (its adapter
  is at `@chat-adapter/x/chat`, which the loader now reads from the catalog).
- **Web** (`web`). Not a platform but a chat in the app's own page: the reply
  is the response to the request, the person is whoever the app's own sign-in
  says, and there is no address to give anyone. It needs an app of its own
  shape, not this one.
- **Gmail** (`gmail`). The adapter answers nothing until its `watch()` has
  been called, the watch lapses after seven days, and mail arrives through a
  Google Cloud Pub/Sub subscription. That is a renewing connection like
  Discord's, to be built as one.

- **Twitch** (`twitch`). It passed the contract, with two facts about it said
  in its package: a conversation is a channel's whole chat, so the bot answers
  only where it is mentioned (`follow: false`) and everyone there shares one
  Voiceflow session; and a message is 500 characters. What it lacks is setup.
  Twitch takes a server's address only through its API, as an EventSub
  subscription per channel that the broadcaster has to have allowed, and a
  tunnel's new address each `dev` needs the old subscriptions found and
  removed. The adapter has a call to make one (`subscribeToChat`) and none to
  list or remove them, so a `point` for it would be written from memory of
  Twitch's API. It is the next one to build, with a Twitch account to run it on.

### Found in the adapters while adding channels (4.45.0)

To report to `vercel/chat`. Each is worked around here, with a test.

- **Google Chat's dependencies carry two advisories** (2026-11-24: `glob`
  before 14.0.2 and `minimatch` before 11.0.1, both medium). The chain is
  `@chat-adapter/gchat` → `@googleapis/chat@^44.6.0` → `googleapis-common@8`
  → `gaxios@7.1.3` → `rimraf@^5` → `glob@10` → `minimatch@9`. `gaxios` 7
  lists `rimraf` as a dependency and never loads it, and no version inside
  those ranges is free of them: `gaxios` 8, under `@googleapis/chat` 51, has
  no `rimraf` at all. Here the root `package.json` overrides that one
  `rimraf` to 6, which takes fixed versions of both. An app that installs
  the adapter gets the chain as it is: ask for `@googleapis/chat` to be
  moved up.

- **Google Chat:** a button's click in a direct message is given another
  thread than the message it is on. `handleMessageEvent` names a direct
  message `<space>:dm`; `handleCardClick` builds the thread from the message's
  thread name and never says `isDM`. So a click's state is never found. Here:
  `capabilities: { buttons: false }`.
- **Chat SDK's `toPlainText` / `markdownToPlainText`** drop a list's numbers
  and a link's address. Instagram's adapter flattens every reply with it, so a
  numbered list of choices arrived with no numbers. Here: the core's own
  `toPlain` (`packages/core/src/plain.ts`), and text sent as a string where a
  platform shows no Markdown.
- **Notion:** `normalizeCommentMarkdown` strips `1. ` and `- ` from the start
  of every line of every reply, a plain string's too. Here: lists are written
  `(1)` and `•` (`packages/notion/src/platform.ts`).
- **WhatsApp:** more than three buttons are cut to three and nothing is said
  (`extractReplyButtons`). Here: `capabilities: { maxButtons: 3 }`, and a
  longer list is numbered.
- **Twilio:** with no `webhookUrl` the adapter checks the signature against
  `request.url`, which behind a tunnel or a proxy is the server's own address
  and not the one Twilio signed. No environment variable sets it. Here: the
  address is rebuilt from the forwarding headers
  (`packages/twilio/src/platform.ts`), checked under Next.js by the starter's
  smoke test.
- **Telegram:** the catalog lists `TELEGRAM_WEBHOOK_SECRET_TOKEN` as optional,
  and the adapter refuses every webhook request without it. Here: connect
  makes it.
- **Messenger, Instagram, Twilio:** `userName` and `fullName` are the
  person's ID or number when the platform gives no name. Here: a name equal to
  the ID is no name (`packages/core/src/channel.ts`).
- **Messenger, Twilio:** Markdown is sent as its source to a platform that
  shows it as typed. Here: `plainText`.
- **GitHub, Linear, Notion:** the bot answers only a mention of `userName`,
  which defaults to a made-up name (`github-bot`, `linear-bot`, `notion-bot`)
  and is never read from the account. Here: the name is a needed setting.
- **Messenger, Instagram:** the Graph API's address can't be set
  (`GRAPH_API_BASE` is fixed), though the catalog says Instagram's can. The
  stand-ins replace `fetch` for that one host while they're up.
- **Twilio:** an inbound message with an empty body (a picture alone) is
  taken as a status callback and dropped. Not worked around.

