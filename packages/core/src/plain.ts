// Markdown as plain words, for a platform that shows text as it is typed: a
// text message, Messenger, Instagram. The agent writes Markdown; there its
// marks would show as asterisks and brackets. Chat SDK's own plain-text form
// drops a list's numbers and a link's address, and a numbered list is how a
// person answers a choice: so this one keeps both.
import { parseMarkdown } from 'chat';

interface Node {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  /** What a link or picture written by reference, and the line that says where it leads, are matched by. */
  identifier?: string;
  ordered?: boolean | null;
  start?: number | null;
  children?: Node[];
}

/** Where each reference leads: `[docs]: https://…`, written apart from the link that uses it. */
type Defined = ReadonlyMap<string, string>;

function definitions(node: Node, found = new Map<string, string>()): Map<string, string> {
  if (node.type === 'definition' && node.identifier && node.url) found.set(node.identifier, node.url);
  for (const child of node.children ?? []) definitions(child, found);
  return found;
}

function inline(nodes: readonly Node[], defined: Defined): string {
  return nodes
    .map((node) => {
      // A link or a picture written by reference leads where its definition says.
      const url = node.url ?? defined.get(node.identifier ?? '') ?? '';
      switch (node.type) {
        case 'break':
          return '\n';
        case 'link':
        case 'linkReference': {
          const text = inline(node.children ?? [], defined).trim();
          // A bare address, or an email written as one, is said once.
          if (!text || !url || text === url || url === `mailto:${text}`) return text || url;
          return `${text} (${url})`;
        }
        case 'image':
        case 'imageReference':
          return node.alt && url ? `${node.alt} (${url})` : node.alt || url;
        default:
          return node.children ? inline(node.children, defined) : (node.value ?? '');
      }
    })
    .join('');
}

function block(node: Node, defined: Defined): string {
  switch (node.type) {
    case 'list': {
      const first = node.start ?? 1;
      return (node.children ?? [])
        .map((item, index) => {
          const mark = node.ordered ? `${first + index}. ` : '- ';
          // What follows an item's first line sits under its words, not its mark.
          const [head = '', ...rest] = blocks(item.children ?? [], defined, '\n').split('\n');
          return [mark + head, ...rest.map((line) => (line ? ' '.repeat(mark.length) + line : line))].join('\n');
        })
        .join('\n');
    }
    case 'code':
    case 'html':
      return node.value ?? '';
    case 'table':
      return (node.children ?? []).map((row) => (row.children ?? []).map((cell) => inline(cell.children ?? [], defined).trim()).join(' | ')).join('\n');
    case 'thematicBreak':
    // Where a reference leads is said beside the words that use it, not on a line of its own.
    case 'definition':
      return '';
    case 'blockquote':
      return blocks(node.children ?? [], defined);
    default:
      return node.children ? inline(node.children, defined) : (node.value ?? '');
  }
}

function blocks(nodes: readonly Node[], defined: Defined, between = '\n\n'): string {
  return nodes
    .map((node) => block(node, defined))
    .filter((text) => text !== '')
    .join(between);
}

/** Markdown as plain words: no marks, a list still numbered, a link's address still there. */
export function toPlain(markdown: string): string {
  try {
    const root = parseMarkdown(markdown) as unknown as Node;
    return blocks(root.children ?? [], definitions(root));
  } catch {
    // Text that can't be read as Markdown goes as it is: nothing is lost.
    return markdown;
  }
}
