// Written by scripts/channels.mjs: change the template there, not this file.
// `connect instagram`, `point instagram` and `disconnect instagram`. Node only: import it
// from `@voiceflow/channelkit-instagram/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';

export const { cli, connected, settings } = channelCommands('instagram', {
  settings: [
    {
      key: 'INSTAGRAM_VERIFY_TOKEN',
      description: "The token Meta sends back when it checks your server's address: any text of your own, entered as the webhook's verify token.",
      make: true,
    },
  ],
  addressGoes: "Meta's app dashboard, in the Instagram product's webhook settings, with INSTAGRAM_VERIFY_TOKEN as the verify token",
});
