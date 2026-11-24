# Voiceflow in Slack, on Next.js

A Voiceflow agent in Slack, with everything Slack has, served by one Next.js route:
[`app/api/slack/route.ts`](app/api/slack/route.ts). Mentions, direct messages,
the assistant panel, buttons, forms and `/ask` all arrive there.

## What you need

- Node.js 22 or later
- A Voiceflow agent, its project ID and an API key
- A Slack workspace where you can create apps. Connect signs you in to it
  through the [Slack CLI](https://tools.slack.dev/slack-cli), and offers to
  install that when you don't have it
- A public address for your machine. Connect and dev open a tunnel for that
  with
  [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/),
  which needs no account, and say how to get it when you don't have it

## Run it

1. From the repository's root, install and build the packages the example
   uses:

   ```bash
   npm ci
   npm run build
   ```

2. Make the Slack app. Run this before the server, so that connect can answer
   Slack's check of the address itself:

   ```bash
   cd examples/nextjs-slack
   npm run connect
   ```

   With no address given, connect opens a temporary tunnel so Slack has one
   while the app is made.

   It signs you in to Slack (it runs `slack login` for you, and offers to
   install the Slack CLI first when you don't have it). It asks for your
   Voiceflow API key (in a hidden prompt), your project's ID and the
   environment, then shows its plan and asks first. It makes and
   installs the app, installs Slack's tools on the agent, and writes
   `.env.local`: the app's `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, and
   what it asked you for. To skip the questions, copy `.env.example` to
   `.env.local` and fill it in first. The tools that act in Slack run on
   this server, so the bot token goes nowhere else: Voiceflow gets only the
   address the agent calls them at, which is the same route.

   The bot runs the environment's published version, so connect then shows
   what the environment's draft holds and asks whether to publish it. The
   whole draft goes live, not only these tools: say no to publish it in
   Voiceflow yourself. The new app's bot then messages you in Slack.

3. Start the server:

   ```bash
   npm run dev
   ```

   It opens a tunnel to port 3000, starts the server, and points the Slack app
   and the agent's tools at the tunnel's address, which is new each time. That
   needs no publish. Stop it with Ctrl-C.

Mention the app in a channel, send it a direct message, or open it from
Slack's assistant panel.

## Deploy it

- Set the same environment variables on your host, with `REDIS_URL` pointing at
  a Redis database: conversations live in memory without it, and end when the
  server restarts or a request reaches another instance. So do requests for
  approval, which the click that answers one must find.
- Run connect again from this folder, with the same environment and your
  deployment's URL. It reuses the app it made for that environment and points
  it at the new URL. A different environment gets an app of its own.

  ```bash
  npm run connect -- --public-url https://<your deployment>
  ```

  `npm run start` runs the built server with no tunnel.

## How it fits together

- `createChannels` runs on the first request, not at build time: Slack's
  adapter needs its signing secret, and the build doesn't have it.
- `slack()` from `@voiceflow/channelkit-slack` brings everything only Slack has,
  and the Slack adapter's module, so Next.js can bundle it.
- `after()` lets the agent's turn finish after the response: Slack wants an
  answer within three seconds.
- The same route answers the agent's Slack tools. When the agent posts in a
  channel or messages someone, its tool calls this server in the middle of the
  turn, and the server acts in Slack for the person who asked. Anything that
  leaves the conversation waits for their approval first.
