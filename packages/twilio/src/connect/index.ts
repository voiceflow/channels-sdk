// Written by scripts/channels.mjs: change the template there, not this file.
// `connect twilio`, `point twilio` and `disconnect twilio`. Node only: import it
// from `@voiceflow/channels-twilio/connect`.
import { channelCommands } from '@voiceflow/channels-sdk/connect';

export const { cli, connected, settings } = channelCommands('twilio', {
  addressGoes: 'Console → Phone Numbers → Active numbers → your number → A message comes in',
});
