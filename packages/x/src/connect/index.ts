// Written by scripts/channels.mjs: change the template there, not this file.
// `connect x`, `point x` and `disconnect x`. Node only: import it
// from `@voiceflow/channelkit-x/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';

export const { cli, connected, settings } = channelCommands('x', {
  addressGoes: "in X's developer console, as a webhook subscribed to post.mention.create, dm.received and dm.sent",
});
