// What every channel's command shares that isn't covered through a channel's own tests: when a page may be
// opened in a browser, what may be opened, and which values are written to an env file as they are.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BARE, canOpenBrowser, openInBrowser, readEnvFile, saveEnv } from '../dist/setup.js';

test("a page is opened only where the browser would be the person's own", () => {
  assert.equal(canOpenBrowser({}, 'darwin'), true);
  assert.equal(canOpenBrowser({}, 'win32'), true);
  // Over SSH it would open on the far machine, where nobody is looking.
  for (const name of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT']) assert.equal(canOpenBrowser({ [name]: '10.0.0.2 51000 10.0.0.9 22' }, 'darwin'), false, name);
  assert.equal(canOpenBrowser({ CI: 'true' }, 'darwin'), false);
  // On Linux, only with a display to open it on.
  assert.equal(canOpenBrowser({}, 'linux'), false);
  assert.equal(canOpenBrowser({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
  assert.equal(canOpenBrowser({}, 'freebsd'), false);
});

/** A stand-in for `spawn`: it records what would be run, and starts or fails as told. Nothing is ever opened. */
function fakeSpawn(outcome = 'spawn') {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit(outcome, outcome === 'error' ? new Error('spawn ENOENT') : undefined));
    return child;
  };
  return { run, calls };
}

test("a page is opened with the platform's own opener, and the link is passed as it is, through no shell", async () => {
  const url = 'https://discord.com/oauth2/authorize?client_id=1&scope=bot+applications.commands&permissions=8&guild_id=2';
  for (const [platform, command, args] of [
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', url]],
  ]) {
    const fake = fakeSpawn();
    assert.equal(await openInBrowser(url, platform, fake.run), true);
    assert.deepEqual(
      fake.calls.map((c) => [c.command, c.args]),
      [[command, args]],
    );
    assert.ok(!fake.calls[0].options.shell, 'the link went through a shell');
  }
});

test('only a web page is ever opened, and failing to is an answer, not an error', async () => {
  const fake = fakeSpawn();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'discord://x', '/tmp/a.html', ''])
    assert.equal(await openInBrowser(url, 'darwin', fake.run), false, url);
  assert.deepEqual(fake.calls, []);
  // No opener on this machine: it says it couldn't, and throws nothing.
  assert.equal(await openInBrowser('https://example.com/', 'linux', fakeSpawn('error').run), false);
  assert.equal(
    await openInBrowser('https://example.com/', 'linux', () => {
      throw new Error('spawn failed');
    }),
    false,
  );
});

test('a value with a "~" is saved as it is, except where a shell would read the "~" as a home folder', async () => {
  // Microsoft's app secrets have a "~" in the middle: every env file parser, and a shell, reads it as written.
  for (const value of ['abc8Q~def-GHI_jkl.mno', 'a~b~c', 'key=va~lue']) assert.ok(BARE.test(value), value);
  // First, or after a colon, a shell makes it a home folder; a space, a quote, a "#" or a "$" each read as something else.
  for (const value of ['~abc', 'path:~/bin', 'two words', 'say"hi"', 'a#b', 'cost$5', '']) assert.ok(!BARE.test(value), value);

  const dir = await mkdtemp(join(tmpdir(), 'setup-env-'));
  const envFile = join(dir, '.env.local');
  await writeFile(envFile, 'KEPT=as-it-was\n');
  const out = [];
  const err = [];
  const saved = await saveEnv(
    { envFile, inFile: { KEPT: 'as-it-was' } },
    [
      ['SECRET', 'abc8Q~def-GHI_jkl.mno'],
      ['KEPT', 'something-else'],
      ['HOME_LIKE', '~abc'],
      ['EMPTY', ''],
    ],
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  assert.deepEqual(saved, ['SECRET']);
  assert.deepEqual(await readEnvFile(envFile), { KEPT: 'as-it-was', SECRET: 'abc8Q~def-GHI_jkl.mno' });
  assert.deepEqual(out, [`+ saved SECRET to ${envFile}`]);
  assert.deepEqual(err, [`! HOME_LIKE wasn't saved to ${envFile}: its value needs quoting there. Add it yourself.`]);
});
