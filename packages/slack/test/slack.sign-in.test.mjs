// The Slack sign-in connect needs: an expired login refreshed, a workspace
// picked, `slack login` run, the Slack CLI's installer offered, and, with
// nobody at the terminal, a stop that says what a person has to do.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NeedsYou, SLACK_CLI_INSTALL, SLACK_CLI_INSTALL_WINDOWS, SlackApiError, slackSignIn } from '../dist/connect/index.js';

const CLI = '/fake/bin/slack';

/**
 * A machine with a Slack CLI on it, or without: its logins in a file, and each
 * command it's asked to run recorded and played as the real CLI would.
 *   `refresh`  what `slack auth list` renews: { T1: 'new-token' }
 *   `login`    what `slack login` signs in to: { teamId, token, domain }
 *   `code`     the code Slack shows for the ticket
 *   `install`  whether Slack's installer works
 */
async function machine({ logins = {}, cli = true, platform = 'darwin', refresh = {}, login, code = 'CODE1', install = true, expired = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vf-signin-'));
  const credentialsFile = join(dir, 'credentials.json');
  const write = (all) => writeFile(credentialsFile, JSON.stringify(all));
  const read = async () => JSON.parse(await readFile(credentialsFile, 'utf8').catch(() => '{}'));
  if (Object.keys(logins).length) await write(Object.fromEntries(Object.entries(logins).map(([id, l]) => [id, { token: l.token, team_domain: l.domain }])));
  const signIn = async () => {
    if (login) await write({ ...(await read()), [login.teamId]: { token: login.token, team_domain: login.domain } });
  };
  const ran = [];
  const said = [];
  const asked = [];
  let installed = cli;
  const host = {
    credentialsFile,
    platform,
    find: () => (installed ? CLI : undefined),
    run: async (command, args, { show }) => {
      ran.push({ line: [command, ...args].join(' '), show });
      if (command === 'bash') {
        if (install) installed = true;
        return { code: install ? 0 : 7, output: '' };
      }
      const line = args.filter((arg) => arg !== '--skip-update').join(' ');
      if (line === 'auth list') {
        const all = await read();
        for (const [id, token] of Object.entries(refresh)) if (all[id]) all[id].token = token;
        await write(all);
        return { code: 0, output: 'T1\n' };
      }
      if (line === 'login') {
        await signIn();
        return { code: login ? 0 : 1, output: '' };
      }
      if (line === 'login --no-prompt') {
        return { code: 0, output: '\nRun the following slash command in any Slack channel or DM\n\n/slackauthticket TICKET1\n\n' };
      }
      if (line === `login --no-prompt --ticket TICKET1 --challenge ${code}`) {
        await signIn();
        return { code: 0, output: '' };
      }
      if (line.startsWith('login --no-prompt --ticket')) return { code: 1, output: 'Error: invalid challenge code\n' };
      throw new Error(`the test's Slack CLI doesn't know: ${line}`);
    },
  };
  const options = (more = {}) => ({
    interactive: false,
    ask: async (question) => {
      asked.push(question);
      if (!('answer' in more)) throw new Error(`asked "${question}" with no answer to give`);
      return more.answer;
    },
    say: (line) => said.push(line),
    check: async (l) => {
      if (expired.includes(l.token)) throw new SlackApiError('auth.test', 'token_expired');
    },
    host,
    ...more,
  });
  return { options, ran, said, asked, read };
}

const lines = (m) => m.ran.map((r) => r.line);

test('a login Slack accepts is used as it is: nothing is run and nothing is asked', async () => {
  const m = await machine({ logins: { T1: { token: 'tok-1', domain: 'acme' } } });
  assert.deepEqual(await slackSignIn(m.options()), { teamId: 'T1', token: 'tok-1', teamDomain: 'acme' });
  assert.deepEqual(m.ran, []);
  assert.deepEqual(m.asked, []);
});

test('an expired login is refreshed by the CLI, with nobody asked', async () => {
  const m = await machine({ logins: { T1: { token: 'old' } }, expired: ['old'], refresh: { T1: 'new' } });
  assert.equal((await slackSignIn(m.options())).token, 'new');
  assert.deepEqual(m.ran, [{ line: `${CLI} --skip-update auth list`, show: false }]);
  assert.deepEqual(m.said, []);
});

test("a login the CLI can't refresh is made again: by you at the terminal, or said to a script", async () => {
  const dead = { logins: { T1: { token: 'old' } }, expired: ['old'] };
  const person = await machine({ ...dead, login: { teamId: 'T1', token: 'fresh' } });
  assert.equal((await slackSignIn(person.options({ interactive: true }))).token, 'fresh');
  assert.deepEqual(lines(person), [`${CLI} --skip-update auth list`, `${CLI} --skip-update login`]);
  assert.equal(person.ran[1].show, true, 'you see `slack login` and answer it');
  assert.match(person.said.join('\n'), /Your Slack CLI login for T1 has expired\./);

  const script = await machine(dead);
  await assert.rejects(slackSignIn(script.options()), (error) => error instanceof NeedsYou && /\/slackauthticket TICKET1/.test(error.message));
});

test('an error from Slack that is no expiry stops it there', async () => {
  const m = await machine({ logins: { T1: { token: 'tok-1' } } });
  const check = async () => {
    throw new SlackApiError('auth.test', 'ratelimited');
  };
  await assert.rejects(slackSignIn(m.options({ check })), /auth\.test: ratelimited/);
  assert.deepEqual(m.ran, []);
});

test('with several logins, the workspace is the one named, or the one you pick', async () => {
  const logins = { T1: { token: 'tok-1', domain: 'acme' }, T2: { token: 'tok-2', domain: 'globex' } };
  const named = await machine({ logins });
  assert.equal((await slackSignIn(named.options({ team: 'T2' }))).token, 'tok-2');
  assert.deepEqual(named.asked, []);

  const byNumber = await machine({ logins });
  assert.equal((await slackSignIn(byNumber.options({ interactive: true, answer: ' 2 ' }))).teamId, 'T2');
  assert.deepEqual(byNumber.asked, ['Which one? [1-2] ']);
  assert.match(byNumber.said.join('\n'), / {2}1\. T1 acme\n {2}2\. T2 globex/);

  const byName = await machine({ logins });
  assert.equal((await slackSignIn(byName.options({ interactive: true, answer: 'acme' }))).teamId, 'T1');

  const wrong = await machine({ logins });
  await assert.rejects(slackSignIn(wrong.options({ interactive: true, answer: '3' })), /"3" isn't one of them/);

  // A script can't be asked: it's told how to say which.
  const script = await machine({ logins });
  await assert.rejects(
    slackSignIn(script.options()),
    (error) => !(error instanceof NeedsYou) && /several workspaces: name one with --team \(T1 acme, T2 globex\)/.test(error.message),
  );
  assert.deepEqual(script.ran, []);
});

test('with no login, `slack login` is run for you, and the workspace you signed in to is the one used', async () => {
  const m = await machine({ login: { teamId: 'T9', token: 'tok-9', domain: 'new' } });
  assert.deepEqual(await slackSignIn(m.options({ interactive: true })), { teamId: 'T9', token: 'tok-9', teamDomain: 'new' });
  assert.deepEqual(m.ran, [{ line: `${CLI} --skip-update login`, show: true }]);
  assert.deepEqual(m.asked, []);

  // Logged in elsewhere already, and a workspace named that the CLI doesn't have: the new login is the one, with no question.
  const second = await machine({ logins: { T1: { token: 'tok-1' }, T2: { token: 'tok-2' } }, login: { teamId: 'T9', token: 'tok-9' } });
  assert.equal((await slackSignIn(second.options({ interactive: true, team: 'T9' }))).token, 'tok-9');
  assert.deepEqual(second.asked, []);

  // `slack login` given up on is an error, not a login.
  const gaveUp = await machine({});
  await assert.rejects(slackSignIn(gaveUp.options({ interactive: true })), /`slack login` didn't finish \(it exited 1\)/);
});

test('with nobody at the terminal, it asks Slack for a ticket and stops with what to do and how to carry on', async () => {
  const m = await machine({});
  await assert.rejects(slackSignIn(m.options()), (error) => {
    assert.ok(error instanceof NeedsYou);
    assert.match(error.message, /Paste this into any Slack channel or DM, and approve what it shows:\n\n {2}\/slackauthticket TICKET1\n/);
    assert.match(error.message, /Run this again with it, adding:\n\n {2}--slack-ticket TICKET1 --slack-code <the code>$/);
    return true;
  });
  assert.deepEqual(m.ran, [{ line: `${CLI} --skip-update login --no-prompt`, show: false }]);
  assert.deepEqual(m.asked, []);
});

test('the ticket and the code Slack showed finish the sign-in, with nobody asked', async () => {
  const signedIn = { login: { teamId: 'T1', token: 'tok-1' } };
  const m = await machine(signedIn);
  assert.equal((await slackSignIn(m.options({ ticket: 'TICKET1', code: 'CODE1' }))).token, 'tok-1');
  assert.deepEqual(m.ran, [{ line: `${CLI} --skip-update login --no-prompt --ticket TICKET1 --challenge CODE1`, show: false }]);

  const wrong = await machine(signedIn);
  await assert.rejects(
    slackSignIn(wrong.options({ ticket: 'TICKET1', code: 'NOPE' })),
    (error) => !(error instanceof NeedsYou) && /Slack didn't take that code: Error: invalid challenge code\. Run this again without/.test(error.message),
  );

  // One without the other, or something that isn't one, runs nothing.
  for (const given of [{ ticket: 'TICKET1' }, { code: 'CODE1' }, { ticket: '--token', code: 'CODE1' }, { ticket: 'TICKET1', code: '-x' }]) {
    const half = await machine(signedIn);
    await assert.rejects(slackSignIn(half.options(given)), /go together|isn't a ticket and a code/);
    assert.deepEqual(half.ran, []);
  }
});

test("with no Slack CLI, Slack's installer is offered: shown first, and run only on a yes", async () => {
  const yes = await machine({ cli: false, login: { teamId: 'T1', token: 'tok-1' } });
  assert.equal((await slackSignIn(yes.options({ interactive: true, answer: 'y' }))).token, 'tok-1');
  assert.deepEqual(yes.asked, ['Run it now? [y/N] ']);
  assert.ok(yes.said.join('\n').includes(`  ${SLACK_CLI_INSTALL}`), 'the command is shown before the question');
  assert.deepEqual(yes.ran, [
    { line: `bash -c ${SLACK_CLI_INSTALL}`, show: true },
    { line: `${CLI} --skip-update login`, show: true },
  ]);

  const no = await machine({ cli: false });
  await assert.rejects(slackSignIn(no.options({ interactive: true, answer: '' })), (error) => error instanceof NeedsYou && /--manual/.test(error.message));
  assert.deepEqual(no.ran, [], 'nothing was installed');

  const failed = await machine({ cli: false, install: false });
  await assert.rejects(
    slackSignIn(failed.options({ interactive: true, answer: 'yes' })),
    (error) => !(error instanceof NeedsYou) && /wasn't installed \(the installer exited 7\)/.test(error.message),
  );
});

test('with no Slack CLI and nobody to ask, or on Windows, it says how to install it and runs nothing', async () => {
  const script = await machine({ cli: false });
  await assert.rejects(slackSignIn(script.options()), (error) => {
    assert.ok(error instanceof NeedsYou);
    assert.ok(error.message.includes(`  ${SLACK_CLI_INSTALL}\n`));
    assert.match(error.message, /Then run this again\. For a Slack app you made by hand, run this with --manual instead\.$/);
    return true;
  });
  assert.deepEqual(script.ran, []);

  const windows = await machine({ cli: false, platform: 'win32' });
  await assert.rejects(
    slackSignIn(windows.options({ interactive: true, answer: 'y' })),
    (error) => error instanceof NeedsYou && error.message.includes(`Install it, in PowerShell:\n\n  ${SLACK_CLI_INSTALL_WINDOWS}`),
  );
  assert.deepEqual(windows.ran, []);
  assert.deepEqual(windows.asked, []);

  // A ticket to finish, and the CLI gone since: the same answer.
  const gone = await machine({ cli: false });
  await assert.rejects(slackSignIn(gone.options({ ticket: 'TICKET1', code: 'CODE1' })), NeedsYou);
});
