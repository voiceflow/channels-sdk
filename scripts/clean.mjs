// Empties a package's dist before it is built, so nothing an earlier build left
// there is packed with it. tsc writes over what it builds and never removes a
// file whose source is gone.
//
//   node ../../scripts/clean.mjs      from a package, as its build script does
import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
