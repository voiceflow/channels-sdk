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
  ordered?: boolean | null;
  start?: number | null;
  children?: Node[];
}

function inline(nodes: readonly Node[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'break':
          return '\n';
        case 'link': {
          const text = inline(node.children ?? []).trim();
          const url = node.url ?? '';
          // A bare address, or an email written as one, is said once.
          if (!text || text === url || url === `mailto:${text}`) return text || url;
          return `${text} (${url})`;
        }
        case 'image':
          return node.alt ? `${node.alt} (${node.url ?? ''})` : (node.url ?? '');
        default:
          return node.children ? inline(node.children) : (node.value ?? '');
      }
    })
    .join('');
}

function block(node: Node): string {
  switch (node.type) {
    case 'list': {
      const first = node.start ?? 1;
      return (node.children ?? [])
        .map((item, index) => {
          const mark = node.ordered ? `${first + index}. ` : '- ';
          // What follows an item's first line sits under its words, not its mark.
          const [head = '', ...rest] = blocks(item.children ?? [], '\n').split('\n');
          return [mark + head, ...rest.map((line) => (line ? ' '.repeat(mark.length) + line : line))].join('\n');
        })
        .join('\n');
    }
    case 'code':
    case 'html':
      return node.value ?? '';
    case 'table':
      return (node.children ?? []).map((row) => (row.children ?? []).map((cell) => inline(cell.children ?? []).trim()).join(' | ')).join('\n');
    case 'thematicBreak':
      return '';
    case 'blockquote':
      return blocks(node.children ?? []);
    default:
      return node.children ? inline(node.children) : (node.value ?? '');
  }
}

function blocks(nodes: readonly Node[], between = '\n\n'): string {
  return nodes
    .map(block)
    .filter((text) => text !== '')
    .join(between);
}

/** Markdown as plain words: no marks, a list still numbered, a link's address still there. */
export function toPlain(markdown: string): string {
  try {
    return blocks((parseMarkdown(markdown) as unknown as Node).children ?? []);
  } catch {
    // Text that can't be read as Markdown goes as it is: nothing is lost.
    return markdown;
  }
}
