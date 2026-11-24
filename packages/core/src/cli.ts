#!/usr/bin/env node
// `voiceflow-channelkit <connect|disconnect|point> <channel>`: hands the command
// to the channel's package (`@voiceflow/channelkit-<channel>/connect`), which
// knows how to make that channel's app, install its tools, and point it at an
// address. `voiceflow-channelkit dev` is this package's own: a tunnel, your
// server, and every channel pointed at it (dev.ts).
import { dev } from './dev.js';
import { NeedsYou } from './errors.js';
import { redact } from './redact.js';

const [action, channel, ...rest] = process.argv.slice(2);

const USAGE = `Usage: voiceflow-channelkit <connect|disconnect|point> <channel> [options]
       voiceflow-channelkit dev [options] -- <your server's command>
       voiceflow-channelkit connect slack --help
       voiceflow-channelkit dev --help`;

async function main(): Promise<number> {
  if (action === 'dev') return dev(process.argv.slice(3));
  if (!action || !channel || !['connect', 'disconnect', 'point'].includes(action) || !/^[a-z0-9-]+$/.test(channel)) {
    console.log(USAGE);
    return action === '--help' || action === '-h' ? 0 : 2;
  }
  const name = `@voiceflow/channelkit-${channel}/connect`;
  let mod: { cli?: (argv: string[]) => Promise<number> };
  try {
    mod = await import(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes(`channels-${channel}`)) {
      console.error(`No ${channel} package: install @voiceflow/channelkit-${channel}.`);
      return 2;
    }
    throw error;
  }
  if (typeof mod.cli !== 'function') {
    console.error(`@voiceflow/channelkit-${channel} has no connect command.`);
    return 2;
  }
  return mod.cli([action, ...rest]);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // A channel's command cleans what it prints of the secrets it holds. This is for an error from before it starts.
    console.error(redact(String(error?.message ?? error), [process.env.VOICEFLOW_API_KEY]));
    process.exit(error instanceof NeedsYou ? 3 : 1);
  },
);
