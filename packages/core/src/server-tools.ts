// Server tools: tools the agent calls whose code runs here, in your app, and
// not in Voiceflow. The agent gets a small Voiceflow function for each one
// (the same for every tool: `callServerTool`), which sends the model's inputs
// to your server with the turn's pass. Your server works out from the pass
// which conversation and person the call is for, and runs the tool.
//
// So a tool's credentials stay in your app's environment, the model never
// chooses who a tool acts for, and a tool's logic ships with your code: a
// change needs no reinstall unless its name, description or inputs change.
import type { Thread } from 'chat';
import { callServerTool } from './sandbox/call-server.js';
import { functionSource, type ToolDefinition, type ToolSet } from './tools.js';

/** The agent variable that carries each turn's pass. The server sets it; the model never sees or fills it. */
export const PASS_VARIABLE = 'channels_turn_pass';
/** The secret that holds your server's tools URL, per environment. Not sensitive: a secret is how Voiceflow keeps a value per environment. */
export const TOOLS_URL_SECRET = 'channels_tools_url';
/** The header that marks a request as a server tool's call. */
export const TOOL_CALL_HEADER = 'x-voiceflow-tool-call';
/** Raised when `callServerTool` changes, so every installed server tool is updated. */
export const CALLER_VERSION = 1;

/** The turn a tool call belongs to, as the server knows it from the call's pass. */
export interface ToolTurn {
  /** The conversation the agent was in when it called the tool. */
  thread: Thread<any, any>;
  /**
   * The person that turn was for, as the channel identifies them, where it
   * says. It can be another app's ID (a bot's message starts a turn too):
   * check it is someone your tool should act for.
   */
  userId?: string;
  /** `true` when the person has approved this call, or when approval is turned off for the tool. */
  approved: boolean;
}

/** What a tool returns to the model: whether it worked, what to tell the person, and any outputs it declares. */
export interface ToolResult {
  ok: boolean;
  /** What happened, said so the agent can tell the person. */
  result: string;
  [output: string]: string | number | boolean;
}

/** What a tool returns when the person must approve the call first. See `askFirst`. */
export interface ApprovalRequest {
  approval: {
    /** What will happen, as a question for the person: `Post this message?` */
    title: string;
    /**
     * Everything they are approving, as markdown: where it goes and what it
     * says, in full. It is shown whole, so a call whose text is too long to
     * show isn't asked and isn't done. Put what the model wrote through `quoted`.
     */
    text?: string;
    /**
     * What to run with once approved, when it should differ from what the
     * model gave: the ID a name was looked up to, so the approval is for
     * exactly what the request showed.
     */
    input?: Record<string, string>;
  };
}

export type ToolOutcome = ToolResult | ApprovalRequest;

export interface ServerTool {
  /** The tool's name in Voiceflow, which the model calls: snake_case, starting with a letter. */
  name: string;
  /** What the tool does and when to call it. The model reads this. */
  description: string;
  /** What the model gives the tool, by input name, with what each holds. Every value arrives as a string. */
  inputs?: Record<string, string>;
  /** What the tool returns beyond `ok` and `result`, by output name, with what each holds. */
  outputs?: Record<string, string>;
  /** Raise it when the name, description, inputs or outputs change: an installed copy is updated to it. Default: 1. */
  version?: number;
  /** What the channel's app needs for this tool to work (Slack OAuth scopes, say). */
  requires?: string[];
  /**
   * `true`: the person is asked before every call, with the tool's name and
   * inputs. A tool that only sometimes needs approval, or wants to word the
   * question itself, returns `askFirst(…)` from `run` while `turn.approved` is
   * false. `false`: the tool has nothing to approve (it only reads), so
   * `requireApproval: true` leaves it alone.
   */
  approval?: boolean;
  /** Default: Voiceflow's (20 seconds). */
  timeoutMs?: number;
  /**
   * Runs the tool. It is called again, with `turn.approved` true, when the
   * person approves a call it asked about, so it makes its checks every time.
   */
  run(input: Record<string, string>, turn: ToolTurn): ToolOutcome | Promise<ToolOutcome>;
}

/**
 * Returned from a tool's `run` to ask the person before going further. The
 * tool runs again once they approve, with `input` when given: pass the IDs
 * the tool resolved names to, so what runs is what the request showed.
 */
export function askFirst(title: string, text?: string, input?: Record<string, string>): ApprovalRequest {
  return { approval: { title, ...(text ? { text } : {}), ...(input ? { input } : {}) } };
}

/**
 * Text someone else wrote (the model, usually) as a markdown quote, every line
 * of it, for a request for approval: the person can tell what the tool says
 * (where it goes, who it's for) from what the text itself claims.
 */
export function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED = new Set([PASS_VARIABLE, TOOLS_URL_SECRET, 'ok', 'result']);

function check(tool: ServerTool): void {
  if (!NAME.test(tool.name)) throw new TypeError(`A server tool's name is snake_case, up to 64 characters, starting with a letter: "${tool.name}" isn't.`);
  for (const input of Object.keys(tool.inputs ?? {})) {
    if (!/^\w{1,64}$/.test(input) || RESERVED.has(input)) throw new TypeError(`${tool.name}: "${input}" can't be an input's name.`);
  }
  for (const output of Object.keys(tool.outputs ?? {})) {
    if (!/^\w{1,64}$/.test(output) || RESERVED.has(output)) throw new TypeError(`${tool.name}: "${output}" can't be an output's name.`);
  }
}

/** A server tool as the installer puts it on the agent: `callServerTool` under the tool's name, with the tool's inputs. */
export function serverToolDefinition(tool: ServerTool): ToolDefinition {
  check(tool);
  const inputs: ToolDefinition['inputs'] = {};
  for (const [name, description] of Object.entries(tool.inputs ?? {})) inputs[name] = { description };
  inputs[TOOLS_URL_SECRET] = { description: `Where your server runs this tool, from the ${TOOLS_URL_SECRET} secret.`, from: TOOLS_URL_SECRET };
  inputs[PASS_VARIABLE] = {
    description: `This turn's pass, from the ${PASS_VARIABLE} variable. It tells your server which conversation is asking.`,
    from: PASS_VARIABLE,
  };
  return {
    name: tool.name,
    kind: 'server',
    // Higher when either the tool or the function every tool shares changes.
    version: (tool.version ?? 1) + CALLER_VERSION - 1,
    description: tool.description,
    // Built when it's read: only an install needs it, and a bundled server renames the function it's built from.
    get code() {
      return functionSource(callServerTool).replace('__CHANNELS_TOOL__', () => tool.name);
    },
    inputs,
    outputs: { ok: 'Whether it worked.', result: 'What happened, to tell the person.', ...tool.outputs },
    ...(tool.requires ? { requires: tool.requires } : {}),
    ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
  };
}

/** The variable and the secret every server tool reads. Add them to a tool set that holds server tools. */
export const SERVER_TOOL_VARIABLES = {
  [PASS_VARIABLE]: 'Set by your server on every turn: the pass its tools send back, so the server knows which conversation is asking. Not for prompts.',
} as const;
export const SERVER_TOOL_SECRETS = {
  [TOOLS_URL_SECRET]: 'Where your server runs its tools (https://…). Set by connect, or by installTools.',
} as const;

/** Your own server tools as a set for `installTools`. `channel` names the install record: use your app's name. */
export function serverToolSet(channel: string, tools: readonly ServerTool[]): ToolSet {
  return { channel, variables: { ...SERVER_TOOL_VARIABLES }, secrets: { ...SERVER_TOOL_SECRETS }, tools: tools.map(serverToolDefinition) };
}
