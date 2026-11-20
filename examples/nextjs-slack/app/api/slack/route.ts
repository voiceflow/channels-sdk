// Slack sends every event, button click, dialog and slash command here.
// `connect slack` points the app at <your public URL>/api/slack.
import { after } from 'next/server';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createRedisState } from '@chat-adapter/state-redis';
import { createChannels, type Channels } from '@voiceflow/channels-sdk';
import { slack } from '@voiceflow/channels-slack';

let channels: Promise<Channels> | undefined;

// Made on the first request, once per server instance, and never at build time.
function bot(): Promise<Channels> {
  channels ??= createChannels({
    voiceflow: {
      apiKey: process.env.VOICEFLOW_API_KEY!,
      projectID: process.env.VOICEFLOW_PROJECT_ID!,
      environment: process.env.VOICEFLOW_ENVIRONMENT ?? 'production',
    },
    // Slack at full fidelity. The adapter reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.
    channels: [slack()],
    // A conversation's state lives here. Memory is fine on your machine; use
    // Redis anywhere that runs more than one instance or restarts.
    state: process.env.REDIS_URL ? createRedisState({ url: process.env.REDIS_URL }) : createMemoryState(),
  });
  return channels;
}

export async function POST(request: Request) {
  // Slack wants an answer within three seconds, so the agent's turn finishes after the response.
  return (await bot()).webhook('slack', request, { waitUntil: (task) => after(() => task) });
}
