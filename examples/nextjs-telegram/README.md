# Voiceflow in Telegram, on Next.js

A Voiceflow agent in Telegram, served by one Next.js route:
[`app/api/telegram/route.ts`](app/api/telegram/route.ts).

## Run it

1. From the repository's root, install and build the packages the example
   uses:

   ```bash
   npm ci
   npm run build
   ```

2. Make a bot with Telegram's BotFather, and put its token in `.env.local`
   as `TELEGRAM_BOT_TOKEN` ([`.env.example`](.env.example) names each
   setting). Then set it up:

   ```bash
   cd examples/nextjs-telegram
   npm run connect
   ```

   Connect says which settings are still missing and what each is, asks for
   what `.env.local` doesn't say of your Voiceflow agent, shows its plan, and
   asks first. Then it creates the `telegram_*` variables on your agent, and
   makes the secret Telegram sends back with each message. Nothing is
   published.

3. Start the server:

   ```bash
   npm run dev
   ```

   It opens a tunnel to port 3000, starts the server, and gives Telegram the
   tunnel's address. Stop it with Ctrl-C.

`npm run dev` alone does all of it the first time.

[`@voiceflow/channelkit-telegram`](../../packages/telegram/README.md) has every option.
