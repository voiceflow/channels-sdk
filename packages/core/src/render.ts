// Channel-neutral replies become Chat SDK posts, shaped by what the channel
// can show (its catalog capabilities). Where a channel lacks buttons or cards,
// the reply degrades to text with numbered choices, and the person answers
// with the number or the label.
import { Actions, Button, Card, CardText, Image, LinkButton, Select, SelectOption, type Thread } from 'chat';
import type { ChannelCapabilities } from './catalog.js';
import type { CardData, Choice, Reply, Source } from './translate.js';

export type Post = Parameters<Thread['post']>[0];

export interface RenderOptions {
  /** Show knowledge-base sources under a reply. Default: `off`. */
  sources?: 'off' | 'links';
  /**
   * The most choices shown as buttons. A longer list becomes a menu where the
   * channel has select menus (and keeps its buttons where it doesn't). Default: 5.
   */
  maxButtons?: number;
  /** The menu's placeholder. Default: `Choose an option`. */
  menuPlaceholder?: string;
}

export const DEFAULT_MAX_BUTTONS = 5;
const DEFAULT_MENU_PLACEHOLDER = 'Choose an option';
const MENU = 'menu';

export interface Rendered {
  posts: Post[];
  /** Every choice offered this turn, numbered from 1 in the order shown. */
  choices: Choice[];
  /** Identifies this turn's buttons, so a click on an older message can be told apart. */
  nonce: string;
}

export const ACTION_PREFIX = 'vf';

export function actionId(nonce: string, index: number): string {
  return `${ACTION_PREFIX}:${nonce}:${index}`;
}

/** The ID of a turn's menu. The picked option's value is the choice's number. */
export function menuId(nonce: string): string {
  return `${ACTION_PREFIX}:${nonce}:${MENU}`;
}

/** The turn and the choice an action picked: a button's ID, or a menu's ID and the picked option's value. */
export function parseActionId(id: string, value?: string): { nonce: string; index: number } | null {
  const m = /^vf:([a-z0-9]+):(\d+|menu)$/.exec(id);
  if (!m) return null;
  const index = m[2] === MENU ? Number(value) : Number(m[2]);
  return Number.isInteger(index) && index >= 0 ? { nonce: m[1]!, index } : null;
}

/**
 * A posted message with buttons, as it was shown: enough to show it again
 * without them once its turn is over. `first` is the number its first choice
 * had in the turn (from 0).
 */
export type ButtonsShown = { kind: 'card'; card: CardData; first: number } | { kind: 'choices'; choices: Choice[]; first: number };

export interface Renderer {
  /** The Chat SDK posts for one reply. Choices are numbered across everything this renderer has shown. */
  render(reply: Reply): Post[];
  /** Records choices offered some other way (as suggested prompts, say), so a typed label still picks one. */
  offer(choices: readonly Choice[]): void;
  /** A post's text form, numbered as shown, for when the channel refuses it. `null` for a post that is already text. */
  textOf(post: Post): Post | null;
  /** What a post with buttons showed. `null` for a post without buttons. */
  buttonsOf(post: Post): ButtonsShown | null;
  readonly choices: Choice[];
  readonly nonce: string;
}

type Offered = { choice: Choice; index: number }[];

/** One renderer per turn: its replies share one numbering and one nonce. */
export function createRenderer(caps: ChannelCapabilities, options: RenderOptions = {}): Renderer {
  const nonce = Math.random().toString(36).slice(2, 10);
  const choices: Choice[] = [];
  const texts = new WeakMap<object, Post>();
  const shown = new WeakMap<object, ButtonsShown>();

  const offer = (list: readonly Choice[]): Offered =>
    list.map((choice) => {
      choices.push(choice);
      return { choice, index: choices.length - 1 };
    });
  const firstOf = (offered: Offered) => offered[0]?.index ?? choices.length;

  // A link the channel can't attach to a button would be lost, so a group with one goes as text.
  const canButton = (list: readonly Choice[]) => caps.buttons && (caps.linkButtons || list.every((c) => !c.url));
  // A long list is a menu where the channel has one. A menu can't open a link, so a list with one keeps its buttons.
  const asMenu = (list: readonly Choice[]) => caps.selectMenus && list.length > (options.maxButtons ?? DEFAULT_MAX_BUTTONS) && list.every((c) => !c.url);

  const menu = (offered: Offered) =>
    Actions([
      Select({
        id: menuId(nonce),
        label: options.menuPlaceholder ?? DEFAULT_MENU_PLACEHOLDER,
        placeholder: options.menuPlaceholder ?? DEFAULT_MENU_PLACEHOLDER,
        options: offered.map(({ choice, index }) => SelectOption({ label: choice.label, value: String(index) })),
      }),
    ]);

  const buttons = (offered: Offered) =>
    Actions(
      offered.map(({ choice, index }) =>
        choice.url
          ? LinkButton({ id: actionId(nonce, index), label: choice.label, url: choice.url })
          : Button({ id: actionId(nonce, index), label: choice.label, value: String(index) }),
      ),
    );

  const numbered = (offered: Offered) =>
    offered.map(({ choice, index }) => `${index + 1}. ${choice.url ? `[${choice.label}](${choice.url})` : choice.label}`).join('\n');

  const cardText = (data: CardData, offered: Offered): Post => {
    const lines = [`**${data.title}**`];
    if (data.description) lines.push(data.description);
    if (data.imageUrl) lines.push(data.imageUrl);
    if (offered.length) lines.push(numbered(offered));
    return { markdown: lines.join('\n') };
  };

  // Every rich post keeps its text form, and every post with buttons what it showed.
  const keep = <P extends Post>(post: P, text: Post, buttonsShown?: ButtonsShown): P => {
    texts.set(post as object, text);
    if (buttonsShown) shown.set(post as object, buttonsShown);
    return post;
  };

  // A card whose buttons the channel can't show goes as text, so its choices stay answerable.
  const card = (data: CardData): Post => {
    const offered = offer(data.choices);
    const text = cardText(data, offered);
    const inMenu = offered.length > 0 && asMenu(data.choices);
    if (!caps.cards || (offered.length && !inMenu && !canButton(data.choices))) return text;
    const children = [];
    if (data.description) children.push(CardText(data.description));
    if (offered.length) children.push(inMenu ? menu(offered) : buttons(offered));
    const post = Card({ title: data.title, imageUrl: caps.imagesInCards ? data.imageUrl : undefined, children });
    return keep(post, text, offered.length ? { kind: 'card', card: data, first: firstOf(offered) } : undefined);
  };

  return {
    nonce,
    choices,
    offer(list) {
      offer(list);
    },
    textOf: (post) => texts.get(post as object) ?? null,
    buttonsOf: (post) => shown.get(post as object) ?? null,
    render(reply) {
      switch (reply.type) {
        case 'text':
          return [{ markdown: withSources(reply.markdown, reply.sources, options.sources ?? 'off') }];
        case 'choices': {
          const offered = offer(reply.choices);
          const text = { markdown: numbered(offered) };
          if (asMenu(reply.choices)) {
            const post = { card: Card({ children: [menu(offered)] }), fallbackText: reply.choices.map((c) => c.label).join(' · ') };
            return [keep(post, text, { kind: 'choices', choices: reply.choices, first: firstOf(offered) })];
          }
          if (!canButton(reply.choices)) return [text];
          // A card of buttons alone has no text, so its labels are the fallback where a channel shows one
          // (a notification, a screen reader). Slack's adapter ignores it today: see docs/upstream.md.
          const post = { card: Card({ children: [buttons(offered)] }), fallbackText: reply.choices.map((c) => c.label).join(' · ') };
          return [keep(post, text, { kind: 'choices', choices: reply.choices, first: firstOf(offered) })];
        }
        case 'card':
          return [card(reply.card)];
        case 'carousel':
          // No carousel in Chat SDK yet (vercel/chat#1126): one message per card.
          return reply.cards.map(card);
        case 'image': {
          const text = { markdown: reply.url };
          return [caps.cards && caps.imagesInCards ? keep(Card({ children: [Image({ url: reply.url })] }), text) : text];
        }
        case 'trace':
          // Shown by the channel's extension, not rendered.
          return [];
      }
    },
  };
}

/**
 * A message with buttons, shown again without them once its turn is over. The
 * choice that was picked, if it was one of this message's, shows as "✓ label";
 * a message of buttons alone otherwise keeps its labels as plain text.
 */
export function retired(buttonsShown: ButtonsShown, picked: number | null, caps: ChannelCapabilities): Post {
  const list = buttonsShown.kind === 'card' ? buttonsShown.card.choices : buttonsShown.choices;
  const at = picked === null ? -1 : picked - buttonsShown.first;
  const mark = at >= 0 && at < list.length ? `✓ ${list[at]!.label}` : null;
  if (buttonsShown.kind === 'card') {
    const { title, description, imageUrl } = buttonsShown.card;
    const children = [];
    if (description) children.push(CardText(description));
    if (mark) children.push(CardText(mark));
    return Card({ title, imageUrl: caps.imagesInCards ? imageUrl : undefined, children });
  }
  // Still a card, so the edit replaces the buttons rather than adding text beside them.
  return Card({ children: [CardText(mark ?? list.map((c) => c.label).join(' · '))] });
}

/** Renders a whole turn at once. */
export function render(replies: readonly Reply[], caps: ChannelCapabilities, options: RenderOptions = {}): Rendered {
  const renderer = createRenderer(caps, options);
  const posts = replies.flatMap((reply) => renderer.render(reply));
  return { posts, choices: renderer.choices, nonce: renderer.nonce };
}

export function withSources(markdown: string, sources: readonly Source[], mode: 'off' | 'links'): string {
  if (mode === 'off' || !sources.length) return markdown;
  const links = sources.map((s) => `[${s.name ?? s.url}](${s.url})`).join(' · ');
  return `${markdown}\n\nSources: ${links}`;
}

/** The choice a typed answer picks: its number ("2", "2.") or its exact label. */
export function matchTypedChoice(text: string, choices: readonly Choice[]): Choice | null {
  const t = text.trim();
  const n = /^(\d{1,2})[.)]?$/.exec(t);
  if (n) return choices[Number(n[1]) - 1] ?? null;
  const lower = t.toLowerCase();
  return choices.find((c) => c.label.toLowerCase() === lower) ?? null;
}
