// Tier 1: build any catalog adapter without platform code. The catalog names
// the package and its factory; the adapter reads its own env vars (the ones
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
  /** Overrides module loading (tests, bundlers). */
  importer?: Importer;
}

export async function loadAdapter(slug: string, { options, importer = defaultImporter }: LoadAdapterOptions = {}): Promise<Adapter> {
  const entry = platformEntry(slug);
  let mod: Record<string, unknown>;
  try {
    mod = await importer(entry.packageName);
  } catch (cause) {
    throw new ChannelsError(
      'adapter_not_installed',
      `The ${entry.name} adapter isn't installed. Run: npm install ${entry.packageName}`,
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
