// Gives Telegram your server's address. No page of Telegram's takes one: a
// bot's webhook is set with a call to the Bot API (setWebhook), along with the
// secret Telegram is to send back on every request, which is how the server
// knows a request is Telegram's.
import { NeedsYou } from '@voiceflow/channelkit';
import type { ChannelSetup } from '@voiceflow/channelkit/connect';

type Point = NonNullable<ChannelSetup['point']>;
type Remove = NonNullable<ChannelSetup['remove']>;

/** What the adapter acts on. Telegram sends only these, whatever an earlier webhook of this bot asked for. */
const UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'message_reaction'];

async function call(method: string, body: Record<string, unknown>, { env, fetch }: Parameters<Remove>[0]): Promise<void> {
  const base = (env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // The address of this call holds the bot's token, and a failed request's message can hold its address: say only that it failed.
    throw new Error(`Telegram couldn't be reached (${method}). Nothing was changed.`);
  }
  const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (response.ok && answer.ok) return;
  if (response.status === 401 || response.status === 404) {
    throw new NeedsYou(
      "Telegram doesn't know this bot token. Copy it again from BotFather (/mybots → your bot → API Token) into TELEGRAM_BOT_TOKEN, then run this again.",
    );
  }
  throw new Error(`Telegram refused (${method}, HTTP ${response.status}): ${answer.description ?? 'it gave no reason'}. Nothing was changed.`);
}

export const point: Point = async ({ url, env, fetch }) => {
  await call('setWebhook', { url, secret_token: env.TELEGRAM_WEBHOOK_SECRET_TOKEN, allowed_updates: UPDATES }, { env, fetch });
  return `+ Telegram sends your bot's messages to ${url}`;
};

export const remove: Remove = async (io) => {
  await call('deleteWebhook', {}, io);
  return "- Telegram no longer sends your bot's messages to your server";
};
