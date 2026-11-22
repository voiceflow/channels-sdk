// Everything this package knows about a platform comes from the Chat SDK
// catalog (`@chat-adapter/catalog`): which package holds the adapter, which
// factory builds it, what it can render and which credentials it reads.
// Nothing here names a platform.
import { type CatalogAdapter, getAdapter, getFeatureSupport, getSecretEnvVars, listEnvVars, listPlatformAdapters } from '@chat-adapter/catalog';
import { ChannelsError } from './errors.js';

export type { CatalogAdapter };

/** What a channel can show, read from the catalog's feature table. */
export interface ChannelCapabilities {
  /** Clickable reply buttons. */
  buttons: boolean;
  /** Buttons that open a link. */
  linkButtons: boolean;
  /** Rich cards: a title, text, an image and buttons in one message. */
  cards: boolean;
  /** Images inside cards. */
  imagesInCards: boolean;
  /** A "typing…" indicator while the agent works. */
  typingIndicator: boolean;
  /** Replies that appear as they're written, with live progress where the channel has it. */
  streaming: boolean;
  /** Editing a sent message, which takes an earlier turn's buttons off it. */
  editMessages: boolean;
  /** Select menus, which show a long list of choices in one control. */
  selectMenus: boolean;
}

/** The catalog entry for a platform adapter, or a `ChannelsError`. */
export function platformEntry(slug: string): CatalogAdapter {
  const entry = getAdapter(slug);
  if (!entry) {
    throw new ChannelsError('unknown_channel', `"${slug}" is not in the Chat SDK adapter catalog.`);
  }
  if (entry.type !== 'platform') {
    throw new ChannelsError('not_a_platform', `"${slug}" is a ${entry.type} adapter, not a messaging platform.`);
  }
  return entry;
}

/** Every messaging platform the installed catalog lists. */
export function listChannels(): readonly CatalogAdapter[] {
  return listPlatformAdapters();
}

/** Only a full "yes" counts. "partial" renders through the text fallback. */
function supported(slug: string, feature: Parameters<typeof getFeatureSupport>[1]): boolean {
  return getFeatureSupport(slug, feature).status === 'yes';
}

export function capabilities(slug: string): ChannelCapabilities {
  platformEntry(slug);
  return {
    buttons: supported(slug, 'buttons'),
    linkButtons: supported(slug, 'linkButtons'),
    cards: supported(slug, 'cardFormat'),
    imagesInCards: supported(slug, 'imagesInCards'),
    typingIndicator: supported(slug, 'typingIndicator'),
    streaming: supported(slug, 'streaming'),
    editMessages: supported(slug, 'editMessage'),
    selectMenus: supported(slug, 'selectMenus'),
  };
}

/** The credential env vars an adapter reads, as the catalog lists them. */
export function credentialVars(slug: string): { key: string; secret: boolean; description?: string }[] {
  platformEntry(slug);
  return listEnvVars(slug).map((v) => ({ key: v.key, secret: v.secret === true, description: v.description }));
}

/** The env vars the catalog marks as secret. */
export function secretVars(slug: string): string[] {
  platformEntry(slug);
  return getSecretEnvVars(slug).map((v) => v.key);
}
