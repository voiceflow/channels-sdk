// A Notion comment has no lists. The adapter takes a list's marks off as it
// writes a comment ("1. " and "- " at the start of a line), so a numbered
// list of choices would arrive as bare lines, with nothing to answer by. So a
// list is written here in marks a comment keeps: "(1)" and "•".

/** The agent's text with each list item's mark written as Notion keeps it. Code blocks are left as they are. */
export function text(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (mark && (!fence || (mark[0] === fence[0] && mark.length >= fence.length))) {
        fence = fence ? undefined : mark;
        return line;
      }
      if (fence) return line;
      return line.replace(/^([\t ]*)(\d+)\.[\t ]+/, '$1($2) ').replace(/^([\t ]*)[-*+][\t ]+/, '$1• ');
    })
    .join('\n');
}
