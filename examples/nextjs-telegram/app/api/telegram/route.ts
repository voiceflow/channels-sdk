// Everything Telegram has for the bot arrives here. The adapter checks each
// request is Telegram's before anything is done.

import { after } from 'next/server';
import { bot } from './bot';

export async function POST(request: Request) {
  // The agent's turn can finish after the response: Telegram is answered, and the work goes on.
  return (await bot()).webhook('telegram', request, { waitUntil: (task) => after(() => task) });
}

// Some platforms check an address with a GET before they send to it: the adapter answers that too.
export async function GET(request: Request) {
  return (await bot()).webhook('telegram', request);
}
