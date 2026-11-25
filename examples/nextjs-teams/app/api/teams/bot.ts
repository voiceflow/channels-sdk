// The bot: your Voiceflow agent, and the channels it's in.

import { createMemoryState } from '@chat-adapter/state-memory';
import { createRedisState } from '@chat-adapter/state-redis';
import { type Channels, createChannels } from '@voiceflow/channels-sdk';
import { teams } from '@voiceflow/channels-teams';

let channels: Promise<Channels> | undefined;

// Made on the first request, once per server instance, and never at build time.
export function bot(): Promise<Channels> {
  channels ??= createChannels({
    voiceflow: {
      apiKey: process.env.VOICEFLOW_API_KEY!,
      projectID: process.env.VOICEFLOW_PROJECT_ID!,
      environment: process.env.VOICEFLOW_ENVIRONMENT ?? 'production',
    },
    // Teams. The adapter reads TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_APP_TENANT_ID.
    channels: [teams()],
    // A conversation's state lives here. Memory is fine on your machine; use
    // Redis anywhere that runs more than one instance or restarts.
    state: process.env.REDIS_URL ? createRedisState({ url: process.env.REDIS_URL }) : createMemoryState(),
  });
  return channels;
}
