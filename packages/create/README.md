# @voiceflow/create-channels-sdk

Start a Voiceflow agent in Slack, Discord, Microsoft Teams or any other
channel with one command.

> **Status:** an early release. Expect changes between versions before 1.0.

```bash
npm create @voiceflow/channels-sdk@latest my-bot
```

It makes a folder with a small Next.js server: the route Slack calls, an env
file, and a `connect` script that makes the Slack app. `pnpm create`,
`yarn create` and `bunx @voiceflow/create-channels-sdk` work the same way.

## What it writes

```txt
app/api/slack/route.ts   The route Slack calls, and the agent's Slack tools
app/layout.tsx           A one-page site, so the server has something to show
app/page.tsx
.env.example             What the server needs
.env.local               Your own copy, readable only by you, ignored by git
next.config.ts
tsconfig.json
package.json             The packages, at the versions the app is tested with
README.md                Each step from here to a working bot
.gitignore
```

The app is the one in [`examples/nextjs-slack`](../../examples/nextjs-slack),
which this repository builds on every change. With `--channel discord` it is
[`examples/nextjs-discord`](../../examples/nextjs-discord): the route Discord
calls, a second route that keeps a deployed bot connected, and its schedule.
Its README and `AGENTS.md` have Discord's own steps. With `--channel teams`
it is [`examples/nextjs-teams`](../../examples/nextjs-teams): the route Teams
calls, with Teams' own steps. Every other channel
(`--channel telegram`, `--channel whatsapp`, …) gets the app in
[`examples/nextjs-telegram`](../../examples/nextjs-telegram) with its own
name, package and settings in, and its own steps.

## After it runs

The app has an `AGENTS.md`, so a coding agent asked to "set this up" knows
the two commands, how to read what they answer, and what to hand back to you:
your Voiceflow key, the Slack sign-in, and whether to publish. By hand:

1. Make the Slack app: `npm run connect`. It signs you in to Slack, asks for
   your Voiceflow API key and project ID, and saves them in `.env.local`.
   Then it asks whether to publish the environment, and the bot messages you
   in Slack.
2. Start it: `npm run dev`. It opens a tunnel, starts the server, and points
   Slack at it.

The new app's README has each step in full.

## Options

| Option | What it does |
|---|---|
| `[name]` | The app's folder, and its name. Default: `my-bot`. |
| `--channel <channel>` | The channel to start with: `slack` (the default), or any channel in the [table of channels](../../README.md#channels), by its package's name: `discord`, `teams`, `telegram`, `whatsapp`, … |
| `--project <id>` | Your Voiceflow project's ID, written to `.env.local`. |
| `--environment <alias>` | The Voiceflow environment the bot talks to. Default: `development`. |
| `--pm <manager>` | Install with `npm`, `pnpm`, `yarn` or `bun`. Default: the one that ran this. |
| `-y, --yes` | Ask nothing and take the defaults. |
| `-f, --force` | Write into a folder that isn't empty. Nothing in it is deleted. |
| `-s, --skip-install` | Don't install the dependencies. |
| `--no-git` | Don't start a git repository. |
| `-q, --quiet` | Print only errors and what to do next. |

With npm, put `--` before the options: `npm create @voiceflow/channels-sdk@latest -- my-bot --pm pnpm`.

## What it doesn't do

- **It asks for no secret.** The app's `connect` command, which you run next,
  is what asks for your Voiceflow API key: in a hidden prompt, saved in
  `.env.local` beside the Slack app's credentials. Or put it there yourself
  first, and it isn't asked for.
- **It writes only in the folder you name**, and runs only your package
  manager's install and `git init`.
- **It asks nothing of a script.** Run without a terminal, as a coding agent
  runs it, it takes the defaults.

## License

MIT, in [LICENSE](LICENSE).
