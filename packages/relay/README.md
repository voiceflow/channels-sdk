# @voiceflow/channels-relay

One server for many Voiceflow agents' channels. Each **connection** is one
agent on one or more channels, with its own credentials. The relay keeps
them sealed in a store, answers every connection's webhooks at an address of
its own, and runs each one's turns as a server of its own would:
[`createChannels`](../core/README.md), with that connection's agent and bot.

It is what runs `channels.voiceflow.com`, and you can run it yourself: an
agency hosting its clients' agents, say. For one agent on your own server,
you don't need it: use [`@voiceflow/channels-sdk`](../core) directly.

> **Status:** an early release. The connections API is `v1alpha1`: expect
> changes before it is `v1`.

## Install

```bash
npm install @voiceflow/channels-relay @voiceflow/channels-sdk chat @chat-adapter/catalog @chat-adapter/state-pg pg
```

Add the channel packages you offer: `@voiceflow/channels-slack` and the rest.

## Run it

One route takes every request. In Next.js:

```ts
// app/[...path]/route.ts
import { createPostgresState } from '@chat-adapter/state-pg';
import { createRelay, parseKeys, postgresConnectionStore, type Relay } from '@voiceflow/channels-relay';
import { slack } from '@voiceflow/channels-slack';
import { after } from 'next/server';
import { Pool } from 'pg';

let relay: Relay | undefined;

function relayFor(): Relay {
  if (relay) return relay;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  relay = createRelay({
    publicURL: process.env.RELAY_PUBLIC_URL!, // https://channels.example.com
    store: postgresConnectionStore(pool),
    keys: parseKeys(process.env.RELAY_KEYS), // `id:base64` of 32 random bytes, the key that seals first
    state: createPostgresState({ client: pool, autoCreateSchema: false }),
    channels: {
      slack: {
        credentials: ['botToken', 'signingSecret'],
        channel: ({ botToken, signingSecret }) => slack({ adapter: { botToken, signingSecret } }),
      },
    },
  });
  return relay;
}

const handle = (request: Request) => relayFor().fetch(request, { waitUntil: (task) => after(() => task) });
export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
```

Before the first request, run `connectionStoreStatements` and Chat SDK's
`postgresSchemaStatements` (from `@chat-adapter/state-pg`) from your
migrations.

## Connections

Every call answers JSON and is never cached. A management token goes in an
`Authorization: Bearer <token>` header.

| Call | What it does |
|---|---|
| `POST /v1alpha1/connections` | Adds a connection. Answers its ID, each channel's address and a management **token**, shown this once. |
| `GET /v1alpha1/connections/<id>` | Shows a connection: its project, environment and channels' addresses. Never a credential. |
| `PATCH /v1alpha1/connections/<id>` | Changes its Voiceflow key or environment, or a channel's credentials (`null` takes the channel off). |
| `POST /v1alpha1/connections/<id>/token` | Gives a new token. The old one stops working. |
| `DELETE /v1alpha1/connections/<id>` | Deletes the connection, with everything sealed in it. |

Adding one:

```json
{
  "voiceflow": { "apiKey": "VF.DM.…", "projectID": "…", "environment": "production" },
  "channels": { "slack": { "botToken": "xoxb-…", "signingSecret": "…" } }
}
```

Each channel's address is the one its platform sends webhooks to, and the
one to give the agent as `channels_tools_url`: its server tools call there
too.

## How connections are kept safe

- **The agent has to be yours.** A connection is added only when Voiceflow
  lets its key read the project it names. Its token is kept only as a hash,
  and every later change needs it. A wrong token and a missing connection get
  the same answer.
- **Credentials are sealed.** The Voiceflow key, the channel's credentials and
  the connection's pass key are sealed with AES-256-GCM under a key the store
  never holds, and bound to the connection, so a sealed value copied onto
  another row doesn't open.
- **Connections are kept apart.** A thread's ID names the platform and the
  conversation, not the bot, so two bots talking to one person share it. Each
  connection's state is under its own prefix (`namespacedState`), whatever the
  store underneath does.
- **Each connection signs its own passes.** A turn's pass is signed with a key
  made for that connection at random, never its Voiceflow key, so a pass from
  one connection does nothing at another's address.
- **It only runs turns.** It reads the project once, to check the key, and
  never installs a tool, writes to the agent or publishes. Install the tools
  with `connect`, on your own machine.
- **It takes credentials, never addresses.** A channel takes exactly the
  credentials it lists. Voiceflow's addresses are the relay's to set, not a
  connection's. Offer only a channel whose adapter checks every request it is
  sent with one of its credentials.
- **Nothing it reports carries a credential.** Errors are cleaned of the
  connection's own before they reach `onError`.

It sets no limits of its own: put rate limits in front of it, at your host's
firewall.

## Keys

`RELAY_KEYS` holds `id:base64` pairs, separated by commas. The first seals,
and every one opens. To rotate, put a new key first, deploy, and run
`resealConnections({ store, keys })`. Once it reports nothing failed, take
the old key out.

## Turning a connection off

`relay.setDisabled(id, true)` turns one connection off at once, on every
instance: its addresses answer nothing, and its record stays. `false` turns
it back on. From a script, with no relay running, use
`setConnectionDisabled(store, id, true)`. A connection's owner can't turn it
back on.

## License

MIT, in [LICENSE](LICENSE).
