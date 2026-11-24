// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("Notion's settings: the verification token is not asked for: Notion sends it only once it has the server's address", () => {
  assert.deepEqual(settings, { needed: ['NOTION_TOKEN', 'NOTION_BOT_USERNAME'], made: [] });
});
