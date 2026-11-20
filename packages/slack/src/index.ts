// Voiceflow agents in Slack at full fidelity. Everything channel-neutral
// comes from @voiceflow/channels-sdk; this package adds what only Slack has.
import type { ChannelSpec } from '@voiceflow/channels-sdk';

/** Slack as a channel for `createChannels`. `options` is the Slack adapter's own config. */
export function slack(options?: Record<string, unknown>): ChannelSpec {
  return options === undefined ? 'slack' : { slug: 'slack', options };
}
