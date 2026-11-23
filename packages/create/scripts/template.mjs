// Builds the starter's template from the example app, so there is one copy of
// the app: examples/nextjs-slack, which CI builds on every run. What the
// starter writes is that app, with a package.json, README and .gitignore of its own.
//
// template/ is a build product, like dist/: it is made here and never edited.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const example = new URL('../../../examples/nextjs-slack/', import.meta.url);
const template = new URL('../template/', import.meta.url);

await rm(template, { recursive: true, force: true });
await mkdir(template, { recursive: true });
// The app's own files. Not its package.json or README (the starter writes those), and nothing Next.js generates.
for (const path of ['app', 'next.config.ts', 'tsconfig.json']) {
  await cp(new URL(path, example), new URL(path, template), { recursive: true });
}
// Under another name: a published package can't be trusted to keep a dotfile.
await cp(new URL('.env.example', example), new URL('env.example', template));

// The versions the example is built and tested with become the new app's.
const { dependencies, devDependencies, scripts } = JSON.parse(await readFile(new URL('package.json', example), 'utf8'));
await writeFile(new URL('app.json', template), `${JSON.stringify({ dependencies, devDependencies, scripts }, null, 2)}\n`);
console.log(`template: ${fileURLToPath(template)}`);
