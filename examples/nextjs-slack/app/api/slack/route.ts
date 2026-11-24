// Slack sends every event, button click, dialog and slash command here, and
// the agent's Slack tools call here too: they run on this server, with its own
// SLACK_BOT_TOKEN. `connect slack` points both at <your public URL>/api/slack.

import { createMemoryState } from '@chat-adapter/state-memory';
import { createRedisState } from '@chat-adapter/state-redis';
import { type Channels, createChannels } from '@voiceflow/channelkit';
import { slack } from '@voiceflow/channelkit-slack';
import { after } from 'next/server';

let channels: Promise<Channels> | undefined;

// Made on the first request, once per server instance, and never at build time.
function bot(): Promise<Channels> {
  channels ??= createChannels({
    voiceflow: {
      apiKey: process.env.VOICEFLOW_API_KEY!,
      projectID: process.env.VOICEFLOW_PROJECT_ID!,
      environment: process.env.VOICEFLOW_ENVIRONMENT ?? 'production',
    },
    // Slack, with everything Slack has. The adapter reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.
    channels: [slack()],
    // A conversation's state lives here. Memory is fine on your machine; use
    // Redis anywhere that runs more than one instance or restarts.
    state: process.env.REDIS_URL ? createRedisState({ url: process.env.REDIS_URL }) : createMemoryState(),
  });
  return channels;
}

export async function POST(request: Request) {
  // Slack wants an answer within three seconds, so the agent's turn finishes after the response.
  // A tool's call is answered within the request: the agent is waiting for it.
  return (await bot()).webhook('slack', request, { waitUntil: (task) => after(() => task) });
}
