// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("Google Chat's settings: the project number is what a request from Google Chat is checked against", () => {
  assert.deepEqual(settings, { needed: ['GOOGLE_CHAT_PROJECT_NUMBER', 'GOOGLE_CHAT_CREDENTIALS'], made: [] });
});
