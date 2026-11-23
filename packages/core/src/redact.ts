// Known secret values, taken out of text before anyone sees it. A command
// knows the secrets it holds (an API key, a login, an app's tokens); a server
// it calls may repeat one back in an error. So text from outside is cleaned
// where an error is made, before it is cut to length (a cut could leave most
// of a value), and everything a command prints is cleaned once more on its way out.

const HIDDEN = '[hidden]';
/** Shorter than this, a value is as likely a word as a secret, and replacing it would garble the text. */
const SHORTEST = 8;

/** Every way a value is likely to be written: as it is, in a URL or a form, and inside JSON. */
function forms(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])];
}

/** `text` with each of these values replaced by `[hidden]`. Values under 8 characters, and empty ones, are left. */
export function redact(text: string, values: readonly (string | null | undefined)[]): string {
  const needles = values
    .filter((value): value is string => typeof value === 'string' && value.length >= SHORTEST)
    .flatMap(forms)
    // Longest first, so a value that holds another is replaced whole.
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of needles) out = out.split(needle).join(HIDDEN);
  return out;
}

export interface Redactor {
  /** Remembers values to hide from now on: call it as soon as a secret exists. */
  add(...values: (string | null | undefined)[]): void;
  /** `text` without any value added so far. */
  redact(text: string): string;
}

/** A redactor for one command's run: it learns secrets as the command gets them. */
export function createRedactor(...initial: (string | null | undefined)[]): Redactor {
  const known = new Set<string>();
  const add = (...values: (string | null | undefined)[]) => {
    for (const value of values) if (typeof value === 'string' && value.length >= SHORTEST) known.add(value);
  };
  add(...initial);
  return { add, redact: (text) => redact(text, [...known]) };
}
