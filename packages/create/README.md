# create-voiceflow-channels

Start a Voiceflow agent in Slack with one command.

> **Status:** pre-release, local only. Not published. The package name is not final.

```bash
npm create voiceflow-channels@latest my-bot
```

It makes a folder with a small Next.js server: the route Slack calls, an env
file, and a `connect` script that makes the Slack app. `pnpm create`,
`yarn create` and `bunx create-voiceflow-channels` work the same way.

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
which this repository builds on every change.

## After it runs

1. Start a tunnel to port 3000, and log the Slack CLI in (`slack login`).
2. Make the Slack app: `npm run connect -- --public-url https://<your tunnel>`.
   It asks for your Voiceflow API key and project ID, and saves them in `.env.local`.
3. Publish the environment in Voiceflow.
4. `npm run dev`.

The new app's README has each step in full.

## Options

| Option | What it does |
|---|---|
| `[name]` | The app's folder, and its name. Default: `my-bot`. |
| `--channel <channel>` | The channel to start with. `slack` is the default, and the only one so far. |
| `--project <id>` | Your Voiceflow project's ID, written to `.env.local`. |
| `--environment <alias>` | The Voiceflow environment the bot talks to. Default: `development`. |
| `--pm <manager>` | Install with `npm`, `pnpm`, `yarn` or `bun`. Default: the one that ran this. |
| `-y, --yes` | Ask nothing and take the defaults. |
| `-f, --force` | Write into a folder that isn't empty. Nothing in it is deleted. |
| `-s, --skip-install` | Don't install the dependencies. |
| `--no-git` | Don't start a git repository. |
| `-q, --quiet` | Print only errors and what to do next. |

With npm, put `--` before the options: `npm create voiceflow-channels@latest -- my-bot --pm pnpm`.

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
