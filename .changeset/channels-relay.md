---
"@voiceflow/channels-relay": minor
---

New package: `@voiceflow/channels-relay`, one server for many Voiceflow agents' channels. Each connection's Voiceflow key and channel credentials are sealed with AES-256-GCM in a store (in memory, or Postgres with `postgresConnectionStore`), and answered at `/v1/hooks/<connection>/<channel>`. A connection is added only with a key that can read its project, and changed only with its own management token. Its conversations are kept apart from every other's on one shared state store, its turns' passes are signed with a key of its own, and the relay never writes to an agent.
