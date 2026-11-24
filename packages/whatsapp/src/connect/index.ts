// Written by scripts/channels.mjs: change the template there, not this file.
// `connect whatsapp`, `point whatsapp` and `disconnect whatsapp`. Node only: import it
// from `@voiceflow/channelkit-whatsapp/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';

export const { cli, connected, settings } = channelCommands('whatsapp', {
  settings: [
    {
      key: 'WHATSAPP_VERIFY_TOKEN',
      description: "The token Meta sends back when it checks your server's address: any text of your own, entered as the webhook's Verify token.",
      make: true,
    },
  ],
  addressGoes: "the Meta app's dashboard → WhatsApp → Configuration → Callback URL, with WHATSAPP_VERIFY_TOKEN as the Verify token, subscribed to messages",
});
