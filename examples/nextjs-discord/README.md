# Voiceflow in Discord, on Next.js

A Voiceflow agent in Discord, served by one Next.js route:
[`app/api/discord/route.ts`](app/api/discord/route.ts). Mentions, threads,
direct messages, buttons and `/ask` all arrive there.

## What you need

- Node.js 22 or later
- A Voiceflow agent, its project ID and an API key
- A Discord server you can add apps to
- A public address for your machine. Dev opens a tunnel for that with
  [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/),
  which needs no account, and says how to get it when you don't have it

## Run it

1. From the repository's root, install and build the packages the example
   uses:

   ```bash
   npm ci
   npm run build
   ```

2. Set it up:

   ```bash
   cd examples/nextjs-discord
   npm run connect
   ```

   Discord has no way to make an application from a command, so connect opens
   [the page for it](https://discord.com/developers/applications?new_application=true)
   and waits: name the application as connect says, create it, open its
   **Bot** page, click **Reset Token**, and paste the token at connect's
   hidden prompt. Set nothing else in the portal.

   It asks for what `.env.local` doesn't say (your Voiceflow API key, in a
   hidden prompt, and your project's ID), shows its plan,
   and asks first. Then it gives the bot your agent's name and picture, turns
   on the intent that lets the bot read what people write, adds the `/ask`
   command, creates the `discord_*` variables on your agent, and writes the
   app's `DISCORD_PUBLIC_KEY` and
   `DISCORD_APPLICATION_ID` to `.env.local`. The bot token stays on this
   server: it never goes to Voiceflow. Nothing is published.

   Last, it opens the page that adds the bot to a server: pick the server,
   and authorize.

3. Start the server:

   ```bash
   npm run dev
   ```

   It opens a tunnel to port 3000, starts the server, gives Discord the
   tunnel's address for slash commands and buttons, and holds the connection
   Discord sends messages over. Stop it with Ctrl-C.

Mention the bot in a channel, send it a direct message, or use `/ask`.

## Deploy it

Discord reaches a bot two ways, and a deployment needs both.

- **Slash commands and buttons** go to an address. Deploy with the same
  environment variables as `.env.local`, then give Discord the address:

  ```bash
  npm run connect -- --public-url https://<your deployment>
  ```

- **What people write** comes over a standing connection that something has
  to hold. [`app/api/discord/gateway/route.ts`](app/api/discord/gateway/route.ts)
  holds it for ten minutes each time it's called, and
  [`vercel.json`](vercel.json) calls it every nine. Set `CRON_SECRET` to a long
  random value: the route refuses a call without it. Anywhere else, have a
  scheduler send `GET /api/discord/gateway` with the header
  `Authorization: Bearer <CRON_SECRET>` every nine minutes. Your host has to
  allow a request that long and a schedule that often: check its plan.
- Set `REDIS_URL` to a Redis database: conversations live in memory without
  it, and end when the server restarts or a request reaches another instance.
- Use a second Discord application for development. While `npm run dev` runs,
  Discord sends that bot's slash commands and buttons to your machine, and a
  bot connected from two places answers twice.

## How it fits together

- `createChannels` runs on the first request, not at build time: Discord's
  adapter needs the app's public key, and the build doesn't have it.
- `discord()` from `@voiceflow/channels-discord` brings what only Discord has,
  and the Discord adapter's module.
- `next.config.ts` keeps the Discord adapter out of the bundle: it loads
  optional native modules by name.
- `after()` lets the agent's turn finish after the response: Discord wants an
  answer within three seconds.
