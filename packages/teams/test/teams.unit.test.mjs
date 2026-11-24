// The Teams package's small parts on their own: what is taken out of a
// person's words and put into the agent's, what is kept out of a log, and a
// picture made the size Teams takes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng, encodePng, isPng, squareOf, TEAMS_ICON_SIZE, teamsIcon } from '../dist/connect/index.js';
import { forTeams, loggable, teamsLogger, withoutOwnMention, withoutTokens } from '../dist/index.js';

const BOT = { id: '28:app', name: 'Acme Support' };
const mentioned = (text, as = BOT.name, who = BOT) => ({
  recipient: BOT,
  entities: [{ type: 'mention', text: `<at>${as}</at>`, mentioned: who }, { type: 'clientInfo' }],
  text,
});

test("the bot's own mention is taken out by what Teams says of it, not by a name the server knows", () => {
  assert.equal(withoutOwnMention("@Acme Support where's my order?", mentioned()), "where's my order?");
  assert.equal(withoutOwnMention("where's my order, @Acme Support?", mentioned()), "where's my order, ?");
  assert.equal(withoutOwnMention('@Acme where is it', mentioned('', 'Acme')), 'where is it', 'a mention a person shortened');
  assert.equal(withoutOwnMention('@[Beta] Acme Support (v2) hello', mentioned('', '[Beta] Acme Support (v2)')), 'hello', 'a name with marks in it');
  assert.equal(withoutOwnMention('@acme support HELLO', mentioned()), 'HELLO', 'whatever its case');
  assert.equal(withoutOwnMention('line one\n@Acme Support line two', mentioned()), 'line one\nline two', 'lines stay lines');
  // Mentioned twice, once in full and once shortened: each goes whole, the longer first.
  const twice = {
    recipient: BOT,
    entities: [
      { type: 'mention', text: '<at>Acme</at>', mentioned: BOT },
      { type: 'mention', text: '<at>Acme Support</at>', mentioned: BOT },
    ],
  };
  assert.equal(withoutOwnMention('@Acme Support and @Acme again, hello', twice), 'and again, hello');
});

test("only the bot's mention goes: other people's, an address, and a longer name all stay", () => {
  const grace = { id: '29:grace', name: 'Grace Hopper' };
  const both = {
    recipient: BOT,
    entities: [
      { type: 'mention', text: '<at>Acme Support</at>', mentioned: BOT },
      { type: 'mention', text: '<at>Grace Hopper</at>', mentioned: grace },
    ],
  };
  assert.equal(withoutOwnMention('@Acme Support ask @Grace Hopper', both), 'ask @Grace Hopper');
  assert.equal(withoutOwnMention('@Grace Hopper hello', mentioned('', 'Grace Hopper', grace)), '@Grace Hopper hello', "someone else's mention alone");
  assert.equal(withoutOwnMention('write to help@Acme Support', mentioned()), 'write to help@Acme Support');
  assert.equal(withoutOwnMention('@Acme Supporters unite', mentioned()), '@Acme Supporters unite');
  assert.equal(withoutOwnMention('hello', { recipient: BOT, entities: [] }), 'hello');
  assert.equal(withoutOwnMention('@Acme Support hello', undefined), '@Acme Support hello', 'nothing known of the message: nothing changed');
  assert.equal(withoutOwnMention('@Acme Support', mentioned()), '@Acme Support', 'a bare mention is kept rather than sent empty');
});

test('a heading becomes a bold line, and nothing else is touched', () => {
  assert.equal(forTeams('# Title'), '**Title**');
  assert.equal(forTeams('## Your order\n\nIt ships tomorrow.'), '**Your order**\n\nIt ships tomorrow.');
  assert.equal(forTeams('### **Already bold**'), '**Already bold**', 'one pair of marks, not two');
  assert.equal(forTeams('## Closed ##'), '**Closed**');
  assert.equal(forTeams('###### Deep'), '**Deep**');
  assert.equal(forTeams('#hashtag and #2 in line'), '#hashtag and #2 in line', 'no space after it: not a heading');
  assert.equal(forTeams('Issue #42 is fixed'), 'Issue #42 is fixed');
  assert.equal(forTeams('####### seven'), '####### seven', 'seven is no heading');
  assert.equal(forTeams('plain text'), 'plain text');
});

test('a heading inside code is code', () => {
  const code = '```md\n# not a heading\n```\n\n# A heading\n\n~~~\n## nor this\n~~~';
  assert.equal(forTeams(code), '```md\n# not a heading\n```\n\n**A heading**\n\n~~~\n## nor this\n~~~');
  // A fence that never closes: everything after it is code.
  assert.equal(forTeams('```\n# still code'), '```\n# still code');
  // A longer fence closes only on one as long.
  assert.equal(forTeams('````\n```\n# code\n````\n# out'), '````\n```\n# code\n````\n**out**');
});

test('no token gets into a log: not in a line, not in an error, not in a request', () => {
  const token = `eyJhbGciOiJSUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(20)}`;
  assert.equal(withoutTokens(`got ${token} back`), 'got [token] back');
  assert.equal(withoutTokens(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789`), 'Authorization: Bearer [token]');
  assert.equal(withoutTokens('a bearer of news'), 'a bearer of news', 'only what follows the word as a token does');

  // An error as the adapter catches one from its HTTP client: the request rides on it.
  const error = Object.assign(new Error('Request failed with status code 400'), {
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    isAxiosError: true,
    config: { headers: { Authorization: `Bearer ${token}` }, data: '{"text":"hello"}' },
    request: { _header: `POST /v3 HTTP/1.1\r\nAuthorization: Bearer ${token}` },
    response: { status: 400, data: { error: { code: 'BadArgument', message: 'Activity was not valid.' } }, headers: { 'set-cookie': 'x' } },
  });
  const cleaned = loggable({ conversationId: 'a:1', error });
  assert.deepEqual(cleaned, {
    conversationId: 'a:1',
    error: {
      name: 'AxiosError',
      message: 'Request failed with status code 400',
      code: 'ERR_BAD_REQUEST',
      status: 400,
      answered: 'BadArgument: Activity was not valid.',
    },
  });
  assert.ok(!JSON.stringify(cleaned).includes('eyJ'));

  // The same error once it has been made plain data, as a logger further up might: still no request, no stack.
  const plain = JSON.parse(JSON.stringify({ ...error, message: error.message, stack: error.stack }));
  const again = JSON.stringify(loggable([plain]));
  assert.ok(!again.includes('eyJ') && !again.includes('stack') && !again.includes('config'));

  // Anything else is passed on, with tokens taken out of its strings, to a depth.
  assert.deepEqual(loggable({ a: { b: { c: { d: { e: 1 } } } }, said: `Bearer ${token}`, n: 3, none: null }), {
    a: { b: { c: { d: '[…]' } } },
    said: 'Bearer [token]',
    n: 3,
    none: null,
  });
  assert.equal(loggable({ headers: { authorization: 'x' }, ok: true }).headers, undefined);
});

test("the logger prints warnings and errors, cleaned, and passes a child's prefix on", () => {
  const lines = [];
  const base = (prefix) => ({
    child: (more) => base(`${prefix}:${more}`),
    debug: (...args) => lines.push(['debug', prefix, ...args]),
    info: (...args) => lines.push(['info', prefix, ...args]),
    warn: (...args) => lines.push(['warn', prefix, ...args]),
    error: (...args) => lines.push(['error', prefix, ...args]),
  });
  const logger = teamsLogger(base('teams'));
  logger.child('graph').error('failed with Bearer abcdefghijklmnopqrstuvwxyz', { error: new Error('boom') });
  assert.deepEqual(lines, [['error', 'teams:graph', 'failed with Bearer [token]', { error: { name: 'Error', message: 'boom' } }]]);
});

test('by default only warnings and errors reach the console', () => {
  const printed = [];
  const real = { debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(real)) console[level] = (...args) => printed.push([level, args.join(' ')]);
  try {
    const logger = teamsLogger();
    logger.debug('Teams webhook received');
    logger.info('Teams API: sendActivity');
    logger.warn('something to look at');
    logger.error('something failed');
  } finally {
    Object.assign(console, real);
  }
  assert.deepEqual(
    printed.map(([level]) => level),
    ['warn', 'error'],
  );
  assert.match(printed[0][1], /something to look at/);
});

// ── A picture made the size Teams takes ──────────────────────────────────────

/** A PNG written by hand: any colour type and bit depth, any row filter, so the reader is tried on what it didn't write. */
function handPng({ width, height, type, depth, rows, palette, transparency, interlace = 0 }) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(name, 4, 'latin1');
    Buffer.from(body).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, type, 0, 0, interlace], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
    ...(transparency ? [chunk('tRNS', Buffer.from(transparency))] : []),
    chunk('IDAT', deflateSync(Buffer.concat(rows.map((row) => Buffer.from(row))))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A row of pixel bytes, written with one of PNG's five filters. */
function filtered(filter, row, previous, step) {
  const out = [filter];
  for (let i = 0; i < row.length; i++) {
    const left = i >= step ? row[i - step] : 0;
    const up = previous ? previous[i] : 0;
    const corner = previous && i >= step ? previous[i - step] : 0;
    const p = left + up - corner;
    const paeth =
      Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
    const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
    out.push((row[i] - predicted) & 0xff);
  }
  return out;
}

test('a PNG is read whatever filter its rows were written with', () => {
  const rows = Array.from({ length: 5 }, (_, y) => Array.from({ length: 4 * 4 }, (_, i) => (y * 37 + i * 11 + (i % 4 === 3 ? 200 : 0)) & 0xff));
  const png = handPng({ width: 4, height: 5, type: 6, depth: 8, rows: rows.map((row, y) => filtered(y, row, rows[y - 1], 4)) });
  const read = decodePng(png);
  assert.deepEqual([read.width, read.height], [4, 5]);
  assert.deepEqual([...read.rgba], rows.flat());
});

test('a PNG of any kind is read: a palette, greys, no transparency, sixteen bits', () => {
  // Four colours by number, two bits each, the second see-through.
  const palette = handPng({
    width: 4,
    height: 1,
    type: 3,
    depth: 2,
    palette: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9],
    transparency: [255, 0],
    rows: [[0, 0b00011011]],
  });
  assert.deepEqual([...decodePng(palette).rgba], [255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 9, 9, 9, 255]);
  // One bit a pixel: black and white.
  const bits = handPng({ width: 8, height: 1, type: 0, depth: 1, rows: [[0, 0b10100000]] });
  assert.deepEqual(
    [...decodePng(bits).rgba].filter((_, i) => i % 4 === 0),
    [255, 0, 255, 0, 0, 0, 0, 0],
  );
  // Red, green and blue alone: opaque.
  const rgb = handPng({ width: 2, height: 1, type: 2, depth: 8, rows: [[0, 1, 2, 3, 4, 5, 6]] });
  assert.deepEqual([...decodePng(rgb).rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
  // Grey with transparency, and sixteen bits a channel read as its high eight.
  const grey = handPng({ width: 1, height: 1, type: 4, depth: 8, rows: [[0, 100, 50]] });
  assert.deepEqual([...decodePng(grey).rgba], [100, 100, 100, 50]);
  const deep = handPng({ width: 1, height: 1, type: 6, depth: 16, rows: [[0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff]] });
  assert.deepEqual([...decodePng(deep).rgba], [0x12, 0x56, 0x9a, 0xff]);
});

test('a picture comes out square about its middle, at the size asked, the same picture', () => {
  // Wide: red on the left third, blue in the middle, green on the right. The middle square is all blue.
  const width = 300;
  const height = 100;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgba.set(x < 100 ? [255, 0, 0, 255] : x < 200 ? [0, 0, 255, 255] : [0, 255, 0, 255], (y * width + x) * 4);
  const square = squareOf({ width, height, rgba }, 50);
  assert.deepEqual([square.width, square.height, square.rgba.length], [50, 50, 50 * 50 * 4]);
  for (let i = 0; i < square.rgba.length; i += 4) assert.deepEqual([...square.rgba.subarray(i, i + 4)], [0, 0, 255, 255]);

  // Scaled down, a pixel is the average of what it covers: black and white squares come out grey.
  const checks = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) checks.set(((i % 4) + Math.floor(i / 4)) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  const half = squareOf({ width: 4, height: 4, rgba: checks }, 2);
  assert.deepEqual([...half.rgba], Array.from({ length: 4 }, () => [128, 128, 128, 255]).flat());

  // A see-through pixel's colour doesn't tint its neighbour: half red, half nothing, is red at half strength.
  const edge = squareOf({ width: 2, height: 1, rgba: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 0]) }, 1);
  assert.deepEqual([...edge.rgba], [255, 0, 0, 128]);

  // Scaled up, each pixel is the one it came from.
  const up = squareOf({ width: 1, height: 1, rgba: Uint8Array.from([7, 8, 9, 255]) }, 3);
  assert.deepEqual([...up.rgba.subarray(0, 4)], [7, 8, 9, 255]);
});

test('what is written reads back the same, and Teams gets 192 by 192', async () => {
  const pixels = { width: 3, height: 2, rgba: Uint8Array.from({ length: 24 }, (_, i) => (i * 23) & 0xff) };
  const png = encodePng(pixels);
  assert.ok(isPng(png));
  assert.deepEqual(decodePng(png), pixels);
  // Each part carries a checksum, which every other reader of a PNG checks: Microsoft's among them.
  const parts = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    parts.push(png.toString('latin1', at + 4, at + 8));
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `the checksum of ${parts.at(-1)}`);
    at += 12 + length;
  }
  assert.deepEqual(parts, ['IHDR', 'IDAT', 'IEND']);

  // Voiceflow's own icon, written by another program: 512 pixels in, 192 out, the same colours.
  const own = await readFile(new URL('../../core/assets/voiceflow-icon.png', import.meta.url));
  const made = teamsIcon(own);
  assert.ok('png' in made, made.problem);
  const before = decodePng(own);
  const after = decodePng(made.png);
  assert.deepEqual([after.width, after.height], [TEAMS_ICON_SIZE, TEAMS_ICON_SIZE]);
  const average = ({ rgba }) =>
    [0, 1, 2, 3].map((channel) => Math.round(rgba.reduce((sum, value, i) => (i % 4 === channel ? sum + value : sum), 0) / (rgba.length / 4)));
  assert.deepEqual(average(after), average(before));
  assert.deepEqual([...after.rgba.subarray(0, 4)], [...before.rgba.subarray(0, 4)], 'its corner is its corner');

  // One that is the right size already goes as it is, byte for byte.
  assert.equal(teamsIcon(made.png).png, made.png);
});

test("a picture that can't be made one says why, and nothing is unpacked that shouldn't be", () => {
  assert.match(
    teamsIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])).problem,
    /it isn't a PNG, and only a PNG can be made the 192 by 192 pixels Teams takes/,
  );
  assert.match(teamsIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')).problem, /it isn't a PNG/);
  const whole = encodePng({ width: 2, height: 2, rgba: new Uint8Array(16) });
  assert.match(teamsIcon(whole.subarray(0, whole.length - 20)).problem, /it couldn't be read: (it is cut short|its pixels couldn't be unpacked)/);
  assert.match(teamsIcon(handPng({ width: 2, height: 2, type: 6, depth: 8, interlace: 1, rows: [[0]] })).problem, /it is interlaced/);
  assert.match(teamsIcon(handPng({ width: 1, height: 1, type: 3, depth: 8, rows: [[0, 0]] })).problem, /it has no palette/);
  // A header that claims a vast picture is refused by its header: nothing is unpacked.
  assert.match(teamsIcon(handPng({ width: 60000, height: 60000, type: 6, depth: 8, rows: [[0]] })).problem, /it is 60000 by 60000 pixels, which is too large/);
  // A small header over a great deal of data: unpacking stops at what the header allows.
  const bomb = handPng({ width: 1, height: 1, type: 6, depth: 8, rows: [new Uint8Array(5_000_000)] });
  assert.match(teamsIcon(bomb).problem, /its pixels couldn't be unpacked/);
});
