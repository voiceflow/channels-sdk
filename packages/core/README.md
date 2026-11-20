# @voiceflow/channels-sdk

The core of Voiceflow Channels: a Voiceflow agent inside any
[Vercel Chat SDK](https://chat-sdk.dev) bot, on any adapter in the catalog.

> **Status:** pre-release, local only. Not published. The package name is not final.

It loads any adapter the catalog lists; Slack is the one tested live so far. A channel package
(`@voiceflow/channels-slack`) adds what only that channel has: its native
behaviours, its tools, and the `connect` command that makes its app.

## Entry points

| Import | What it is |
|---|---|
| `@voiceflow/channels-sdk` | `createChannels`, the agent, rendering, the extension API. Runs anywhere. |
| `@voiceflow/channels-sdk/install` | `installTools` / `uninstallTools`: puts a channel's tools on an agent. Node only. |
| `@voiceflow/channels-sdk/testing` | Fakes of Voiceflow's API and runtime, and `runFunction`, which runs a tool as Voiceflow's sandbox does. |
| `voiceflow-channels` (bin) | `voiceflow-channels connect <channel>`: hands off to `@voiceflow/channels-<channel>/connect`. |

## Channel extensions

A channel package gives `createChannels` an extension (`ChannelExtension`):

- `variables`: Voiceflow variables set on every turn (who, where).
- `input`: rewrite the person's message before the agent sees it.
- `turnStarted` / `turnEnded`: around each turn (a reaction while it works).
- `traces`: handlers for custom traces, by type, which show a tool's output natively.
- `attach`: the bot's own events (the assistant panel, reactions, slash commands).
- `adapterDefaults`: the adapter options the channel turns on.

## Installing tools

`installTools(set, options)` installs a channel's `ToolSet` through Voiceflow's
public API:

- **It never publishes.** It writes the environment's draft and compiles it.
- **The plan comes first.** `dryRun: true` reads the project and returns the
  steps; `formatStep` turns each into a line for a person.
- **`expectWorkspace`** stops it, changing nothing, unless the project is in that
  workspace.
- **Each tool is installed once.** The install record (per project, environment
  and channel) remembers it: a tool you remove or detach is never added again
  unless restored by name, a function you edit is never overwritten, and an
  unedited one is updated to a new version.
- **Secrets are made restricted, without a value**, and the value you give is
  written to the environment's draft and published versions only. Values are
  never printed or returned.
- **Wired inputs** (`from: 'slack_user_id'`) default to a variable or secret and
  are not the model's to fill.

`uninstallTools` detaches the set's tools and deletes their functions, keeping
any function you edited.

A tool is a `ToolDefinition`: its Voiceflow function's code (written as a plain
named function, made into one with `functionSource`), inputs, outputs, paths, a
version, the OAuth scopes it needs, and whether it's a presentation tool (returns
a trace the channel shows) or a workspace tool (calls the platform itself).
