// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("Linear's settings: Linear gives the webhook its secret, and the bot's name is the person's to say", () => {
  assert.deepEqual(settings, { needed: ['LINEAR_WEBHOOK_SECRET', 'LINEAR_BOT_USERNAME', 'LINEAR_API_KEY'], made: [] });
});
