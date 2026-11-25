// A channel as every channel package gives one to `createChannels`: Chat
// SDK's adapter for the platform, the adapter's module (so a bundled server
// needs nothing loaded by name), and what every channel has whatever the
// platform: who and where, set as variables for the agent's prompts.
//
// A platform's own package (@voiceflow/channels-slack, …) builds on the same
// thing and adds what only that platform has.
import { type ChannelCapabilities, platformEntry } from './catalog.js';
import type { ChannelSpec } from './channels.js';
import type { ChannelExtension, TurnContext } from './extension.js';

export interface ChannelOptions {
  /** The adapter's own config. Omit it to let the adapter read its env vars. */
  adapter?: Record<string, unknown>;
  /**
   * Set who and where as `<channel>_*` variables on every turn, for the
   * agent's prompts. Default: `true`. The agent sees one only where its
   * instructions or global prompt reference it.
   */
  context?: boolean;
  /**
   * Whether the bot goes on answering a conversation it was mentioned in,
   * without being mentioned again. `false` has it answer only where it is
   * mentioned. Default: `true`, except where a conversation is a whole room.
   */
  follow?: boolean;
}

/** What a channel's package knows of its platform beyond the catalog. */
export interface ChannelTraits {
  /** The longest text the platform shows in one message, where the adapter would cut a longer one short or have it refused. */
  maxTextLength?: number;
  /** Adapter options the channel turns on by default. The caller's own options win. */
  adapterDefaults?: Record<string, unknown>;
  /** True where the platform shows text as it is typed: the agent's Markdown is sent as plain words. */
  plainText?: boolean;
  /** What the platform can show, where this package knows it better than the catalog: `{ buttons, maxButtons, … }`. */
  capabilities?: Partial<ChannelCapabilities>;
  /** `false` where a conversation is a whole room: the bot then answers a mention, and not everyone after it. */
  follow?: boolean;
  /** Rewrites the agent's text into what the platform shows, before it is posted. */
  text?: (markdown: string) => string;
}

/** Every variable a channel sets, with what it holds: `<slug>_user_id` and the rest. `connect` creates them on the agent. */
export function contextVariables(slug: string): Record<string, string> {
  const { name } = platformEntry(slug);
  return {
    [`${slug}_user_id`]: `The ${name} ID of the person in this conversation.`,
    [`${slug}_user_name`]: `The person's name in ${name}. Empty when ${name} doesn't say.`,
    [`${slug}_thread_id`]: `The ${name} conversation this turn is in, as Chat SDK names it.`,
    [`${slug}_message_id`]: "The ID of the person's latest message. Empty when the turn came from a button.",
  };
}

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

/** The turn's context variables: every one, every turn, empty when unknown. Never throws. */
function createContext(slug: string) {
  const names = Object.keys(contextVariables(slug));
  // Who someone is, kept a while: a button's click says only their ID.
  const people = new Map<string, { name: string; at: number }>();
  return (ctx: TurnContext): Record<string, string> => {
    const out = Object.fromEntries(names.map((name) => [name, '']));
    const author = ctx.message?.author;
    const userId = ctx.userId ?? author?.userId ?? '';
    out[`${slug}_user_id`] = userId;
    out[`${slug}_thread_id`] = ctx.thread?.id ?? '';
    out[`${slug}_message_id`] = ctx.message?.id ?? '';
    if (!userId) return out;
    if (author && author.userId === userId) {
      if (people.size >= MAX_ENTRIES && !people.has(userId)) people.delete(people.keys().next().value!);
      // An adapter with no name to give fills it with the person's ID or number: that is no name.
      const name = author.fullName || author.userName || '';
      people.set(userId, { name: name === userId ? '' : name, at: Date.now() });
    }
    const known = people.get(userId);
    out[`${slug}_user_name`] = known && Date.now() - known.at < TTL_MS ? known.name : '';
    return out;
  };
}

/** What every channel has, whatever the platform: its variables, and what its package says of the platform. */
export function createChannelExtension(slug: string, options: ChannelOptions = {}, traits: ChannelTraits = {}): ChannelExtension {
  const context = createContext(slug);
  return {
    slug,
    ...(traits.adapterDefaults ? { adapterDefaults: traits.adapterDefaults } : {}),
    ...(traits.maxTextLength ? { maxTextLength: traits.maxTextLength } : {}),
    ...(traits.plainText ? { plainText: true } : {}),
    ...(traits.text ? { text: traits.text } : {}),
    ...(traits.capabilities ? { capabilities: traits.capabilities } : {}),
    ...((options.follow ?? traits.follow) === false ? { follow: false } : {}),
    // Never throws: a failed hook would send no variables, and the session would keep the last turn's.
    ...(options.context === false ? {} : { variables: (ctx) => context(ctx) }),
  };
}

/**
 * A channel for `createChannels`. `module` is the adapter's package, imported
 * by the channel's own package, so a bundled server (Next.js, say) needs no
 * adapter loaded by a name it only learns at run time.
 */
export function channel(slug: string, module: Record<string, unknown>, options: ChannelOptions = {}, traits: ChannelTraits = {}): ChannelSpec {
  return { slug, options: options.adapter, module, extension: createChannelExtension(slug, options, traits) };
}
