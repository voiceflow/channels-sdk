// The bot: your Voiceflow agent, and the channels it's in.

import { createMemoryState } from '@chat-adapter/state-memory';
import { createRedisState } from '@chat-adapter/state-redis';
import { type Channels, createChannels } from '@voiceflow/channelkit';
import { telegram } from '@voiceflow/channelkit-telegram';

let channels: Promise<Channels> | undefined;

// Made on the first request, once per server instance, and never at build time.
export function bot(): Promise<Channels> {
  channels ??= createChannels({
    voiceflow: {
      apiKey: process.env.VOICEFLOW_API_KEY!,
      projectID: process.env.VOICEFLOW_PROJECT_ID!,
      environment: process.env.VOICEFLOW_ENVIRONMENT ?? 'production',
    },
    // Telegram. The adapter reads its settings from the environment: .env.example names each one.
    channels: [telegram()],
    // A conversation's state lives here. Memory is fine on your machine; use
    // Redis anywhere that runs more than one instance or restarts.
    state: process.env.REDIS_URL ? createRedisState({ url: process.env.REDIS_URL }) : createMemoryState(),
  });
  return channels;
}
