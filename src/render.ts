// Channel-neutral replies become Chat SDK posts, shaped by what the channel
// can show (its catalog capabilities). Where a channel lacks buttons or cards,
// the reply degrades to text with numbered choices, and the person answers
// with the number or the label.
import { Actions, Button, Card, CardText, Image, LinkButton, type Thread } from 'chat';
import type { ChannelCapabilities } from './catalog.js';
import type { CardData, Choice, Reply, Source } from './translate.js';

export type Post = Parameters<Thread['post']>[0];

export interface RenderOptions {
  /** Show knowledge-base sources under a reply. Default: `off`. */
  sources?: 'off' | 'links';
}

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

export function parseActionId(id: string): { nonce: string; index: number } | null {
  const m = /^vf:([a-z0-9]+):(\d+)$/.exec(id);
  return m ? { nonce: m[1]!, index: Number(m[2]) } : null;
}

export interface Renderer {
  /** The Chat SDK posts for one reply. Choices are numbered across everything this renderer has shown. */
  render(reply: Reply): Post[];
  /** Records choices offered some other way (as suggested prompts, say), so a typed label still picks one. */
  offer(choices: readonly Choice[]): void;
  readonly choices: Choice[];
  readonly nonce: string;
}

/** One renderer per turn: its replies share one numbering and one nonce. */
export function createRenderer(caps: ChannelCapabilities, options: RenderOptions = {}): Renderer {
  const nonce = Math.random().toString(36).slice(2, 10);
  const choices: Choice[] = [];

  const offer = (list: readonly Choice[]) =>
    list.map((choice) => {
      choices.push(choice);
      return { choice, index: choices.length - 1 };
    });

  // A link the channel can't attach to a button would be lost, so a group with one goes as text.
  const canButton = (list: readonly Choice[]) => caps.buttons && (caps.linkButtons || list.every((c) => !c.url));

  const buttons = (list: readonly Choice[]) =>
    Actions(
      offer(list).map(({ choice, index }) =>
        choice.url
          ? LinkButton({ id: actionId(nonce, index), label: choice.label, url: choice.url })
          : Button({ id: actionId(nonce, index), label: choice.label, value: String(index) }),
      ),
    );

  const numbered = (list: readonly Choice[]) =>
    offer(list)
      .map(({ choice, index }) => `${index + 1}. ${choice.url ? `[${choice.label}](${choice.url})` : choice.label}`)
      .join('\n');

  // A card whose buttons the channel can't show goes as text, so its choices stay answerable.
  const card = (data: CardData): Post => {
    if (caps.cards && (!data.choices.length || canButton(data.choices))) {
      const children = [];
      if (data.description) children.push(CardText(data.description));
      if (data.choices.length) children.push(buttons(data.choices));
      return Card({ title: data.title, imageUrl: caps.imagesInCards ? data.imageUrl : undefined, children });
    }
    const lines = [`**${data.title}**`];
    if (data.description) lines.push(data.description);
    if (data.imageUrl) lines.push(data.imageUrl);
    if (data.choices.length) lines.push(numbered(data.choices));
    return { markdown: lines.join('\n') };
  };

  return {
    nonce,
    choices,
    offer(list) {
      offer(list);
    },
    render(reply) {
      switch (reply.type) {
        case 'text':
          return [{ markdown: withSources(reply.markdown, reply.sources, options.sources ?? 'off') }];
        case 'choices':
          // A card of buttons alone has no text, so its labels are the fallback where a channel shows one
          // (a notification, a screen reader). Slack's adapter ignores it today: see docs/upstream.md.
          return [
            canButton(reply.choices)
              ? { card: Card({ children: [buttons(reply.choices)] }), fallbackText: reply.choices.map((c) => c.label).join(' · ') }
              : { markdown: numbered(reply.choices) },
          ];
        case 'card':
          return [card(reply.card)];
        case 'carousel':
          // No carousel in Chat SDK yet (vercel/chat#1126): one message per card.
          return reply.cards.map(card);
        case 'image':
          return [caps.cards && caps.imagesInCards ? Card({ children: [Image({ url: reply.url })] }) : { markdown: reply.url }];
      }
    },
  };
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
