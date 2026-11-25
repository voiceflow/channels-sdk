// Written by scripts/channels.mjs: change the template there, not this file.
// `connect gitlab`, `point gitlab` and `disconnect gitlab`. Node only: import it
// from `@voiceflow/channels-gitlab/connect`.
import { channelCommands } from '@voiceflow/channels-sdk/connect';

export const { cli, connected, settings } = channelCommands('gitlab', {
  addressGoes: "the project's or group's Settings → Webhooks → Add new webhook → URL, with the Comments trigger",
});
