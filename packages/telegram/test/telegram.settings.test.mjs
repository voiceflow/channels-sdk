// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("Telegram's settings: the bot's token comes from BotFather; the webhook's secret is the person's to choose, so connect makes it", () => {
  assert.deepEqual(settings, { needed: ['TELEGRAM_BOT_TOKEN'], made: ['TELEGRAM_WEBHOOK_SECRET_TOKEN'] });
});
