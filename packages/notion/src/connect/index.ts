// Written by scripts/channels.mjs: change the template there, not this file.
// `connect notion`, `point notion` and `disconnect notion`. Node only: import it
// from `@voiceflow/channels-notion/connect`.
import { channelCommands } from '@voiceflow/channels-sdk/connect';

export const { cli, connected, settings } = channelCommands('notion', {
  settings: [{ key: 'NOTION_BOT_USERNAME', description: "The bot's name in Notion, as people write it after an @ in a comment." }],
  later: {
    NOTION_VERIFICATION_TOKEN:
      "Notion sends it to your server as the webhook is saved, and the server's log shows it. Paste it into Notion to verify the subscription, set it here, and start the server again.",
  },
  addressGoes: "the Webhooks tab of the connection's own page in Notion → Create a subscription, with comment.created among its events",
});
