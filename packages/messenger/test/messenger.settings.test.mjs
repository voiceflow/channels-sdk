// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("Messenger's settings: the verify token is the person's to choose, so connect makes it", () => {
  assert.deepEqual(settings, { needed: ['FACEBOOK_APP_SECRET', 'FACEBOOK_PAGE_ACCESS_TOKEN'], made: ['FACEBOOK_VERIFY_TOKEN'] });
});
