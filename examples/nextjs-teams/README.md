# Voiceflow in Microsoft Teams, on Next.js

A Voiceflow agent in Microsoft Teams, served by one Next.js route:
[`app/api/teams/route.ts`](app/api/teams/route.ts). Chats, channel threads,
mentions, buttons and cards all arrive there.

## What you need

- Node.js 22.12 or later
- A Voiceflow agent, its project ID and an API key
- A Microsoft 365 work or school account with Teams, in an organization that
  lets people add apps of their own to Teams. No Azure account is needed
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
   cd examples/nextjs-teams
   npm run connect
   ```

   Connect runs Microsoft's own Teams command, which has you sign in to
   Microsoft 365 with the account you use Teams with. It asks for what
   `.env.local` doesn't say (your Voiceflow API key, in a hidden prompt, and
   your project's ID), shows its plan, and asks first.

   Then it has Microsoft make the Teams app, its bot and the bot's secret,
   gives the bot your agent's name and picture, asks for the permission that
   lets it read a thread's replies, creates the `teams_*` variables on your
   agent, and writes `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` and
   `TEAMS_APP_TENANT_ID` to `.env.local`. The secret stays on this server: it
   never goes to Voiceflow. Nothing is published.

   Last, it opens the page that adds the bot in Teams: choose **Use the web
   app instead** if you don't have the desktop app, click **Add**, then
   **Open**, or pick a team's channel.

3. Start the server:

   ```bash
   npm run dev
   ```

   It opens a tunnel to port 3000, starts the server, and gives Teams the
   tunnel's address. Stop it with Ctrl-C.

Write to the bot in its chat, or mention it in a channel it was added to.

`npm run dev` alone does all of it the first time: it runs connect before it
starts when no bot is connected from here.

[`@voiceflow/channels-teams`](../../packages/teams/README.md) has every option.
