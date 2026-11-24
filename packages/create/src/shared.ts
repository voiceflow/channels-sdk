// What each channel's starter text shares: the package managers, and how each runs a script.

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** How each package manager runs a script with arguments: only npm needs the `--`. */
export function runScript(pm: PackageManager, script: string, args = ''): string {
  const run = pm === 'npm' || pm === 'bun' ? `${pm} run ${script}` : `${pm} ${script}`;
  return args ? `${run}${pm === 'npm' ? ' --' : ''} ${args}` : run;
}

/** What the starter writes that differs by channel: the app's own words. */
export interface ChannelStarter {
  /** The channel's name as people write it: "Slack". */
  label: string;
  /** README.md: the app, for a person. */
  readme(name: string, pm: PackageManager, environment: string): string;
  /** AGENTS.md: the app, for a coding agent asked to set it up. */
  agentsMd(name: string, pm: PackageManager, environment: string): string;
  /** The steps printed once the app is made, each a line. */
  next(pm: PackageManager, environment: string, hasProject: boolean): string[];
  /** Lines the app's .gitignore gets beyond the starter's own. */
  gitignore?: string;
}
