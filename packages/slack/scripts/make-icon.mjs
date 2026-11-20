// Makes assets/voiceflow-icon.png, the icon connect gives a new Slack app when
// the agent has no avatar of its own.
//
//   node packages/slack/scripts/make-icon.mjs --website <a voiceflow-website checkout>
//
// It is the agent avatar of Voiceflow's live design system (V3), not a new
// drawing: the brand's own butterfly file (design/assets/logomark-white.svg,
// placed, never redrawn) at half the tile's width, centred on the colour the
// avatar names (--v3-preview-accent, followed through the token files to its
// value, never copied). The proportion is ProductPreview.astro's .pp-sms-avatar:
// a 16px mark on a 32px tile. Slack rounds the tile's corners itself, so the
// ground here is square. Slack takes 512 to 2000 pixels; 512 is the size its own
// CLI uploads.
//
// Needs Google Chrome, which renders the page. Run it again when the brand's
// mark or colour changes, and commit the PNG.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SIZE = 512;
const MARK_SHARE = 16 / 32; // .pp-sms-avatar: --v3-space-16 inside --v3-space-32
const ROLE = '--v3-preview-accent';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const { values } = parseArgs({ options: { website: { type: 'string' }, out: { type: 'string' } } });
if (!values.website) throw new Error('Pass --website <path to a voiceflow-website checkout>.');
const website = resolve(values.website);
const out = resolve(values.out ?? fileURLToPath(new URL('../assets/voiceflow-icon.png', import.meta.url)));

const mark = join(website, 'design/assets/logomark-white.svg');
if (!existsSync(mark)) throw new Error(`No ${mark}: is ${website} a voiceflow-website checkout?`);
const ground = tokenValue(join(website, 'design/tokens'), ROLE);

const [, , vw, vh] = readFileSync(mark, 'utf8').match(/viewBox="([\d.\s]+)"/)[1].trim().split(/\s+/).map(Number);
const width = SIZE * MARK_SHARE;
const height = (width * vh) / vw;

const dir = mkdtempSync(join(tmpdir(), 'vf-icon-'));
try {
  const page = join(dir, 'icon.html');
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:${ground}}` +
      `img{position:absolute;left:${(SIZE - width) / 2}px;top:${(SIZE - height) / 2}px;width:${width}px;height:${height}px}</style>` +
      `<img src="${pathToFileURL(mark).href}" alt="">`,
  );
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${SIZE},${SIZE}`, `--screenshot=${out}`, pathToFileURL(page).href], { stdio: 'ignore' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const png = readFileSync(out);
const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
if (w !== SIZE || h !== SIZE) throw new Error(`Chrome made a ${w}x${h} image, not ${SIZE}x${SIZE}.`);
console.log(`${out}: ${SIZE}x${SIZE}, ${ROLE} = ${ground}, mark ${width}x${height.toFixed(1)}`);

/** Follows a custom property through the token files' var() chain to the value it ends at. */
function tokenValue(folder, name) {
  const defs = new Map();
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.css'))) {
    for (const [, key, value] of readFileSync(join(folder, file), 'utf8').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (!defs.has(key)) defs.set(key, value.replace(/\/\*.*?\*\//g, '').trim());
    }
  }
  const seen = [];
  for (let key = name; ; ) {
    if (seen.includes(key)) throw new Error(`${name} loops: ${seen.join(' → ')}`);
    seen.push(key);
    const value = defs.get(key);
    if (value === undefined) throw new Error(`${key} isn't defined in ${folder} (from ${seen.join(' → ')})`);
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (ref) {
      key = ref[1];
      continue;
    }
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} ends at "${value}", not a colour (${seen.join(' → ')})`);
    return value;
  }
}
