# Voiceflow in Slack, on Next.js

A Voiceflow agent in Slack at full fidelity, served by one Next.js route:
[`app/api/slack/route.ts`](app/api/slack/route.ts). Mentions, direct messages,
the assistant panel, buttons, forms and `/ask` all arrive there.

## What you need

- Node.js 22 or later
- A Voiceflow agent, its project ID and an API key
- A Slack workspace where you can create apps, and the
  [Slack CLI](https://tools.slack.dev/slack-cli) logged in to it (`slack login`)
- A public URL for your machine, from a tunnel such as
  [ngrok](https://ngrok.com) or
  [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)

## Run it

1. From the repository's root, install and build the packages the example
   uses:

   ```bash
   npm ci
   npm run build
   ```

2. Add your agent's details:

   ```bash
   cd examples/nextjs-slack
   cp .env.example .env.local
   ```

   Fill in `VOICEFLOW_API_KEY` and `VOICEFLOW_PROJECT_ID`.

3. Start a tunnel to port 3000, and keep it running:

   ```bash
   ngrok http 3000
   ```

4. Make the Slack app, with the tunnel's URL. Run this before the server, so
   that connect can answer Slack's check of the URL itself:

   ```bash
   npm run connect -- --project <project id> --environment development --public-url https://<your tunnel>
   ```

   It shows its plan and asks first. It makes and installs the app, installs
   Slack's tools on the agent, and writes `SLACK_BOT_TOKEN` and
   `SLACK_SIGNING_SECRET` to `.env.local`. It asks for your Voiceflow API key
   in a hidden prompt, unless `VOICEFLOW_API_KEY` is set.

5. Publish the agent's `development` environment in Voiceflow. The bot runs
   the environment's published version, and connect never publishes.

6. Start the server:

   ```bash
   npm run dev
   ```

Mention the app in a channel, send it a direct message, or open it from
Slack's assistant panel.

## Deploy it

- Set the same environment variables on your host, with `REDIS_URL` pointing at
  a Redis database: conversations live in memory without it, and end when the
  server restarts or a request reaches another instance.
- Run connect again from this folder, with the same environment and your
  deployment's URL. It reuses the app it made for that environment and points
  it at the new URL. A different environment gets an app of its own.

  ```bash
  npm run connect -- --project <project id> --environment development --public-url https://<your deployment>
  ```

## How it fits together

- `createChannels` runs on the first request, not at build time: Slack's
  adapter needs its signing secret, and the build doesn't have it.
- `slack()` from `@voiceflow/channels-slack` brings everything only Slack has,
  and the Slack adapter's module, so Next.js can bundle it.
- `after()` lets the agent's turn finish after the response: Slack wants an
  answer within three seconds.
