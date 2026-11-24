# @voiceflow/channels-gitlab

A Voiceflow agent in GitLab, with one command to set it up.

> **Status:** pre-release, local only. Not published. The package name is not final.
> Built on Chat SDK's GitLab adapter.

## Connect

```bash
npx voiceflow-channels connect gitlab --env-file .env.local
```

GitLab's side is made on GitLab's own pages: its app or bot, and the
settings below. [Chat SDK's guide to the GitLab adapter](https://github.com/vercel/chat/tree/main/packages/adapter-gitlab)
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
- **It creates the `gitlab_*` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **It says what address to give GitLab**: your server's public address, then `/api/gitlab`. It goes in the project's or group's Settings → Webhooks → Add new webhook → URL, with the Comments trigger. `voiceflow-channels dev` prints the tunnel's each time it starts.
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
import { gitlab } from '@voiceflow/channels-gitlab';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [gitlab()],
  state,
});
// One route takes everything: channels.webhook('gitlab', request, { waitUntil })
```

Install it with Chat SDK's adapter:

```bash
npm install @voiceflow/channels-sdk @voiceflow/channels-gitlab chat @chat-adapter/catalog @chat-adapter/gitlab
```

### What happens in GitLab

- **Choices** from the agent are a numbered list: a person answers with the number, or the words.
- **Cards and carousels** are shown as cards, and one with choices as text, its choices numbered.
- **Each reply is posted whole**.
- **A long answer** goes as several messages, cut where the text breaks, at 950,000 characters.
- **After a mention, the bot goes on answering** in that conversation without being mentioned again. `gitlab({ follow: false })` has it answer only where it is mentioned.

### Settings

The adapter reads these from the environment. `gitlab({ adapter: { … } })`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
| `GITLAB_TOKEN` | Yes | Personal, project, or group access token with the api scope. |
| `GITLAB_WEBHOOK_SIGNING_TOKEN` | One way to sign in (Webhook signing token) | Webhook signing token (whsec_...) for HMAC signature verification. GitLab 19.0 and later. |
| `GITLAB_WEBHOOK_SECRET` | One way to sign in (Webhook secret token) | Webhook secret token, compared against the X-Gitlab-Token header. |
| `GITLAB_BOT_USERNAME` | No | Bot username for mention detection. Defaults to the token user's username. |
| `GITLAB_BOT_USER_ID` | No | Numeric bot user ID for self-message detection. Defaults to the token user's ID; recommended on serverless to prevent reply loops. |
| `GITLAB_API_URL` | No | GitLab REST API base URL for Self-Managed or Dedicated instances (default https://gitlab.com/api/v4). |

### Options

| Option | Default | What it does |
|---|---|---|
| `adapter` | the environment | The GitLab adapter's own config. |
| `context` | `true` | Set who and where as `gitlab_*` variables on every turn. |
| `follow` | `true` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (`{gitlab_user_name}`).

| Variable | What it holds |
|---|---|
| `gitlab_user_id` | The GitLab ID of the person in this conversation. |
| `gitlab_user_name` | The person's name in GitLab. Empty when GitLab doesn't say. |
| `gitlab_thread_id` | The GitLab conversation this turn is in, as Chat SDK names it. |
| `gitlab_message_id` | The ID of the person's latest message. Empty when the turn came from a button. |
