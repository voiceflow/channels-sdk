// A reply longer than a platform shows in one message goes as several. Some
// adapters cut a long message short and say nothing (Discord's, at 2,000
// characters), so the end of an answer would be lost. The cut is made where
// the text breaks: between paragraphs, else lines, else sentences, else
// words. A code block cut in two is closed in one message and opened again in
// the next, so both still read as code.

/** How long a text is as the platform counts it. */
export type Measure = (markdown: string) => number;

/** A limit too small to split by: whatever it was meant to be, nothing sensible fits in it. */
const MIN_LIMIT = 40;
/** A break is taken only in the last half of what fits, so a message is never mostly empty. */
const BREAK_FROM = 0.5;

const FENCE = /^[ \t]*(```+|~~~+)(.*)$/;

/** The line that opened the code block `text` ends inside of, or `null` when it ends outside any. */
function fenceOpenIn(text: string): string | null {
  let open: { marker: string; line: string } | null = null;
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line);
    if (!fence) continue;
    if (!open) open = { marker: fence[1]!, line: line.trim() };
    else if (fence[1]!.startsWith(open.marker[0]!) && fence[1]!.length >= open.marker.length && !fence[2]!.trim()) open = null;
  }
  return open?.line ?? null;
}

/** A line that leads into what follows it: a heading, or a line ending in a colon. Short, and not a finished sentence. */
const leadsIn = (block: string) => !block.includes('\n') && block.length <= 80 && !/[.!?…]["')\]*_]*$/.test(block.trimEnd());

/**
 * A cut at the paragraph break `at`, moved back over a heading: one left at the end of a message, with what it
 * heads in the next, reads as a stray line. Returns `at` when what's before it is no heading.
 */
function beforeHeading(text: string, at: number): number {
  let cut = at;
  while (cut > 0) {
    const previous = text.lastIndexOf('\n\n', cut - 1);
    if (previous < 0 || !leadsIn(text.slice(previous + 2, cut))) break;
    cut = previous;
  }
  return cut;
}

/** The last line break that isn't a paragraph's: a paragraph's was taken above, or passed over for the heading before it. */
function lastLineBreak(text: string): number {
  for (let at = text.lastIndexOf('\n'); at >= 0; at = text.lastIndexOf('\n', at - 1)) {
    if (text[at - 1] !== '\n' && text[at + 1] !== '\n') return at;
  }
  return -1;
}

/** Where to cut `text` at or before `limit`: after the last paragraph, line, sentence or word that ends in its last half. */
function breakBefore(text: string, limit: number): number {
  const from = Math.floor(limit * BREAK_FROM);
  const within = text.slice(0, limit);
  const paragraph = beforeHeading(within, within.lastIndexOf('\n\n'));
  if (paragraph >= from) return paragraph;
  const line = lastLineBreak(within);
  if (line >= from) return line;
  let sentence = -1;
  for (const match of within.matchAll(/[.!?…]["')\]]?(?=\s)/g)) sentence = match.index + match[0].length;
  if (sentence >= from) return sentence;
  const word = within.lastIndexOf(' ');
  if (word >= from) return word;
  // One unbroken run (a long URL, say): cut it, but never through the middle of a character.
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

/**
 * Splits `markdown` into parts none longer than `max`, as `measure` counts them (by default, in characters).
 * Text that fits comes back as it was.
 */
export function splitMarkdown(markdown: string, max: number, measure: Measure = (text) => text.length): string[] {
  return split(markdown, max, measure, true);
}

/**
 * The same for text that is sent as it is written, mark for mark: it is as long as its characters, and a line of
 * backticks in it is only that, so nothing is added to close or open a code block.
 */
export function splitText(text: string, max: number): string[] {
  return split(text, max, (part) => part.length, false);
}

function split(markdown: string, max: number, measure: Measure, fences: boolean): string[] {
  const openFence = fences ? fenceOpenIn : () => null;
  const closed = (text: string) => (openFence(text) ? `${text}\n\`\`\`` : text);
  if (!(max >= MIN_LIMIT) || measure(markdown) <= max) return [markdown];
  const parts: string[] = [];
  let rest = markdown;
  // The opening line of a code block the last cut went through: the next part begins with it.
  let fence: string | null = null;
  while (rest) {
    const head = fence ? `${fence}\n` : '';
    if (measure(head + rest) <= max) {
      parts.push(head + rest);
      break;
    }
    // The most of the text that fits, found by halving: what a platform is sent isn't always as long as what was written.
    let low = 1;
    let high = rest.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (measure(closed(head + rest.slice(0, middle))) <= max) low = middle;
      else high = middle - 1;
    }
    const at = Math.max(1, breakBefore(rest, low));
    const piece = (head + rest.slice(0, at)).trimEnd();
    fence = openFence(piece);
    parts.push(fence ? `${piece}\n\`\`\`` : piece);
    // Inside a code block the next line's indentation is the code's own: only the line break goes.
    rest = fence ? rest.slice(at).replace(/^\n/, '') : rest.slice(at).trimStart();
  }
  return parts;
}
