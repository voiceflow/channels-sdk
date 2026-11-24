// What connect asks a person for, and what it makes itself, said here once by hand: a setting moved from one
// list to the other is a different setup, and a test should have to be changed to make it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settings } from '../dist/connect/index.js';

test("GitLab's settings: GitLab makes the signing token", () => {
  assert.deepEqual(settings, { needed: ['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SIGNING_TOKEN'], made: [] });
});
