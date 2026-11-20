# Security

## Reporting a vulnerability

Please don't open a public issue for a vulnerability. Report it privately:

- by email to **security@voiceflow.com**, Voiceflow's address for security
  reports, or
- through GitHub's private vulnerability reporting: **Report a vulnerability**
  on this repository's Security tab.

Say what's affected, how to reproduce it, and the version or commit you used.

## What belongs here

- **This repository:** the SDK, the channel packages, `connect`, and the tools
  connect installs on an agent. Report these here.
- **Voiceflow's platform:** the same email address.
- **Vercel Chat SDK and its adapters** (`chat`, `@chat-adapter/*`): report
  those upstream, to [vercel/chat](https://github.com/vercel/chat).

## What the packages promise

Each of these failing is a vulnerability worth reporting:

- **Secrets are never printed or logged.** That covers the Voiceflow API key,
  Slack's bot and user tokens, and the app's signing secret. `connect` writes the
  app's credentials only to the file you name with `--env-file`, readable by
  you alone.
- **The bot token reaches Voiceflow only as a restricted secret**, never as a
  plain variable.
- **A Slack tool acts only for the person talking to the agent.** It takes their
  identity from the verified Slack event, never from the model, and reads or
  posts only where that person can.

## Supported versions

Fixes go into the latest release.
