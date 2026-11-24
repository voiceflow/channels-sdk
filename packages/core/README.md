# @voiceflow/channels-sdk

The core of Voiceflow Channels: a Voiceflow agent inside any
[Vercel Chat SDK](https://chat-sdk.dev) bot, on any adapter in the catalog.

> **Status:** pre-release, local only. Not published. The package name is not final.

It loads any adapter the catalog lists; Slack is the one tested live so far. A channel package
(`@voiceflow/channels-slack`, `@voiceflow/channels-discord`) adds what only that channel has: its
native behaviours, its tools, and the `connect` command that sets it up.

## Entry points

| Import | What it is |
|---|---|
| `@voiceflow/channels-sdk` | `createChannels`, the agent, rendering, server tools, the extension API. |
| `@voiceflow/channels-sdk/install` | `installTools` / `uninstallTools`: puts a channel's tools on an agent. Node only. |
| `@voiceflow/channels-sdk/dev` | `dev` and `startTunnel`: a tunnel, your server, and each channel pointed at it. Node only. |
| `@voiceflow/channels-sdk/testing` | Fakes of Voiceflow's API and runtime, and `runFunction`, which runs a tool as Voiceflow's sandbox does. |
| `voiceflow-channels` (bin) | `voiceflow-channels connect <channel>` (and `point`, `disconnect`): hands off to `@voiceflow/channels-<channel>/connect`. `voiceflow-channels dev` is this package's own. |

## Bundled servers

A bundler (Next.js, say) can't follow an import of a name it only learns at
run time, so the core can't load an adapter by the name the catalog gives.
Pass the adapter's module with its slug: `{ slug: 'whatsapp', module: await
import('@chat-adapter/whatsapp') }`. A channel package (`slack()`) passes it
for you. See [How it works](../../docs/how-it-works.md#any-chat-sdk-adapter).

## Channel extensions

A channel package gives `createChannels` an extension (`ChannelExtension`):

- `variables`: Voiceflow variables set on every turn (who, where).
- `input`: rewrite the person's message before the agent sees it.
- `turnStarted` / `turnEnded`: around each turn (a reaction while it works).
- `traces`: handlers for custom traces, by type, which show a tool's output natively.
- `tools`: the channel's [server tools](#server-tools), callable only from its own conversations.
- `attach`: the bot's own events (the assistant panel, reactions, slash commands).
- `adapterDefaults`: the adapter options the channel turns on.
- `maxTextLength`: the longest text the platform shows in one message. A longer
  reply goes as several, cut between paragraphs, lines, sentences or words (and a
  code block cut in two is closed and opened again). Set it where the adapter
  would otherwise cut a long message short.

## Server tools

A server tool is a tool the agent calls whose code runs in your app. The agent
holds only a small Voiceflow function that passes the call on. Your server
runs it, knowing which conversation and person it is for.

```ts
import { createChannels, type ServerTool } from '@voiceflow/channels-sdk';

const lookUpOrder: ServerTool = {
  name: 'look_up_order',
  description: 'Look up an order by its number, when the person asks about one.',
  inputs: { number: 'The order number.' },
  async run(input, turn) {
    // turn.thread is the conversation; turn.userId is the person, as the channel identifies them.
    const order = await orders.find(input.number, { customer: turn.userId });
    if (!order) return { ok: false, result: "I can't find that order." };
    return { ok: true, result: `Order ${order.number} is ${order.status}.` };
  },
};

const channels = await createChannels({ voiceflow, channels: [slack()], state, tools: [lookUpOrder] });
```

- **Credentials stay in your app.** A tool uses your server's environment. No
  token or key goes to Voiceflow.
- **The model never chooses who a tool acts for.** On every turn the server
  makes a pass naming the thread and the person, signed with a key only the
  server holds, and sets it as the `channels_turn_pass` variable. The agent's
  function sends it back with the call. A call without a pass this server
  made, or with one whose turn has ended, does nothing. Only the inputs a tool
  declares reach it, each as a string.
- **Calls arrive where the channel's webhook does.** `channels.webhook(slug,
  request)` answers a tool's call as well as the platform's events, so there
  is nothing more to route. `channels.tools(request)` answers them on a route
  of their own.
- **Approval.** `approval: true` asks the person before every call, showing
  every input. A tool that only sometimes needs it returns
  `askFirst('Refund this order?', details)` from `run` while `turn.approved`
  is false, and runs again once the person approves. The request is a card
  with Approve and Cancel (or, where a channel has no buttons, a reply of
  `approve` or `cancel`). Only the person who asked can approve it, from where
  it was asked, and it acts once.
- **What they approve is what they see.** A request's text is shown whole, so
  one too long to show (12,000 characters) isn't asked and isn't done. Put
  anything the model wrote through `quoted()`, so it can't pass for what your
  tool says. Give `askFirst` a third argument with the IDs your tool resolved
  names to, and that is what runs.
- **`requireApproval`** on `createChannels` turns asking off or on, for every
  tool or by name. A tool that only reads says `approval: false`, and `true`
  leaves it alone: its outputs go back to the agent, which an approval can't do.
- **`toolSecret`** signs the pass. By default the key is derived from your
  Voiceflow API key, so every instance has it already. Give your own (32 or
  more random characters, the same on every instance) to keep the two apart.
- **State.** A pass needs no shared state. Approval requests are kept in the
  bot's state until they're answered or expire (ten minutes, or
  `approvalTimeoutMs`), so on more than one instance they need a shared state
  adapter, as conversations do.

Put your tools on the agent with the installer. The secret holds the address
the agent calls: a route that runs `channels.webhook` or `channels.tools`.

```ts
import { serverToolSet, TOOLS_URL_SECRET } from '@voiceflow/channels-sdk';
import { installTools } from '@voiceflow/channels-sdk/install';

await installTools(serverToolSet('my-app', [lookUpOrder]), {
  apiKey, projectID, environment: 'development',
  secretValues: { [TOOLS_URL_SECRET]: 'https://<your server>/api/slack' },
});
```

Raise a tool's `version` when its name, description, inputs or outputs change,
and install again. A change to what `run` does needs no install: it ships
with your server.

## Local development

`voiceflow-channels dev -- <your server's command>` is local development in one
command, for any channel:

- **It opens a tunnel** to your server's port (a Cloudflare quick tunnel: no
  account, and an address that's new each time), and says how to get
  cloudflared when it isn't installed.
- **It starts your server**, with `PORT` set, and waits until it answers.
- **It points each channel at the tunnel**: every `@voiceflow/channels-*`
  package the app depends on is asked to move its platform, and the agent's
  tools, to the new address. A channel takes part by answering
  `point --public-url <address> --local-url <the server here>`.
- **Stopping it stops all of it.** `--public-url` uses an address of your own
  and starts no tunnel.

`startTunnel` is the tunnel on its own, from `@voiceflow/channels-sdk/dev`.

## Installing tools

`installTools(set, options)` installs a channel's `ToolSet` through Voiceflow's
public API:

- **`setSecretValues`** sets the value of secrets the agent already has, in the
  draft and the published version: for a value that changes on its own, such
  as a tunnel's address.
- **It never publishes.** It writes the environment's draft and compiles it.
  Publishing is a step of its own: `draftChanges` reads what the draft holds
  that isn't live, and `publishEnvironment` makes the whole draft live.
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
- **Wired inputs** (`from: 'channels_turn_pass'`) default to a variable or
  secret and are not the model's to fill.
- **A secret nothing reads any more** (`retiredSecrets` on the set) is never
  deleted: the result's `notes` say it is still there.

`uninstallTools` detaches the set's tools and deletes their functions, keeping
any function you edited.

An error from Voiceflow's API never carries the API key, or a secret's value
being written, even when the API repeats one back. For a command of your own,
`createRedactor()` does the same for what you print: tell it each secret with
`add`, and print through `redact`.

A tool is a `ToolDefinition`: its Voiceflow function's code (written as a plain
named function, made into one with `functionSource`), inputs, outputs, paths, a
version, the OAuth scopes it needs, and its kind: a presentation tool returns
a trace the channel shows, and a server tool (`serverToolDefinition`) passes
the call to your server.
Build the code in a getter (`get code() { return functionSource(main, helpers); }`):
`functionSource` reads the functions' source text, which a bundler's minifier
rewrites, and a getter means only an install reads it. Install from Node, not
from a bundled server.
