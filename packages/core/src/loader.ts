// Builds any adapter in Chat SDK's catalog. The catalog names the package
// and its factory; the adapter reads its own env vars (the ones
// the catalog lists) when no options are given, so a self-hosted bot needs
// nothing but those env vars set.
import type { Adapter } from 'chat';
import { platformEntry } from './catalog.js';
import { ChannelsError } from './errors.js';

export type Importer = (specifier: string) => Promise<Record<string, unknown>>;

const defaultImporter: Importer = (specifier) => import(specifier);

export interface LoadAdapterOptions {
  /** The adapter's own config, passed to its factory unchanged. Omit it to let the adapter read its env vars. */
  options?: Record<string, unknown>;
  /**
   * The adapter's package, already imported (`import * as slackAdapter from '@chat-adapter/slack'`).
   * A bundled server (Next.js, say) needs it: a bundler can't follow an import
   * of a name it only learns at run time. Without it, the package is imported by
   * the name the catalog gives.
   */
  module?: Record<string, unknown>;
  /** Overrides module loading (tests). */
  importer?: Importer;
}

export async function loadAdapter(slug: string, { options, module, importer = defaultImporter }: LoadAdapterOptions = {}): Promise<Adapter> {
  const entry = platformEntry(slug);
  let mod: Record<string, unknown>;
  try {
    // An adapter can live at a path within a package that holds another's (X Chat, in X's): the catalog says where.
    mod = module ?? (await importer((entry as { importPath?: string }).importPath ?? entry.packageName));
  } catch (cause) {
    throw new ChannelsError(
      'adapter_not_installed',
      `The ${entry.name} adapter couldn't be loaded. If it isn't installed, run: npm install ${entry.packageName}. ` +
        `If your server is bundled (Next.js, say), pass its module: { slug: '${slug}', module: await import('${entry.packageName}') }.`,
      { cause },
    );
  }
  const factory = mod[entry.factoryExport];
  if (typeof factory !== 'function') {
    throw new ChannelsError(
      'adapter_factory_missing',
      `${entry.packageName} has no "${entry.factoryExport}" export. Its version may not match the installed catalog.`,
    );
  }
  return (options === undefined ? factory() : factory(options)) as Adapter;
}
