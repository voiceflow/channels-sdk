// Written by scripts/channels.mjs: change the template there, not this file.
// `connect telegram`, `point telegram` and `disconnect telegram`. Node only: import it
// from `@voiceflow/channelkit-telegram/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';
import { point, remove } from './point.js';

export const { cli, connected, settings } = channelCommands('telegram', {
  settings: [
    {
      key: 'TELEGRAM_WEBHOOK_SECRET_TOKEN',
      description: "The secret Telegram sends back with each message, which is how the server knows a message is Telegram's.",
      make: true,
    },
  ],
  point,
  remove,
});
