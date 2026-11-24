// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("GitHub's settings: the bot's own name, as people mention it, is the person's to say; the webhook's secret is theirs to choose, so connect makes it", () => {
  assert.deepEqual(settings, { needed: ['GITHUB_BOT_USERNAME', 'GITHUB_TOKEN'], made: ['GITHUB_WEBHOOK_SECRET'] });
});
