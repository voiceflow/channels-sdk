#!/usr/bin/env node
// The command `npm create @voiceflow/channelkit` runs.
import { create } from './index.js';

create(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  },
);
