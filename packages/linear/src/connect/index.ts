// Written by scripts/channels.mjs: change the template there, not this file.
// `connect linear`, `point linear` and `disconnect linear`. Node only: import it
// from `@voiceflow/channelkit-linear/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';

export const { cli, connected, settings } = channelCommands('linear', {
  settings: [{ key: 'LINEAR_BOT_USERNAME', description: "The bot's name in Linear, as people @mention it." }],
  addressGoes: "Linear's Settings → API → Create webhook, with Comments among its events; its signing secret is LINEAR_WEBHOOK_SECRET",
});
