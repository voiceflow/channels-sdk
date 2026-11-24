// Deployed only: holds Discord's standing connection, which is how the bot is
// sent what people write. Discord has no address to send messages to, so
// something has to stay connected. A scheduler calls this route every nine
// minutes, and each call holds the connection for ten: the two overlap, so
// there is always one. vercel.json is that schedule on Vercel.
//
// On your machine this isn't used: `voiceflow-channelkit dev` holds the connection.

import { after } from 'next/server';
import { bot } from '../bot';

// Ten minutes of connection, and a little to start and stop in.
export const maxDuration = 800;
const HOLD_MS = 600_000;

export async function GET(request: Request): Promise<Response> {
  // Only your scheduler may start a connection: it sends this secret. Vercel's cron sends CRON_SECRET by itself.
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response('CRON_SECRET is not set', { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });

  const channels = await bot();
  await channels.bot.initialize();
  // Each event is passed on to the route beside this one, on this same deployment.
  const webhookUrl = `${new URL(request.url).origin}/api/discord`;
  return channels.bot.getAdapter('discord').startGatewayListener({ waitUntil: (task: Promise<unknown>) => after(() => task) }, HOLD_MS, undefined, webhookUrl);
}
