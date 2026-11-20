// A channel's tools, as Voiceflow functions the agent calls. Each channel
// package ships its own set (its "default install"): the installer creates
// them on the agent once, and from then on they are the agent's to change.
//
// A tool is either presentation, a function that returns a custom trace this
// package renders in the channel, or workspace, a function that calls the
// channel's own API from Voiceflow with the channel's token as a secret.

/** One input of a tool's function. */
export interface ToolInput {
  /** What it holds. The model reads it when it fills the input. */
  description: string;
  /**
   * The agent variable or secret the runtime fills this input from, by name
   * (`slack_user_id`, `slack_bot_token`). The model is never asked for it and
   * can't change it, so identity and credentials never come from the model.
   * Without it, the model supplies the input.
   */
  from?: string;
}

export interface ToolDefinition {
  /**
   * The function's name in Voiceflow, which is also the tool name the model
   * calls: snake_case, starting with the channel (`slack_react`).
   */
  name: string;
  /** What the tool does and when to call it. The model reads this. */
  description: string;
  /** The function's source: `export default async function main(args) { … }`. See `functionSource`. */
  code: string;
  inputs: Record<string, ToolInput>;
  /** What the function returns to the model, by output name. */
  outputs?: Record<string, string>;
  /** The function's exit paths. Default: `success` and `error`. */
  paths?: string[];
  /** Default: Voiceflow's. */
  timeoutMs?: number;
  /** Raise it when the code or wiring changes: an installed copy you haven't edited is updated to it. */
  version: number;
  /** What the channel's app needs for this tool to work (Slack OAuth scopes, say). The channel's connect command reads it. */
  requires?: string[];
  /** `presentation` tools return a trace this package renders; `workspace` tools call the channel's API themselves. */
  kind: 'presentation' | 'workspace';
}

/** A channel's tools and what they read. */
export interface ToolSet {
  /** The channel's slug (`slack`). Install records are kept per channel. */
  channel: string;
  /** Agent variables the tools read, by name, with what each holds. Created when missing. */
  variables?: Record<string, string>;
  /** Secrets the tools read, by name, with what each holds. Created when missing. */
  secrets?: Record<string, string>;
  tools: ToolDefinition[];
}

export const DEFAULT_PATHS = ['success', 'error'] as const;

/**
 * A function's source, from real functions so it can be written, typed and
 * tested as code: each helper becomes a top-level declaration, and `entry`
 * (any named async function) becomes `export default async function main`.
 * Every function must be self-contained (reaching nothing outside itself but
 * its helpers and the sandbox's globals), because only its text reaches Voiceflow.
 */
export function functionSource(entry: (args: any) => Promise<unknown>, helpers: ((...args: any[]) => unknown)[] = []): string {
  const declaration = /^(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/;
  const text = (fn: (...args: any[]) => unknown) => {
    const source = fn.toString();
    if (!declaration.test(source)) throw new TypeError(`functionSource: ${fn.name || 'a helper'} must be a named function declaration, not an arrow or method`);
    return source;
  };
  const main = entry.toString();
  if (!/^async\s+function\s+[A-Za-z_$][\w$]*\s*\(/.test(main)) throw new TypeError('functionSource: the entry must be a named async function declaration');
  return [...helpers.map(text), `export default ${main.replace(/^async\s+function\s+[A-Za-z_$][\w$]*\s*\(/, 'async function main(')}`].join('\n\n') + '\n';
}

/** Every scope (or other requirement) a set's tools need, deduplicated and sorted. */
export function requirementsOf(tools: readonly ToolDefinition[]): string[] {
  return [...new Set(tools.flatMap((t) => t.requires ?? []))].sort();
}
