// An install updates a tool only when its version rises (an unedited one; see
// installTools), so a change to a tool's code that keeps its version never
// reaches an agent that already has the tool. Every tool's code is recorded
// here by version: changing it means raising the version and recording the new
// hash in test/tool-versions.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { codeHash } from '@voiceflow/channels-sdk/install';
import { slackTools } from '../dist/index.js';

const recorded = JSON.parse(readFileSync(new URL('./tool-versions.json', import.meta.url), 'utf8'));

test("a tool's code changes only with a higher version, so installs update it", () => {
  const tools = slackTools().tools;
  assert.deepEqual(Object.keys(recorded).sort(), tools.map((t) => t.name).sort(), 'every tool is recorded, and only those');
  for (const t of tools) {
    const versions = Object.keys(recorded[t.name]).map(Number);
    assert.equal(t.version, Math.max(...versions), `${t.name} is version ${t.version}: record its hash in test/tool-versions.json`);
    assert.equal(codeHash(t.code), recorded[t.name][t.version], `${t.name}'s code changed: raise its version and record the new hash`);
    const hashes = Object.values(recorded[t.name]);
    assert.equal(new Set(hashes).size, hashes.length, `${t.name}: each version's code differs from the last`);
  }
});

// A server that bundles and minifies this package (Next.js does, for a route)
// renames its functions, and functionSource refuses a renamed function. The bot
// never needs a tool's code, only an install does, so the code is built when
// it's read: importing the package never calls functionSource.
test("a tool's code is built when it's read, not when the package loads", () => {
  for (const t of slackTools().tools) {
    const code = Object.getOwnPropertyDescriptor(t, 'code');
    assert.equal(typeof code?.get, 'function', `${t.name}'s code is a getter`);
    assert.match(t.code, /export default async function main\(/, `${t.name}'s code reads as a Voiceflow function`);
  }
});
