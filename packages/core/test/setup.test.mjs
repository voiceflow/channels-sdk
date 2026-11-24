// What every channel's command shares that isn't covered through a channel's own tests: when a page may be
// opened in a browser, and what may be opened.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { canOpenBrowser, openInBrowser } from '../dist/setup.js';

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
