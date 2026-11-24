// Writes the channel packages that are the same for every platform: Chat SDK's
// adapter, the adapter's module, the channel's variables and its setup command.
// One template, one package per platform Chat SDK ships an adapter for, so
// every channel is installed, imported and set up the same way.
//
//   node scripts/channels.mjs              write them
//   node scripts/channels.mjs telegram     write one
//   node scripts/channels.mjs --check      fail if any is not as this would write it
//
// It also writes the table of every channel in the repository's README,
// between its two "channels" marks, from the same catalog.
//
// What a platform needs beyond the template is in files this reads and never
// writes, each in the platform's own package:
//   traits.json            what the catalog doesn't say of the platform (below)
//   src/platform.ts        adapter options that are code (`adapterDefaults`), and
//                          the platform's own way of writing text (`text`)
//   src/connect/point.ts   gives the platform your server's address (`point`),
//                          and takes it back (`remove`), where it takes one
//                          from a command
//   test/stand-in.mjs      the platform, for the tests
//   test/*.test.mjs        tests of what only this platform has
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, getFeatureSupport } from '@chat-adapter/catalog';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');

/** The platforms with a package of their own code: left alone here. */
const OWN = ['slack', 'discord', 'teams'];
/** The platforms written here, by their name in Chat SDK's catalog. */
export const CHANNELS = ['gchat', 'github', 'gitlab', 'instagram', 'linear', 'messenger', 'notion', 'telegram', 'twilio', 'whatsapp', 'x'];
export const ALL_CHANNELS = [...OWN, ...CHANNELS];

/**
 * What a platform's `traits.json` says of it that the catalog doesn't:
 * - maxTextLength: the longest text in one message, where the adapter would cut a longer one short or have it refused.
 * - adapterDefaults: adapter options the channel turns on, which the caller's own options override.
 * - capabilities: what the platform can show, where it is known better than the catalog says: { buttons: true } for
 *   buttons the catalog is unsure of that work, { buttons: false } for ones that don't, { maxButtons: 3 } for the most
 *   a message shows before the adapter drops the rest.
 * - plainText: true where the platform shows text as it is typed, so the agent's Markdown goes as plain words.
 * - follow: false where a conversation is a whole room, so the bot answers a mention and not everyone after it.
 * - settings: settings the channel needs that the catalog doesn't mark as needed: [{ key, description, make }].
 *   `make` is true for a secret of your own choosing, which connect makes and saves.
 * - later: settings the catalog marks as needed that can't be there at first: { KEY: why }.
 * - addressGoes: where a person enters your server's address, when no command can: a few words.
 * - notes: lines for the README's "What happens" list, each a thing a person would otherwise find out the hard way.
 * - why: a line on each of the above, for whoever reads the file. Not used here.
 */
function traitsOf(slug) {
  const file = join(root, `packages/${slug}/traits.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/** Whether the platform has a feature: the catalog's full "yes", unless the channel's own package says. */
const FEATURE = { buttons: 'buttons', cardFormat: 'cards', streaming: 'streaming', typingIndicator: 'typingIndicator' };
const yes = (slug, feature) => traitsOf(slug).capabilities?.[FEATURE[feature]] ?? getFeatureSupport(slug, feature).status === 'yes';

/** A value as the code that makes it. The formatter decides how it is laid out. */
function literal(value) {
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value)
      .map(([key, v]) =>
        v && typeof v === 'object' && '$code' in v
          ? v.$code === key
            ? key
            : `${key}: ${v.$code}`
          : `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : literal(key)}: ${literal(v)}`,
      )
      .join(', ')} }`;
  }
  return typeof value === 'string' ? `'${value.replace(/[\\']/g, '\\$&')}'` : JSON.stringify(value);
}

/** A file's text as the repository's formatter writes it, so what is generated is what `npm run lint` accepts. */
function formatted(path, text) {
  if (!/\.(ts|mjs|json)$/.test(path) || path.endsWith('package.json')) return text;
  const run = spawnSync(process.execPath, [join(root, 'node_modules/@biomejs/biome/bin/biome'), 'check', '--write', `--stdin-file-path=${join(root, path)}`], {
    input: text,
    encoding: 'utf8',
    cwd: root,
  });
  if (run.status !== 0 || !run.stdout) throw new Error(`The formatter refused ${path}:\n${run.stderr || run.stdout}`);
  return run.stdout;
}

function files(slug) {
  const entry = getAdapter(slug);
  const { name, packageName, env } = entry;
  const traits = traitsOf(slug);
  const dir = `packages/${slug}`;
  const pointFile = join(root, dir, 'src/connect/point.ts');
  const pointText = existsSync(pointFile) ? readFileSync(pointFile, 'utf8') : '';
  const hasPoint = /^export (const|async function|function) point\b/m.test(pointText);
  const hasRemove = /^export (const|async function|function) remove\b/m.test(pointText);
  const platformFile = join(root, dir, 'src/platform.ts');
  const platformText = existsSync(platformFile) ? readFileSync(platformFile, 'utf8') : '';
  /** What the platform's own code gives the channel: adapter options that are code, and its way of writing text. */
  const fromPlatform = ['adapterDefaults', 'text'].filter((name) => new RegExp(`^export (const|function) ${name}\\b`, 'm').test(platformText));
  if (fromPlatform.includes('adapterDefaults') && traits.adapterDefaults)
    throw new Error(`${dir}: adapterDefaults is in both traits.json and src/platform.ts. Keep one.`);
  const later = traits.later ?? {};
  const extra = traits.settings ?? [];
  const made = extra.filter((v) => v.make);
  const required = [...(env.required ?? []), ...extra.filter((v) => !v.make)].filter((v) => !(v.key in later)).map((v) => v.key);
  const modes = env.credentialModes ?? [];
  const reads = [...required, ...(modes[0]?.vars.map((v) => v.key) ?? [])];
  const said = {
    ...Object.fromEntries(Object.entries(traits).filter(([key]) => ['maxTextLength', 'adapterDefaults', 'plainText', 'capabilities', 'follow'].includes(key))),
    ...Object.fromEntries(fromPlatform.map((name) => [name, { $code: name }])),
  };
  const traitsLiteral = Object.keys(said).length ? `, ${literal(said)}` : '';
  const setup = {
    ...(extra.length ? { settings: extra.map(({ key, description, make }) => ({ key, description, ...(make ? { make: true } : {}) })) } : {}),
    ...(Object.keys(later).length ? { later } : {}),
    ...(hasPoint ? { point: { $code: 'point' } } : traits.addressGoes ? { addressGoes: traits.addressGoes } : {}),
    ...(hasRemove ? { remove: { $code: 'remove' } } : {}),
  };
  const setupLiteral = Object.keys(setup).length ? `, ${literal(setup)}` : '';
  const header = `// Written by scripts/channels.mjs: change the template there, not this file.`;

  const pkg = {
    name: `@voiceflow/channelkit-${slug}`,
    version: '0.0.0',
    private: true,
    description: `A Voiceflow agent in ${name}, with one command to set it up.`,
    keywords: ['voiceflow', 'channelkit', slug, 'chat-sdk', 'vercel-chat', 'chatbot', 'bot', 'ai-agent', 'conversational-ai'],
    author: 'Braden Ream',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/voiceflow/channelkit.git', directory: dir },
    homepage: `https://github.com/voiceflow/channelkit/tree/main/${dir}#readme`,
    bugs: { url: 'https://github.com/voiceflow/channelkit/issues' },
    publishConfig: { access: 'public' },
    type: 'module',
    engines: { node: '>=22' },
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './connect': { types: './dist/connect/index.d.ts', import: './dist/connect/index.js' },
    },
    files: ['dist', 'src', 'README.md', 'LICENSE'],
    scripts: { build: 'tsc -p tsconfig.json', test: 'npm run build && node --test test/*.test.mjs', typecheck: 'tsc -p tsconfig.json --noEmit' },
    dependencies: { '@voiceflow/channelkit': '0.0.0' },
    peerDependencies: {
      chat: '>=4.44.0 <5',
      '@chat-adapter/catalog': '>=4.44.0 <5',
      [packageName]: '>=4.44.0 <5',
      '@chat-adapter/state-memory': '>=4.44.0 <5',
    },
    peerDependenciesMeta: { '@chat-adapter/state-memory': { optional: true } },
  };

  const index = `${header}
// A Voiceflow agent in ${name}. Everything channel-neutral comes from
// @voiceflow/channelkit; this package brings Chat SDK's ${name} adapter.
import * as adapter from '${packageName}';
import { type ChannelOptions, type ChannelSpec, channel, contextVariables } from '@voiceflow/channelkit';
${fromPlatform.length ? `import { ${fromPlatform.join(', ')} } from './platform.js';\n` : ''}
export type { ChannelOptions as ${pascal(slug)}Options } from '@voiceflow/channelkit';

/** Every variable this channel sets, with what it holds. \`connect ${slug}\` creates them on the agent. */
export const CONTEXT_VARIABLES: Record<string, string> = contextVariables('${slug}');

/**
 * ${name} as a channel for \`createChannels\`. It carries the ${name} adapter's
 * module, imported here, so a bundled server (Next.js, say) needs no adapter
 * loaded by name. The adapter reads ${reads.length ? reads.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'its settings'} unless you pass \`adapter\`.
 */
export function ${slug}(options: ChannelOptions = {}): ChannelSpec {
  return channel('${slug}', adapter, options${traitsLiteral});
}
`;

  const connect = `${header}
// \`connect ${slug}\`, \`point ${slug}\` and \`disconnect ${slug}\`. Node only: import it
// from \`@voiceflow/channelkit-${slug}/connect\`.
import { channelCommands } from '@voiceflow/channelkit/connect';
${hasPoint ? `import { point${hasRemove ? ', remove' : ''} } from './point.js';\n` : ''}
export const { cli, connected, settings } = channelCommands('${slug}'${setupLiteral});
`;

  const testFile = `${header}
// A Voiceflow agent in ${name}, end to end on this machine: Chat SDK's real
// ${name} adapter and the core's agent, against a stand-in for ${name}
// (./stand-in.mjs) and a scripted Voiceflow runtime. Every channel runs the
// same conversation.
import { createMemoryState } from '@chat-adapter/state-memory';
import { channelContract } from '@voiceflow/channelkit/testing';
import * as commands from '../dist/connect/index.js';
import { CONTEXT_VARIABLES, ${slug} } from '../dist/index.js';
import { start } from './stand-in.mjs';

channelContract({ slug: '${slug}', channel: ${slug}, variables: CONTEXT_VARIABLES, commands, start, state: createMemoryState });
`;

  const maxButtons = traits.capabilities?.maxButtons;
  const shows = [
    yes(slug, 'buttons')
      ? `- **Choices** from the agent are buttons. A click sends the button's own request, as the person who clicked.${maxButtons ? ` ${name} shows ${maxButtons} on a message: a longer list is numbered, and a person answers with the number, or the words.` : ''}`
      : '- **Choices** from the agent are a numbered list: a person answers with the number, or the words.',
    yes(slug, 'cardFormat')
      ? `- **Cards and carousels** are shown as cards${yes(slug, 'buttons') ? '' : ', and one with choices as text, its choices numbered'}.`
      : '- **Cards and carousels** are shown as text, with their choices numbered.',
    yes(slug, 'streaming')
      ? '- **Answers stream** into one message as the agent writes them.'
      : `- **Each reply is posted whole**${yes(slug, 'typingIndicator') ? `, with ${name}'s typing indicator while the agent works` : ''}.`,
    ...(traits.maxTextLength
      ? [`- **A long answer** goes as several messages, cut where the text breaks, at ${traits.maxTextLength.toLocaleString('en-US')} characters.`]
      : []),
    ...(traits.plainText
      ? [`- **Text goes as plain words.** ${name} shows Markdown as it is typed, so its marks are taken out: a list keeps its numbers, and a link its address.`]
      : []),
    traits.follow === false
      ? `- **The bot answers where it is mentioned**, and not what is said after: a conversation in ${name} is a whole room. \`${slug}({ follow: true })\` has it go on answering.`
      : `- **After a mention, the bot goes on answering** in that conversation without being mentioned again. \`${slug}({ follow: false })\` has it answer only where it is mentioned.`,
    ...(traits.notes ?? []).map((note) => `- ${note}`),
  ];
  const settingRows = [
    ...(env.required ?? []).map(
      (v) => `| \`${v.key}\` | ${v.key in later ? 'Yes, later' : 'Yes'} | ${v.description ?? ''}${v.key in later ? ` ${later[v.key]}` : ''} |`,
    ),
    ...extra.map((v) => `| \`${v.key}\` | ${v.make ? 'Yes: connect makes it' : 'Yes'} | ${v.description} |`),
    ...modes.flatMap((mode, i) =>
      mode.vars.map(
        (v) =>
          `| \`${v.key}\` | ${modes.length > 1 ? `One way to sign in (${mode.label})` : 'Yes'}${i === 0 && modes.length > 1 ? '' : ''} | ${v.description ?? ''} |`,
      ),
    ),
    ...(env.optional ?? []).filter((v) => !extra.some((x) => x.key === v.key)).map((v) => `| \`${v.key}\` | No | ${v.description ?? ''} |`),
  ];
  const variableRows = Object.entries(variablesOf(slug, name)).map(([key, text]) => `| \`${key}\` | ${text} |`);
  const readme = `# @voiceflow/channelkit-${slug}

A Voiceflow agent in ${name}, with one command to set it up.

> **Status:** pre-release, local only. Not published. The package name is not final.
> Built on Chat SDK's ${name} adapter.

## Connect

\`\`\`bash
npx voiceflow-channelkit connect ${slug} --env-file .env.local
\`\`\`

${name}'s side is made on ${name}'s own pages: its app or bot, and the
settings below. [Chat SDK's guide to the ${name} adapter](${entry.readme})
has each step. Put the settings in your server's env file, and connect does
the rest. It shows its whole plan and asks before it changes anything.

- **It checks the settings are there**, and says what each missing one is.
${made.length ? `- **It makes ${made.map((v) => `\`${v.key}\``).join(' and ')}**, a secret of your own that ${name} sends back with each message, and saves it to the env file.\n` : ''}- **It creates the \`${slug}_*\` variables** on your agent, for its prompts.
- **It writes the Voiceflow values** it had to ask for to the env file. A
  value already there is never changed.
- **${hasPoint ? `It gives ${name} your server's address` : `It says what address to give ${name}`}**${hasPoint ? `, when you pass one (\`--public-url\`). \`voiceflow-channelkit dev\` gives it the tunnel's each time it starts${hasRemove ? ', and `disconnect` takes it back' : ''}.` : `: your server's public address, then \`/api/${slug}\`${traits.addressGoes ? `. It goes in ${traits.addressGoes}` : ''}. \`voiceflow-channelkit dev\` prints the tunnel's each time it starts.`}
- **With nobody at the terminal** (a script, a coding agent) connect asks
  nothing. It stops with exit code 3 and says, in the one stop, everything a
  person has to do. Exit 0 is done, 1 a failure, 2 a mistake in the command.
- **\`voiceflow-channelkit dev\` runs connect for you** the first time, when a
  person is there. So in an app the starter made, \`npm run dev\` is the one
  command.
- **Nothing is published.** The variables are live once you publish the
  environment. \`--publish\` does that here: the whole draft goes live.
- **\`--dry-run\`** shows the plan and changes nothing.

## In your server

\`\`\`ts
import { ${slug} } from '@voiceflow/channelkit-${slug}';

const channels = await createChannels({
  voiceflow: { apiKey: process.env.VOICEFLOW_API_KEY!, projectID: process.env.VOICEFLOW_PROJECT_ID! },
  channels: [${slug}()],
  state,
});
// One route takes everything: channels.webhook('${slug}', request, { waitUntil })
\`\`\`

Install it with Chat SDK's adapter:

\`\`\`bash
npm install @voiceflow/channelkit @voiceflow/channelkit-${slug} chat @chat-adapter/catalog ${packageName}
\`\`\`

### What happens in ${name}

${shows.join('\n')}

### Settings

The adapter reads these from the environment. \`${slug}({ adapter: { … } })\`
passes its config directly instead.

| Setting | Needed | What it is |
|---|---|---|
${settingRows.join('\n')}

### Options

| Option | Default | What it does |
|---|---|---|
| \`adapter\` | the environment | The ${name} adapter's own config. |
| \`context\` | \`true\` | Set who and where as \`${slug}_*\` variables on every turn. |
| \`follow\` | \`${traits.follow === false ? 'false' : 'true'}\` | Go on answering a conversation the bot was mentioned in, without another mention. |

### Variables

Set on every turn, empty when unknown. The agent sees one only where its
instructions or global prompt reference it (\`{${slug}_user_name}\`).

| Variable | What it holds |
|---|---|
${variableRows.join('\n')}
`;

  return {
    [`${dir}/package.json`]: `${JSON.stringify(pkg, null, 2)}\n`,
    [`${dir}/tsconfig.json`]: `{\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": { "outDir": "dist", "rootDir": "src" },\n  "include": ["src"]\n}\n`,
    [`${dir}/src/index.ts`]: index,
    [`${dir}/src/connect/index.ts`]: connect,
    [`${dir}/test/${slug}.contract.test.mjs`]: testFile,
    [`${dir}/README.md`]: readme,
  };
}

/** Where each platform gets your server's address from: the channel's own command, or a person. */
const POINTS = { slack: true, discord: true, teams: true };

/** The README's table of every channel: what each shows, read from the catalog and the channel's package. */
function channelTable() {
  const rows = ALL_CHANNELS.map((slug) => {
    const { name } = getAdapter(slug);
    const traits = traitsOf(slug);
    const points = POINTS[slug] ?? existsSync(join(root, `packages/${slug}/src/connect/point.ts`));
    const most = traits.capabilities?.maxButtons;
    const choices = !yes(slug, 'buttons') ? 'A numbered list' : most ? `Buttons, up to ${most}` : 'Buttons';
    return `| ${name} | [\`@voiceflow/channelkit-${slug}\`](packages/${slug}) | ${choices} | ${yes(slug, 'cardFormat') ? 'Cards' : 'Text'} | ${yes(slug, 'streaming') ? 'Streamed' : 'Posted whole'} | ${points ? '`connect` gives it' : 'You enter it'} |`;
  });
  return ["| Channel | Package | Choices | Cards | Answers | Your server's address |", '|---|---|---|---|---|---|', ...rows].join('\n');
}

/** The README with its table written in, or as it is where it has no place for one. */
function readmeWithTable(text) {
  const [open, close] = ['<!-- channels:start -->', '<!-- channels:end -->'];
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  if (from < 0 || to < from) throw new Error(`README.md has no ${open} … ${close} for the table of channels`);
  return `${text.slice(0, from + open.length)}\n${channelTable()}\n${text.slice(to)}`;
}

/** The same words the core gives each variable: kept beside the README so it needs no build to write. */
function variablesOf(slug, name) {
  return {
    [`${slug}_user_id`]: `The ${name} ID of the person in this conversation.`,
    [`${slug}_user_name`]: `The person's name in ${name}. Empty when ${name} doesn't say.`,
    [`${slug}_thread_id`]: `The ${name} conversation this turn is in, as Chat SDK names it.`,
    [`${slug}_message_id`]: "The ID of the person's latest message. Empty when the turn came from a button.",
  };
}

function pascal(slug) {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stale = [];
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const unknown = only.filter((slug) => !CHANNELS.includes(slug));
  if (unknown.length) {
    console.error(`Not a channel this writes: ${unknown.join(', ')}. It writes: ${CHANNELS.join(', ')}.`);
    process.exit(2);
  }
  for (const slug of only.length ? only : CHANNELS) {
    for (const [path, raw] of Object.entries(files(slug))) {
      const file = join(root, path);
      const text = formatted(path, raw);
      const now = existsSync(file) ? await readFile(file, 'utf8') : undefined;
      if (now === text) continue;
      if (check) stale.push(path);
      else {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      }
    }
    const license = join(root, `packages/${slug}/LICENSE`);
    if (!existsSync(license)) {
      if (check) stale.push(`packages/${slug}/LICENSE`);
      else await copyFile(join(root, 'LICENSE'), license);
    }
  }
  if (!only.length) {
    const readme = join(root, 'README.md');
    const now = await readFile(readme, 'utf8');
    const next = readmeWithTable(now);
    if (next !== now) {
      if (check) stale.push('README.md (its table of channels)');
      else await writeFile(readme, next);
    }
  }
  if (stale.length) {
    console.error(`Not as scripts/channels.mjs writes them:\n${stale.map((path) => `  ${path}`).join('\n')}\nRun: node scripts/channels.mjs`);
    process.exit(1);
  }
  const n = only.length || CHANNELS.length;
  console.log(check ? `channels: ${n} packages are current` : `channels: wrote ${n} packages`);
}
