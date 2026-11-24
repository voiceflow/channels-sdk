// Everything Teams has for the bot arrives here, each request signed by
// Microsoft: a message in a chat or a channel, a button's click, the bot being
// added somewhere. The adapter checks the signature before anything is done.

import { after } from 'next/server';
import { bot } from './bot';

export async function POST(request: Request) {
  // The agent's turn can finish after the response: Teams is answered, and the work goes on.
  return (await bot()).webhook('teams', request, { waitUntil: (task) => after(() => task) });
}
