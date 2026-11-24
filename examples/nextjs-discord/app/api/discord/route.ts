// Everything Discord has for the bot arrives here. Slash commands and button
// clicks come from Discord itself, signed with the app's key. What people
// write comes over Discord's standing connection, and is passed on to this
// route by whatever holds that connection: `voiceflow-channels dev` on your
// machine, the route beside this one (gateway/route.ts) once deployed.

import { after } from 'next/server';
import { bot } from './bot';

export async function POST(request: Request) {
  // Discord wants an answer within three seconds, so the agent's turn finishes after the response.
  return (await bot()).webhook('discord', request, { waitUntil: (task) => after(() => task) });
}
