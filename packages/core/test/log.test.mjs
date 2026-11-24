// What an adapter logs, cleaned before it reaches any logger: the request an error carries, anything shaped like
// an access token, and every secret the channel was given. The values here are made up, and put together from
// parts so that none reads as a real one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { adapterLogger, cleanLogger, withoutTokens } from '../dist/index.js';

const TOKEN = ['eyJhbGciOiJSUzI1NiJ9', 'a'.repeat(40), 'b'.repeat(20)].join('.');
const SECRET = ['made', 'up', 'client', 'secret', '0123456789'].join('-');
const OPTION_SECRET = ['another', 'made', 'up', 'value', '5550100'].join('-');
const SETTING_SECRET = ['a', 'third', 'made', 'up', 'value', '5550199'].join('-');

/** A logger that keeps what it is given, as a console would print it. */
function capture() {
  const lines = [];
  const at = (prefix) => {
    const write =
      (level) =>
      (message, ...args) =>
        lines.push([level, prefix, message, ...args]);
    return { child: (next) => at(prefix ? `${prefix}:${next}` : next), debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
  };
  return { logger: at(''), lines, text: () => lines.map((line) => inspect(line, { depth: 10 })).join('\n') };
}

/** An HTTP client's error, as an adapter catches one: the request it was thrown for rides on it. */
function failedCall() {
  const error = new Error(`Request failed with status code 400 for Bearer ${TOKEN}`);
  error.name = 'AxiosError';
  Object.assign(error, {
    isAxiosError: true,
    code: 'ERR_BAD_REQUEST',
    status: 400,
    config: { url: `https://api.example.com/bot${SECRET}/send`, headers: { Authorization: `Bearer ${TOKEN}` }, data: '{"text":"hello"}' },
    request: { _header: `POST /send HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}` },
    response: {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'set-cookie': SECRET },
      data: { error: { code: 'BadArgument', message: `No such chat for ${SECRET}` } },
      config: { headers: { Authorization: `Bearer ${TOKEN}` } },
    },
  });
  return error;
}

test('anything shaped like an access token is taken out of a string, and nothing else', () => {
  assert.equal(withoutTokens(`got ${TOKEN} back`), 'got [token] back');
  assert.equal(withoutTokens('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'Authorization: Bearer [token]');
  assert.equal(withoutTokens('Authorization: Bot abcdefghijklmnopqrstuvwxyz0123456789'), 'Authorization: Bot [token]');
  assert.equal(withoutTokens('a bearer of good news, and a bot named Ada'), 'a bearer of good news, and a bot named Ada');
  assert.equal(withoutTokens('nothing to hide'), 'nothing to hide');
});

test('an error is passed on as an error, without the request it was thrown for', () => {
  const { logger, lines, text } = capture();
  cleanLogger(logger, [SECRET]).error('Teams API: send failed', { error: failedCall() });
  const [level, , message, { error }] = lines[0];
  assert.deepEqual([level, message], ['error', 'Teams API: send failed']);
  assert.ok(error instanceof Error, 'still an error, so a logger prints it as one');
  assert.equal(error.name, 'AxiosError');
  assert.equal(error.message, 'Request failed with status code 400 for Bearer [token]');
  assert.match(error.stack, /log\.test\.mjs/, 'with where it was thrown');
  assert.deepEqual([error.code, error.status], ['ERR_BAD_REQUEST', 400]);
  assert.deepEqual(
    error.response,
    { status: 400, statusText: 'Bad Request', data: { error: { code: 'BadArgument', message: 'No such chat for [hidden]' } } },
    'and what the platform answered',
  );
  for (const gone of ['config', 'request', 'isAxiosError']) assert.equal(gone in error, false, `${gone} is not passed on`);
  const printed = text();
  assert.ok(!printed.includes(TOKEN) && !printed.includes(SECRET), 'no token and no secret, anywhere in what a console would print');
  assert.doesNotMatch(printed, /Authorization|set-cookie|_header/);
});

test("a channel's secrets are taken out wherever they are written: a message, an object, an address", () => {
  const { logger, text } = capture();
  const clean = cleanLogger(logger, [SECRET, undefined, '', 'short']);
  clean.info(`calling https://api.example.com/bot${SECRET}/getMe`, {
    url: `https://api.example.com/bot${encodeURIComponent(SECRET)}/getMe`,
    attempt: 2,
    at: new Date(0),
  });
  clean.warn('settings', { appSecret: SECRET, nested: { list: [SECRET, 1, null, true] }, headers: { authorization: SECRET }, kept: 'a short word' });
  clean.debug('a body', { body: new Uint8Array(12), deep: { a: { b: { c: { d: { e: SECRET } } } } } });
  const printed = text();
  assert.ok(!printed.includes(SECRET), printed);
  assert.match(printed, /calling https:\/\/api\.example\.com\/bot\[hidden\]\/getMe/);
  assert.match(printed, /attempt: 2/);
  assert.match(printed, /appSecret: '\[hidden\]'/);
  assert.match(printed, /kept: 'a short word'/, 'a word too short to be a secret is left');
  assert.doesNotMatch(printed, /headers/, 'what was sent with a request is not passed on');
  assert.match(printed, /\[12 bytes\]/);
  assert.match(printed, /'\[…\]'/, 'and past a depth, nothing is');
});

test("a child logger cleans too, and a value that can't be read is not passed on as it is", () => {
  const { logger, lines } = capture();
  const child = cleanLogger(logger, [SECRET]).child('graph').child('users');
  const trap = {};
  Object.defineProperty(trap, 'boom', {
    enumerable: true,
    get: () => {
      throw new Error(SECRET);
    },
  });
  child.error(`failed with ${SECRET}`, trap);
  assert.deepEqual(lines, [['error', 'graph:users', 'failed with [hidden]', '[not logged]']]);
});

test('the logger an adapter is given: its own where it has one, the console as the adapter would set it up otherwise', () => {
  const { logger, text } = capture();
  const mine = adapterLogger(
    'telegram',
    { logger, botToken: SECRET, nested: { clientSecret: OPTION_SECRET, apiUrl: 'https://api.example.com' } },
    { TELEGRAM_WEBHOOK_SECRET_TOKEN: SETTING_SECRET, TELEGRAM_BOT_USERNAME: 'acme_support_bot' },
  );
  mine.error(`one ${SECRET} two ${OPTION_SECRET} three ${SETTING_SECRET} at https://api.example.com as acme_support_bot`);
  const cleaned = text();
  assert.ok(!cleaned.includes(SECRET), 'an option named like a secret is one');
  assert.ok(!cleaned.includes(OPTION_SECRET), 'at any depth');
  assert.ok(!cleaned.includes(SETTING_SECRET), "and so is a setting Chat SDK's catalog marks as secret, read from the environment");
  assert.match(cleaned, /at https:\/\/api\.example\.com as acme_support_bot/, 'an option or a setting that is no secret is left');

  // With no logger of its own: the console, under the adapter's name, from "info" up.
  const printed = [];
  const real = { info: console.info, error: console.error, debug: console.debug, warn: console.warn, log: console.log };
  for (const level of Object.keys(real))
    console[level] = (...args) => printed.push(`${level} ${args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' ')}`);
  try {
    const own = adapterLogger('telegram', { botToken: SECRET }, {});
    own.debug('not printed');
    own.info(`started with ${SECRET}`);
    own.error('failed', failedCall());
  } finally {
    Object.assign(console, real);
  }
  const said = printed.join('\n');
  assert.doesNotMatch(said, /not printed/);
  assert.match(said, /info \[chat-sdk:telegram\] started with \[hidden\]/);
  assert.match(said, /failed/);
  assert.ok(!said.includes(SECRET) && !said.includes(TOKEN), said);
  // An adapter the catalog doesn't list is given one all the same.
  assert.doesNotThrow(() => adapterLogger('not-in-the-catalog', { apiKey: SECRET }, {}).debug('fine'));
});
