// The `voiceflow-channels` bin as a person runs it: its own Node process, with
// the arguments after the script's name, as npm's shims start it. Node reads
// `--env-file` there itself and exits before the command starts when the file
// isn't there yet (nodejs/node#54232), so the env file's flag is `--dotenv`,
// and `--env-file` still works for a file that is. Nothing here reaches the
// network: `dev` is stopped by a port that isn't one, after it has read its flags.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const BIN = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Runs the bin in `cwd` and answers its exit code and what it printed. */
async function bin(args, cwd) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, NODE_OPTIONS: '' } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("an env file that isn't there yet is one the command starts with: connect makes it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vfc-bin-'));
  const ran = await bin(['dev', '--dotenv', '.env.local', '--port', 'not-a-port'], cwd);
  assert.doesNotMatch(ran.stderr, /^node: /m, 'Node itself stopped the command');
  assert.equal(ran.code, 2, ran.stderr);
  assert.match(ran.stderr, /"not-a-port" isn't a port\./);
  assert.doesNotMatch(ran.stderr, /--env-file/);
});

test('--env-file still works for a file that is there, and says the flag is --dotenv now', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vfc-bin-'));
  await writeFile(join(cwd, '.env.local'), 'PORT=3000\n');
  const ran = await bin(['dev', '--env-file', '.env.local', '--port', 'not-a-port'], cwd);
  assert.equal(ran.code, 2, ran.stderr);
  assert.match(ran.stderr, /--env-file is now --dotenv/);
  assert.match(ran.stderr, /"not-a-port" isn't a port\./);
});

test("the bin's help names --dotenv, never --env-file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'vfc-bin-'));
  const ran = await bin(['dev', '--help'], cwd);
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /--dotenv <path>/);
  assert.doesNotMatch(ran.stdout, /--env-file/);
});
