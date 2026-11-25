// Builds the starter's templates from the example apps, so there is one copy of
// each app: examples/nextjs-<channel>, which CI builds on every run. What the
// starter writes is that app, with a package.json, README and .gitignore of its own.
//
// A channel with an example app of its own gets that app. Every other channel
// gets the Telegram app with its own name, package and settings in place of
// Telegram's: those apps differ in nothing else. What the starter says of a
// channel (its name, its settings, where each comes from) is read from Chat
// SDK's catalog here and written beside the templates, so the starter needs no
// catalog when it runs.
//
// template/ is a build product, like dist/: it is made here and never edited.
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '@chat-adapter/catalog';

const root = new URL('../../../', import.meta.url);
const templates = new URL('../template/', import.meta.url);
/** The app a channel with no example of its own is made from. */
const SHARED = 'telegram';
/** The channels that come first wherever they are listed. */
const FIRST = ['slack', 'discord', 'teams'];

const there = (url) =>
  stat(url).then(
    () => true,
    () => false,
  );
const json = async (url) => JSON.parse(await readFile(url, 'utf8'));
const installed = async (name) => (await json(new URL(`node_modules/${name}/package.json`, root))).version;

// Every channel this repository has a package for: packages/<slug>, named @voiceflow/channels-<slug>.
const slugs = [];
for (const dir of await readdir(new URL('packages/', root))) {
  const pkg = await json(new URL(`packages/${dir}/package.json`, root)).catch(() => undefined);
  if (pkg?.name === `@voiceflow/channels-${dir}`) slugs.push(dir);
}
slugs.sort((a, b) => (FIRST.indexOf(a) + 1 || 99) - (FIRST.indexOf(b) + 1 || 99) || a.localeCompare(b));

/** What the starter says of a channel. */
async function describe(slug) {
  const entry = getAdapter(slug);
  if (!entry) throw new Error(`packages/${slug} is a channel Chat SDK's catalog doesn't have`);
  const setting = (v) => ({ key: v.key, description: v.description ?? '' });
  const traits = await json(new URL(`packages/${slug}/traits.json`, root)).catch(() => ({}));
  const later = traits.later ?? {};
  const extra = traits.settings ?? [];
  const made = extra.filter((v) => v.make).map((v) => v.key);
  return {
    name: entry.name,
    package: entry.packageName,
    version: await installed(entry.packageName),
    guide: entry.readme,
    // What a person brings: the settings the catalog marks as needed and the channel's own, less what connect makes.
    required: [...(entry.env.required ?? []), ...extra]
      .filter((v, i, all) => !(v.key in later) && !made.includes(v.key) && all.findIndex((o) => o.key === v.key) === i)
      .map(setting),
    // A secret of your own that the platform sends back: connect makes each, and saves it.
    made: extra.filter((v) => v.make).map(setting),
    // What can't be there at first, with why.
    later: (entry.env.required ?? []).filter((v) => v.key in later).map((v) => ({ ...setting(v), why: later[v.key] })),
    // Ways to sign in, any one of which is enough.
    modes: (entry.env.credentialModes ?? []).map((mode) => ({ label: mode.label, settings: mode.vars.map(setting) })),
    // Whether the channel's command gives the platform the server's address itself, and where a person does otherwise.
    points: await there(new URL(`packages/${slug}/src/connect/point.ts`, root)),
    ...(traits.addressGoes ? { addressGoes: traits.addressGoes } : {}),
  };
}

/** The channel's part of the env file: each setting with what it is, and nothing in them. */
function envBlock(info) {
  const [first, ...others] = info.modes;
  return [
    `# ${info.name}. From ${info.name}'s own pages: ${info.guide}`,
    ...[...info.required, ...(first?.settings ?? [])].flatMap((s) => [`# ${s.description}`, `${s.key}=`]),
    ...info.made.flatMap((s) => [`# ${s.description} Leave it empty: connect makes it.`, `${s.key}=`]),
    ...info.later.flatMap((s) => [`# ${s.description} Not yet: ${s.why}`, `${s.key}=`]),
    ...(others.length
      ? [`# Or sign in another way: ${others.map((mode) => `${mode.label} (${mode.settings.map((s) => s.key).join(', ')})`).join('; ')}.`]
      : []),
  ].join('\n');
}

/** Every file under a folder. */
async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir);
    if (entry.isDirectory()) found.push(...(await files(url)));
    else found.push(url);
  }
  return found;
}

/** Copies an example's own files: not its package.json or README (the starter writes those), and nothing Next.js generates. */
async function copyApp(example, template) {
  await mkdir(template, { recursive: true });
  // vercel.json is the schedule a deployed Discord bot is kept connected by.
  for (const path of ['app', 'next.config.ts', 'tsconfig.json', 'vercel.json']) {
    if (await there(new URL(path, example))) await cp(new URL(path, example), new URL(path, template), { recursive: true });
  }
  // Under another name: a published package can't be trusted to keep a dotfile.
  await cp(new URL('.env.example', example), new URL('env.example', template));
  // The versions the example is built and tested with become the new app's.
  const { dependencies, devDependencies, scripts } = await json(new URL('package.json', example));
  return { dependencies, devDependencies, scripts };
}

await rm(templates, { recursive: true, force: true });
const channels = {};
const shared = await describe(SHARED);
for (const slug of slugs) {
  const info = (channels[slug] = await describe(slug));
  const template = new URL(`${slug}/`, templates);
  const own = await there(new URL(`examples/nextjs-${slug}/`, root));
  const app = await copyApp(new URL(`examples/nextjs-${own ? slug : SHARED}/`, root), template);
  if (own && slug !== SHARED) {
    await writeFile(new URL('app.json', template), `${JSON.stringify(app, null, 2)}\n`);
    continue;
  }

  // The shared app, as this channel's: its name for Telegram's, in every file and folder.
  const renamed = (text) =>
    text
      .replaceAll(shared.package, info.package)
      .replaceAll(`channels-${SHARED}`, `channels-${slug}`)
      .replaceAll(SHARED, slug)
      .replaceAll(shared.name, info.name);
  if (slug !== SHARED) await rename(new URL(`app/api/${SHARED}/`, template), new URL(`app/api/${slug}/`, template));
  for (const file of await files(template)) {
    if (file.pathname.endsWith('/env.example')) continue;
    await writeFile(file, renamed(await readFile(file, 'utf8')));
  }
  // The env file's own part for the channel is written from the catalog, the example's included: one source for both.
  const env = await readFile(new URL('env.example', template), 'utf8');
  const block = new RegExp(`^# ${shared.name}\\..*\\n(?:.+\\n)*`, 'm');
  if (!block.test(env)) throw new Error(`examples/nextjs-${SHARED}/.env.example has no "# ${shared.name}." part to write a channel's settings in`);
  if (slug === SHARED && !env.includes(`${envBlock(shared)}\n`)) {
    throw new Error(
      `examples/nextjs-${SHARED}/.env.example doesn't say what the catalog says of ${shared.name}'s settings. It should hold:\n\n${envBlock(shared)}\n`,
    );
  }
  await writeFile(
    new URL('env.example', template),
    env.replace(block, () => `${envBlock(info)}\n`),
  );

  const swap = (deps) =>
    Object.fromEntries(
      Object.entries(deps)
        .flatMap(([name, version]) =>
          name === shared.package
            ? [[info.package, info.version]]
            : [[name === `@voiceflow/channels-${SHARED}` ? `@voiceflow/channels-${slug}` : name, version]],
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const scripts = Object.fromEntries(Object.entries(app.scripts).map(([name, script]) => [name, renamed(script)]));
  await writeFile(
    new URL('app.json', template),
    `${JSON.stringify({ dependencies: swap(app.dependencies), devDependencies: app.devDependencies, scripts }, null, 2)}\n`,
  );
}
await writeFile(new URL('channels.json', templates), `${JSON.stringify(channels, null, 2)}\n`);
console.log(`templates: ${fileURLToPath(templates)} (${slugs.join(', ')})`);
