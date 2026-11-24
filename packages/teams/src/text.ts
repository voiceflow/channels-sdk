// Text on its way in and out of Teams, put right where the adapter leaves it:
// the bot's own mention taken out of what a person wrote, and headings, which
// Teams doesn't show, made bold lines.
import type { TeamsActivity } from './adapter.js';

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a person wrote, without the bot's own mention. The adapter turns Teams' `<at>Name</at>` into "@Name" and
 * takes it out only when the bot was set up under that very name. Teams says which mention is the bot's (the one
 * whose ID is the activity's recipient), and under what words, so it is taken out by that: "@Acme Support
 * where's my order?" reaches the agent as "where's my order?", whatever the bot is called.
 *
 * A message that is only the mention is left as it is, as the core leaves one: an agent sent nothing has
 * nothing to answer.
 */
export function withoutOwnMention(text: string, activity: TeamsActivity | undefined): string {
  const bot = activity?.recipient?.id;
  if (!bot || !Array.isArray(activity?.entities)) return text;
  const names = new Set<string>();
  for (const entity of activity.entities) {
    if (entity?.type !== 'mention' || entity.mentioned?.id !== bot) continue;
    // The words the mention was written with: Teams lets a person shorten them.
    const written = String(entity.text ?? '')
      .replace(/<\/?at[^>]*>/gi, '')
      .trim();
    for (const name of [written, entity.mentioned?.name]) if (name) names.add(name);
  }
  if (!names.size) return text;
  // The longest first, so "@Acme Support" goes whole and not as "@Acme" with " Support" left behind.
  const forms = [...names].sort((a, b) => b.length - a.length).map((name) => `(?<![\\w@])@${escaped(name)}(?![\\w-])`);
  const stripped = text
    .replace(new RegExp(forms.join('|'), 'gi'), ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
  return stripped || text;
}

const FENCE = /^\s{0,3}(```+|~~~+)/;
const HEADING = /^(\s{0,3})#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/**
 * The agent's markdown as Teams shows it. Teams has no headings: the adapter sends a heading's words as a plain
 * line, and an answer loses its shape. Each becomes a bold line. Code is left as it is.
 */
export function forTeams(markdown: string): string {
  if (!markdown.includes('#')) return markdown;
  // A block of code runs from its fence to one of the same mark, at least as long, with nothing after it.
  let fence: { mark: string; length: number } | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = { mark: marker[0]!, length: marker.length };
        else if (marker[0] === fence.mark && marker.length >= fence.length && line.trim() === marker) fence = undefined;
        return line;
      }
      if (fence) return line;
      const heading = HEADING.exec(line);
      if (!heading) return line;
      // Already bold, in part or whole: one pair of marks round the line, not two.
      const words = heading[2]!.replace(/\*\*|__/g, '').trim();
      return words ? `${heading[1]}**${words}**` : line;
    })
    .join('\n');
}
