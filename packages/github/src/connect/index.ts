// Written by scripts/channels.mjs: change the template there, not this file.
// `connect github`, `point github` and `disconnect github`. Node only: import it
// from `@voiceflow/channelkit-github/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';

export const { cli, connected, settings } = channelCommands('github', {
  settings: [
    {
      key: 'GITHUB_BOT_USERNAME',
      description: "The bot's GitHub username, as people @mention it: the account the token is for, or the GitHub App's name with [bot].",
    },
    {
      key: 'GITHUB_WEBHOOK_SECRET',
      description: "The secret GitHub signs each request with: any text of your own, entered as the webhook's Secret.",
      make: true,
    },
  ],
  addressGoes:
    "the repository's Settings → Webhooks → Add webhook, with content type application/json and GITHUB_WEBHOOK_SECRET from your env file as its Secret, or the GitHub App's Webhook URL and secret",
});
