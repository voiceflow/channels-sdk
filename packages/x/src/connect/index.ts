// Written by scripts/channels.mjs: change the template there, not this file.
// `connect x`, `point x` and `disconnect x`. Node only: import it
// from `@voiceflow/channels-x/connect`.
import { channelCommands } from '@voiceflow/channels-sdk/connect';

export const { cli, connected, settings } = channelCommands('x', {
  addressGoes: "in X's developer console, as a webhook subscribed to post.mention.create, dm.received and dm.sent",
});
