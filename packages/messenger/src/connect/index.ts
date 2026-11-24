// Written by scripts/channels.mjs: change the template there, not this file.
// `connect messenger`, `point messenger` and `disconnect messenger`. Node only: import it
// from `@voiceflow/channelkit-messenger/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';

export const { cli, connected, settings } = channelCommands('messenger', {
  settings: [
    {
      key: 'FACEBOOK_VERIFY_TOKEN',
      description: "The token Meta sends back when it checks your server's address: any text of your own, entered as the webhook's Verify Token.",
      make: true,
    },
  ],
  addressGoes: "the Meta app's dashboard → Messenger API Settings → Configure webhooks → Callback URL, with FACEBOOK_VERIFY_TOKEN as the Verify Token",
});
