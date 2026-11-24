// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("X's settings: the app's secret and a way to sign in", () => {
  assert.deepEqual(settings, { needed: ['X_CONSUMER_SECRET', 'X_USER_ACCESS_TOKEN'], made: [] });
});
