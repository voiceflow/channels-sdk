// Written by scripts/channels.mjs: change the template there, not this file.
// `connect gchat`, `point gchat` and `disconnect gchat`. Node only: import it
// from `@voiceflow/channelkit-gchat/connect`.
import { channelCommands } from '@voiceflow/channelkit/connect';

export const { cli, connected, settings } = channelCommands('gchat', {
  settings: [{ key: 'GOOGLE_CHAT_PROJECT_NUMBER', description: "Your Google Cloud project's number: requests from Google Chat are signed for it." }],
  addressGoes: 'the Google Cloud console → Google Chat API → Configuration → Connection settings → App URL, with Authentication audience set to Project number',
});
