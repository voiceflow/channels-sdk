#!/usr/bin/env node
// `voiceflow-channels <connect|disconnect> <channel>`: hands the command to the
// channel's package (`@voiceflow/channels-<channel>/connect`), which knows how
// to make that channel's app and install its tools.
const [action, channel, ...rest] = process.argv.slice(2);

const USAGE = `Usage: voiceflow-channels <connect|disconnect> <channel> [options]
       voiceflow-channels connect slack --help`;

async function main(): Promise<number> {
  if (!action || !channel || !['connect', 'disconnect'].includes(action) || !/^[a-z0-9-]+$/.test(channel)) {
    console.log(USAGE);
    return action === '--help' || action === '-h' ? 0 : 2;
  }
  const name = `@voiceflow/channels-${channel}/connect`;
  let mod: { cli?: (argv: string[]) => Promise<number> };
  try {
    mod = await import(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes(`channels-${channel}`)) {
      console.error(`No ${channel} package: install @voiceflow/channels-${channel}.`);
      return 2;
    }
    throw error;
  }
  if (typeof mod.cli !== 'function') {
    console.error(`@voiceflow/channels-${channel} has no connect command.`);
    return 2;
  }
  return mod.cli([action, ...rest]);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  },
);
