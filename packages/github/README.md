# @voiceflow/channels-github

A Voiceflow agent in GitHub, with one command to set it up.

> **Status:** an early release. Expect changes between versions before 1.0.
> Built on Chat SDK's GitHub adapter.

## Connect

```bash
npx voiceflow-channels connect github --env-file .env.local
```

GitHub's side is made on GitHub's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the GitHub adapter](https://github.com/vercel/chat/tree/main/packages/adapter-github)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It makes `GITHUB_WEBHOOK_SECRET`**, a secret of your own that GitHub sends back with each message, and saves it to the env file.
- **It creates the `github_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give GitHub**: your server's public address, then `/api/github`. It goes in the repository's Settings → Webhooks → Add webhook, with content type application/json and GITHUB_WEBHOOK_SECRET from your env file as its Secret, or the GitHub App's Webhook URL and secret. `voiceflow-channels dev` prints the tunnel's each time it starts.
- **With nobody at the terminal** (a script, a coding agent) connect asks
  nothing. It stops with exit code 3 and says, in the one stop, everything a
  person has to do. Exit 0 is done, 1 a failure, 2 a mistake in the command.
- **`voiceflow-channels dev` runs connect for you** the first time, when a
  person is there. So in an app the starter made, `npm run dev` is the one
  command.
- **Nothing is published.** The variables are live once you publish the
  environment. `--publish` does that here: the whole draft goes live.
- **`--dry-run`** shows the plan and changes nothing.

## In your server

```ts
import { github } from '@voiceflow/channels-github';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [github()],
  state,
});
// One route takes everything: channels.webhook('github', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-github chat @chat-adapter/catalog @chat-adapter/github
```

### What happens in GitHub

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as cards, and one with choices as text, its choices numbered.
- **Each reply is posted whole**.
- **A long answer** goes as several messages, cut where the text breaks, at 65,000 characters.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `github({ follow: false })` has it answer only where it is mentioned.
- **Each reply is a comment of its own** on the issue or pull request.

### Settings

The adapter reads these from the environment. `github({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Yes | Webhook signing secret. |
| `GITHUB_BOT_USERNAME` | Yes | The bot's GitHub username, as people @mention it: the account the token is for, or the GitHub App's name with [bot]. |
| `GITHUB_WEBHOOK_SECRET` | Yes: connect makes it | The secret GitHub signs each request with: any text of your own, entered as the webhook's Secret. |
| `GITHUB_TOKEN` | One way to sign in (Personal access token) | Personal access token. |
| `GITHUB_APP_ID` | One way to sign in (GitHub App) | GitHub App ID. |
| `GITHUB_PRIVATE_KEY` | One way to sign in (GitHub App) | GitHub App private key. |
| `GITHUB_INSTALLATION_ID` | No | Installation ID for single-installation app deployments. |
| `GITHUB_BOT_USER_ID` | No | Numeric bot user ID for self-message detection; recommended on serverless and with Vercel Connect to prevent reply loops. |
| `GITHUB_API_URL` | No | Override the GitHub API base URL. |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The GitHub adapter's own config. |
| `context` | `true` | Set who and where as `github_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{github_user_name}`).

| Variable | What it holds |
|---|---|
| `github_user_id` | The GitHub ID of the person in this conversation. |
| `github_user_name` | The person's name in GitHub. Empty when GitHub doesn't say. |
| `github_thread_id` | The GitHub conversation this turn is in, as Chat SDK names it. |
| `github_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
