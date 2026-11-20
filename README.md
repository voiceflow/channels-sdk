# @voiceflow/channels-sdk

Connect Voiceflow agents to Slack, WhatsApp, Teams, email and more, through
[Vercel Chat SDK](https://chat-sdk.dev) adapters.

> **Status:** pre-release, local only. Not published. See [docs/upstream.md](docs/upstream.md).

## What it is, and what it isn't

**Channels SDK connects Voiceflow agents to third-party platforms, where Voiceflow
doesn't own the screen.** The web widget, SMS and phone are native Voiceflow channels
and are not part of this package.

| Do we own the screen? | Use |
|---|---|
| Yes: web widget, mobile app | `@voiceflow/interface-core` / `@voiceflow/interface-react` |
| Yes: SMS, phone | Voiceflow's native channels |
| No: Slack, WhatsApp, Teams, email, … | **`@voiceflow/channels-sdk`** |

## Design rules

1. **The Chat SDK owns platforms, and we own Voiceflow.** This package contains no
   platform code. Webhooks, signatures and posting belong to `@chat-adapter/*`.
2. **The adapter catalog drives everything.** Supported platforms, what each one can
   render, and the credentials it needs all come from `chat/adapters`. A new upstream
   adapter works with no change here.
3. **It ships no interface of its own.**
4. **Upstream first.** No forks, no patches, no private fields. A missing capability
   becomes an issue or a PR on `vercel/chat`.

## Hosted version

The hosted version is **Voiceflow Channels**: the same SDK, run by Voiceflow,
with channel secrets kept in Voiceflow's secrets manager.
