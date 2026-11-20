// Voiceflow traces become channel-neutral replies. This is the only module
// that knows what a trace looks like (shapes from the v4 runtime spec,
// general-runtime `openapi.public.json`). A trace it doesn't know is skipped
// and reported, never thrown, so a new runtime trace can't break a channel.
import type { Trace, VoiceflowAction } from './voiceflow.js';

export interface Source {
  url: string;
  name?: string;
}

/** A choice the person can make: a button, or a numbered line in text. */
export interface Choice {
  label: string;
  /** The request sent to Voiceflow when it's chosen. */
  action: VoiceflowAction;
  /**
   * A link the button opens, from its `open_url` action. Voiceflow's web chat
   * opens the link and still sends the request, so the flow moves on; channels
   * that report link clicks do the same here.
   */
  url?: string;
}

export interface CardData {
  title: string;
  description?: string;
  imageUrl?: string;
  choices: Choice[];
}

export type Reply =
  | { type: 'text'; markdown: string; sources: Source[] }
  | { type: 'choices'; choices: Choice[] }
  | { type: 'card'; card: CardData }
  | { type: 'carousel'; cards: CardData[] }
  | { type: 'image'; url: string }
  /** A trace the channel shows natively (a channel extension's custom type), kept in its place in the turn. */
  | { type: 'trace'; trace: Trace };

export interface Translation {
  replies: Reply[];
  /** The agent ended the conversation (an `end` trace). */
  ended: boolean;
  /** Trace types left out because a messaging channel can't show them. */
  skipped: string[];
}

/** Traces that carry nothing for a person to read, so they're dropped silently. */
const SILENT = new Set([
  'block', 'path', 'flow', 'goto', 'debug', 'log', 'no-reply', 'reasoning', 'knowledgeBase',
  'tool-call', 'entity-filling', 'stream', 'simulation-test-result', 'realtime-agent', 'dtmf',
]);

export interface TranslateOptions {
  /** Trace types the channel shows natively: kept as `trace` replies, in order, instead of skipped. */
  custom?: (type: string) => boolean;
}

export function translate(traces: readonly Trace[], options: TranslateOptions = {}): Translation {
  const replies: Reply[] = [];
  const skipped: string[] = [];
  let ended = false;
  // Streamed completions arrive as start / content… / end, keyed by messageID.
  const streams = new Map<string, { text: string; sources: Source[]; index: number }>();

  for (const trace of traces) {
    const p = trace?.payload;
    switch (trace?.type) {
      case 'text': {
        pushText(replies, p?.message, sourcesOf(p?.sourceUrls));
        break;
      }
      case 'speak': {
        pushText(replies, stripMarkup(p?.message), []);
        break;
      }
      case 'completion': {
        const id = String(p?.messageID ?? '_');
        if (p?.state === 'start') {
          replies.push({ type: 'text', markdown: '', sources: sourcesOf(p?.sourceUrls) });
          streams.set(id, { text: '', sources: sourcesOf(p?.sourceUrls), index: replies.length - 1 });
        } else if (p?.state === 'content') {
          const s = streams.get(id) ?? openStream(replies, streams, id);
          s.text += typeof p?.content === 'string' ? p.content : '';
          (replies[s.index] as Extract<Reply, { type: 'text' }>).markdown = s.text;
        } else if (p?.state === 'end') {
          const s = streams.get(id);
          const end = sourcesOf(p?.sourceUrls);
          if (s && end.length) (replies[s.index] as Extract<Reply, { type: 'text' }>).sources = end;
          streams.delete(id);
        }
        break;
      }
      case 'choice': {
        const choices = choicesOf(p?.buttons);
        if (choices.length) replies.push({ type: 'choices', choices });
        break;
      }
      case 'cardV2': {
        const card = cardOf(p);
        if (card) replies.push({ type: 'card', card });
        break;
      }
      case 'carousel': {
        const cards = (Array.isArray(p?.cards) ? p.cards : []).map(cardOf).filter(Boolean) as CardData[];
        if (cards.length) replies.push({ type: 'carousel', cards });
        break;
      }
      case 'visual': {
        if (typeof p?.image === 'string' && p.image) replies.push({ type: 'image', url: p.image });
        break;
      }
      case 'end': {
        ended = true;
        break;
      }
      default: {
        if (typeof trace?.type === 'string' && options.custom?.(trace.type)) replies.push({ type: 'trace', trace });
        else if (!SILENT.has(trace?.type)) skipped.push(String(trace?.type ?? 'unknown'));
      }
    }
  }

  return {
    replies: replies.filter((r) => r.type !== 'text' || r.markdown.trim() !== ''),
    ended,
    skipped,
  };
}

function openStream(replies: Reply[], streams: Map<string, { text: string; sources: Source[]; index: number }>, id: string) {
  replies.push({ type: 'text', markdown: '', sources: [] });
  const s = { text: '', sources: [], index: replies.length - 1 };
  streams.set(id, s);
  return s;
}

function pushText(replies: Reply[], message: unknown, sources: Source[]) {
  if (typeof message === 'string' && message.trim()) replies.push({ type: 'text', markdown: message.trim(), sources });
}

/** Knowledge-base sources on a trace (`sourceUrls`). */
export function sourcesOf(value: unknown): Source[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s) => s && typeof s.url === 'string')
    .map((s) => (typeof s.name === 'string' ? { url: s.url, name: s.name } : { url: s.url }));
}

function choicesOf(buttons: unknown): Choice[] {
  if (!Array.isArray(buttons)) return [];
  return buttons
    .filter((b) => b && typeof b.name === 'string' && b.name.trim())
    .map((b) => {
      const choice: Choice = {
        label: b.name.trim(),
        action: b.request && typeof b.request.type === 'string' ? b.request : { type: 'text', payload: b.name.trim() },
      };
      const url = urlOf(b.request);
      if (url) choice.url = url;
      return choice;
    });
}

/** A button's link lives in an `open_url` action on its request (`@voiceflow/base-types` `ActionType.OPEN_URL`). */
function urlOf(request: any): string | undefined {
  const actions = request?.payload?.actions;
  if (!Array.isArray(actions)) return undefined;
  const url = actions.find((a) => a?.type === 'open_url')?.payload?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
}

function cardOf(card: any): CardData | null {
  if (!card || typeof card.title !== 'string') return null;
  const description = typeof card.description?.text === 'string' && card.description.text.trim() ? card.description.text.trim() : undefined;
  const imageUrl = typeof card.imageUrl === 'string' && card.imageUrl ? card.imageUrl : undefined;
  return { title: card.title, description, imageUrl, choices: choicesOf(card.buttons) };
}

/** A spoken reply can carry SSML or an <audio> clip; a messaging channel shows only its words. */
function stripMarkup(message: unknown): string {
  if (typeof message !== 'string') return '';
  return message.replace(/<audio[^>]*>[\s\S]*?<\/audio>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
