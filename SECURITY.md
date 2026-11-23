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
  you alone. An error is no exception: when a server repeats a secret back,
  the command prints `[hidden]` in its place.
- **No platform credential goes to Voiceflow.** The tools that act in Slack
  run on your server, with the server's own bot token. The agent holds only
  the address it calls them at.
- **A tool's call acts only for the conversation it came from.** The server
  takes the thread and the person from a pass it made for that turn from the
  verified Slack event, signed with a key only the server holds. A call
  without that pass, with a changed one, or with one whose turn has ended does
  nothing. Nothing the model or the call says can name another person or
  conversation.
- **A Slack tool acts only where that person could.** It reads or posts only in
  channels they are a member of. What it reads, it shows only where everyone
  could read it.
- **What leaves the conversation waits for approval.** A post in a channel or
  a message to someone else happens only after the person who asked approves
  it, with a click the platform signs, and then only once.
- **What is approved is what was shown.** A request shows where the action
  goes and all of what it says. What runs is that, and nothing longer or
  aimed elsewhere.

## Supported versions

Fixes go into the latest release.
