// Channel-neutral replies become Chat SDK posts, shaped by what the channel
// can show (its catalog capabilities). Where a channel lacks buttons or cards,
// the reply degrades to text with numbered choices, and the person answers
// with the number or the label.
import { Actions, Button, Card, CardText, Image, type Thread } from 'chat';
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

export function render(replies: readonly Reply[], caps: ChannelCapabilities, options: RenderOptions = {}): Rendered {
  const nonce = Math.random().toString(36).slice(2, 10);
  const choices: Choice[] = [];
  const posts: Post[] = [];

  const offer = (list: Choice[]) =>
    list.map((choice) => {
      choices.push(choice);
      return { choice, index: choices.length - 1 };
    });

  const buttons = (list: Choice[]) =>
    Actions(offer(list).map(({ choice, index }) => Button({ id: actionId(nonce, index), label: choice.label, value: String(index) })));

  const numbered = (list: Choice[]) => offer(list).map(({ choice, index }) => `${index + 1}. ${choice.label}`).join('\n');

  // A card whose buttons the channel can't show goes as text, so its choices stay answerable.
  const card = (data: CardData): Post => {
    if (caps.cards && (caps.buttons || !data.choices.length)) {
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

  for (const reply of replies) {
    switch (reply.type) {
      case 'text':
        posts.push({ markdown: withSources(reply.markdown, reply.sources, options.sources ?? 'off') });
        break;
      case 'choices':
        // A card of buttons alone has no text, so its labels are the fallback where a channel shows one
        // (a notification, a screen reader). Slack's adapter ignores it today: see docs/upstream.md.
        posts.push(
          caps.buttons
            ? { card: Card({ children: [buttons(reply.choices)] }), fallbackText: reply.choices.map((c) => c.label).join(' · ') }
            : { markdown: numbered(reply.choices) },
        );
        break;
      case 'card':
        posts.push(card(reply.card));
        break;
      case 'carousel':
        for (const c of reply.cards) posts.push(card(c));
        break;
      case 'image':
        posts.push(caps.cards && caps.imagesInCards ? Card({ children: [Image({ url: reply.url })] }) : { markdown: reply.url });
        break;
    }
  }
  return { posts, choices, nonce };
}

function withSources(markdown: string, sources: Source[], mode: 'off' | 'links'): string {
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
