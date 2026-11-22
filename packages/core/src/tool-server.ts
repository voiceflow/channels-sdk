// Runs server tools. It mints each turn's pass, answers the calls the agent's
// tools make from Voiceflow, and asks the person first where a tool wants
// their approval.
//
// What a call may do is settled here, never by the call: the pass says which
// conversation and person it is for, the tool is looked up among those this
// bot offers on that channel, and an approval is taken only from a click (or a
// typed word) the channel itself verified as the person who asked. What they
// approve is what they were shown: a request too long to show in full is not
// asked, and so not done.
import { createHash, randomBytes } from 'node:crypto';
import { type ActionEvent, Actions, type AdapterPostableMessage, Button, Card, CardText, type Chat, type StateAdapter, type Thread } from 'chat';
import type { ChannelCapabilities } from './catalog.js';
import type { ChannelExtension, TurnContext } from './extension.js';
import { mintPass, newTurnId, passKey, readPass } from './pass.js';
import {
  type ApprovalRequest,
  quoted,
  type ServerTool,
  serverToolDefinition,
  TOOL_CALL_HEADER,
  type ToolOutcome,
  type ToolResult,
  type ToolTurn,
} from './server-tools.js';

type AnyThread = Thread<any, any>;

/** Which tools ask the person first. See `VoiceflowAgentOptions.requireApproval`. */
export type ApprovalPolicy = boolean | Readonly<Record<string, boolean>>;

export interface ToolServerOptions {
  /** Your own tools, offered on every channel. */
  tools: readonly ServerTool[];
  /** Each channel's extension, by slug: its tools are offered on its channel only. */
  extensions: ReadonlyMap<string, ChannelExtension>;
  /** The secret passes are signed with. */
  secret: () => string | Promise<string>;
  /** How long a pass can last: a turn's longest. */
  passTtlMs: number;
  requireApproval?: ApprovalPolicy;
  /** How long a request for approval waits. Default: 10 minutes. */
  approvalTtlMs?: number;
  /** The bot the agent is attached to, once it is. */
  bot: () => Chat<any, any> | undefined;
  capabilities: (thread: AnyThread) => ChannelCapabilities;
  report: (error: unknown, ctx?: Partial<TurnContext>) => void;
}

export interface ToolServer {
  /** Whether any server tool can be called from this thread. */
  offers(thread: AnyThread): boolean;
  /** A pass for one turn. */
  mint(ctx: TurnContext): Promise<{ pass: string; turn: string }>;
  /** Ends a turn: its pass stops working wherever the bot's state is shared. */
  end(turn: string): Promise<void>;
  /** Answers a tool's call. */
  handle(request: Request): Promise<Response>;
  /** Takes a click on an approval's buttons. `false` when the action is something else. */
  choose(event: ActionEvent<any>): Promise<boolean>;
  /** Takes a typed `approve` or `cancel` where the channel has no buttons. `false` when it wasn't one. */
  typed(thread: AnyThread, userId: string | undefined, text: string): Promise<boolean>;
}

export const APPROVE_ACTION = 'vfa:approve';
export const CANCEL_ACTION = 'vfa:cancel';

const KEY = 'voiceflow:tools';
const DEFAULT_APPROVAL_TTL = 10 * 60_000;
/** Under Voiceflow's default function timeout (20 s), so the agent gets an answer instead of a timeout. */
const DEFAULT_RUN_TIMEOUT = 18_000;
const MAX_BODY = 2 * 1024 * 1024;
/** The most a request for approval can show. Anything longer isn't asked: nobody approves what they can't see. */
export const MAX_APPROVAL_TEXT = 12_000;
/** A card's text goes in pieces a channel takes (Slack: 3000 characters a section). */
const TEXT_PIECE = 2800;
const MAX_TITLE = 150;

const NOT_LIVE = "This tool call didn't come from a turn that's still running, so nothing was done.";
const NO_ONE = "I can't tell who's asking, so there's no one to approve this.";
const FAILED = 'Something went wrong on the server while doing that.';
const EXPIRED = 'That request has expired. Ask me again.';
const NOT_YOURS = 'Only the person who asked can approve this.';

interface Pending {
  tool: string;
  /** What runs once approved: what the model gave, or what the tool resolved it to. */
  input: Record<string, string>;
  /** The conversation the call came from, which the tool acts for. */
  thread: string;
  /** That conversation's channel, and the request's own message once it's posted: a click must come from there. */
  channel: string;
  messageId?: string;
  user: string;
  title: string;
  text?: string;
  expires: number;
  /** The key that stops the same request being asked twice. */
  asked: string;
}

/** Whether a request is a server tool's call (and not a platform's webhook). */
export function isToolCall(request: Request): boolean {
  return request.headers.has(TOOL_CALL_HEADER);
}

function json(status: number, body: { ok: boolean; result: string; outputs?: Record<string, string | number | boolean> }): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function isApproval(outcome: ToolOutcome): outcome is ApprovalRequest {
  return typeof (outcome as ApprovalRequest).approval === 'object' && (outcome as ApprovalRequest).approval !== null;
}

/** A tool's answer is a result or a request for approval, and nothing else. */
function isOutcome(outcome: unknown): outcome is ToolOutcome {
  if (!outcome || typeof outcome !== 'object') return false;
  if (isApproval(outcome as ToolOutcome)) return typeof (outcome as ApprovalRequest).approval.title === 'string';
  return typeof (outcome as ToolResult).ok === 'boolean' && typeof (outcome as ToolResult).result === 'string';
}

/** A long text as pieces a card can hold, cut at line ends; a quoted line that must be cut stays quoted. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let current = '';
  const push = (line: string) => {
    if (current && current.length + 1 + line.length > TEXT_PIECE) {
      out.push(current);
      current = line;
    } else current = current ? `${current}\n${line}` : line;
  };
  for (const line of text.split('\n')) {
    const mark = line.startsWith('> ') ? '> ' : '';
    let rest = line;
    while (rest.length > TEXT_PIECE) {
      // Between words where it can be: nothing is dropped either way.
      const space = rest.lastIndexOf(' ', TEXT_PIECE - 1);
      const cut = space > TEXT_PIECE / 2 ? space + 1 : TEXT_PIECE;
      push(rest.slice(0, cut));
      rest = mark + rest.slice(cut);
    }
    push(rest);
  }
  if (current) out.push(current);
  return out;
}

export function createToolServer(options: ToolServerOptions): ToolServer {
  const approvalTtl = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL;

  // Every tool is checked as it would be for an install, and a name means one tool on any channel.
  for (const tool of options.tools) serverToolDefinition(tool);
  const own = new Set(options.tools.map((t) => t.name));
  if (own.size !== options.tools.length) throw new TypeError('Two of your server tools have the same name.');
  for (const [slug, extension] of options.extensions) {
    const names = new Set<string>();
    for (const tool of extension.tools ?? []) {
      serverToolDefinition(tool);
      if (own.has(tool.name) || names.has(tool.name))
        throw new TypeError(`Two server tools are named ${tool.name} (one is ${slug}'s). A tool's name is its own.`);
      names.add(tool.name);
    }
  }

  const toolsOf = (thread: AnyThread): readonly ServerTool[] => [...options.tools, ...(options.extensions.get(thread.adapter.name)?.tools ?? [])];
  const state = (): StateAdapter | undefined => options.bot()?.getState();

  let cached: { secret: string; key: Buffer } | undefined;
  async function key(): Promise<Buffer> {
    const secret = await options.secret();
    if (cached?.secret !== secret) cached = { secret, key: passKey(secret) };
    return cached.key;
  }

  /**
   * `never`: approved from the start. `always`: asked before the tool runs at
   * all. `tool`: the tool asks when it needs to. A tool that says it has
   * nothing to approve (`approval: false`: it only reads) is asked about only
   * when named.
   */
  function policy(tool: ServerTool): 'never' | 'always' | 'tool' {
    const set = options.requireApproval;
    const named = typeof set === 'object' ? set[tool.name] : undefined;
    if (set === false || named === false) return 'never';
    if (named === true || tool.approval === true) return 'always';
    return set === true && tool.approval !== false ? 'always' : 'tool';
  }

  /** Only what the tool declares, each as a string: a call can't hand a tool an input it doesn't have. */
  function inputsOf(tool: ServerTool, given: unknown): Record<string, string> {
    const from = given && typeof given === 'object' ? (given as Record<string, unknown>) : {};
    const out: Record<string, string> = {};
    for (const name of Object.keys(tool.inputs ?? {})) {
      const value = from[name];
      out[name] = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return out;
  }

  /** Runs a tool. What it throws is reported, and the agent hears only that it failed. */
  async function run(tool: ServerTool, input: Record<string, string>, turn: ToolTurn, timeoutMs?: number): Promise<ToolOutcome> {
    const ctx = { thread: turn.thread, userId: turn.userId };
    const running = Promise.resolve()
      .then(() => tool.run(input, turn))
      .then((outcome): ToolOutcome => {
        if (isOutcome(outcome)) return outcome;
        options.report(new TypeError(`${tool.name} returned neither a result ({ ok, result }) nor a request for approval.`), ctx);
        return { ok: false, result: FAILED };
      })
      .catch((error: unknown): ToolResult => {
        options.report(error, ctx);
        return { ok: false, result: FAILED };
      });
    if (!timeoutMs) return running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, result: "That's taking too long. It may still finish: check before trying it again." }), timeoutMs);
    });
    try {
      return await Promise.race([running, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A request as a post: all of its text, then (while it waits) how to answer, or (once it's over) how it ended. */
  function card(pending: Pick<Pending, 'title' | 'text'>, end: { id: string; buttons: boolean } | { outcome: string }): AdapterPostableMessage {
    const text = pending.text ? pieces(pending.text) : [];
    if ('id' in end && !end.buttons) {
      const lines = [`**${pending.title}**`, ...text, 'Reply **approve** to go ahead, or **cancel**. Only the person who asked can.'];
      return { markdown: lines.join('\n\n') } as AdapterPostableMessage;
    }
    const last =
      'id' in end
        ? [
            CardText('Only the person who asked can approve this.'),
            Actions([
              Button({ id: APPROVE_ACTION, label: 'Approve', value: end.id, style: 'primary' }),
              Button({ id: CANCEL_ACTION, label: 'Cancel', value: end.id }),
            ]),
          ]
        : [CardText(end.outcome)];
    return Card({ title: pending.title, children: [...text.map((piece) => CardText(piece)), ...last] }) as unknown as AdapterPostableMessage;
  }

  /** Asks the person to approve a call, once: the same call asked again (an agent retries) gets the same answer and no second request. */
  async function ask(tool: ServerTool, input: Record<string, string>, turn: ToolTurn, request: ApprovalRequest['approval']): Promise<ToolResult> {
    const store = state();
    if (!turn.userId) return { ok: false, result: NO_ONE };
    if (!store) return { ok: false, result: "I can't ask for approval here, so I didn't do it." };
    const full = String(request.title || `Approve ${tool.name.replace(/_/g, ' ')}?`).replace(/\s+/g, ' ');
    const title = full.length > MAX_TITLE ? `${full.slice(0, MAX_TITLE - 1)}…` : full;
    const text = request.text ? String(request.text) : undefined;
    if (text && text.length > MAX_APPROVAL_TEXT) {
      return {
        ok: false,
        result: `This needs the person's approval, and it's too long to show them in full (${text.length} characters; the most is ${MAX_APPROVAL_TEXT}), so I didn't do it. Make it shorter.`,
      };
    }
    // What runs once approved is what the tool resolved the call to, where it says: an ID it looked up, in place of a name.
    const approved = request.input ? inputsOf(tool, request.input) : input;
    const waiting: ToolResult = {
      ok: true,
      result: `I asked the person to approve this first: "${title}". It hasn't happened yet, and will as soon as they approve. Tell them to answer that request, and don't say it's done.`,
    };
    const id = randomBytes(12).toString('base64url');
    const asked = `${KEY}:asked:${createHash('sha256')
      .update(JSON.stringify([turn.thread.id, turn.userId, tool.name, approved]))
      .digest('base64url')}`;
    const buttons = options.capabilities(turn.thread).buttons;
    const typedKey = `${KEY}:typed:${turn.thread.id}:${turn.userId}`;
    if (!(await store.setIfNotExists(asked, id, approvalTtl))) return waiting;
    const pending: Pending = {
      tool: tool.name,
      input: approved,
      thread: turn.thread.id,
      channel: turn.thread.channelId,
      user: turn.userId,
      title,
      ...(text ? { text } : {}),
      expires: Date.now() + approvalTtl,
      asked,
    };
    try {
      // Kept before it's shown, so an answer can't arrive first.
      await store.set(`${KEY}:approval:${id}`, pending, approvalTtl);
      // Where there are no buttons, the person's next `approve` or `cancel` answers their latest request.
      if (!buttons) await store.set(typedKey, id, approvalTtl);
      const sent = await turn.thread.post(card(pending, { id, buttons }));
      if (sent?.id) await store.set(`${KEY}:approval:${id}`, { ...pending, messageId: sent.id }, approvalTtl);
    } catch (error) {
      options.report(error, { thread: turn.thread, userId: turn.userId });
      // Nothing is left waiting, so asking again can work.
      await Promise.allSettled([store.delete(`${KEY}:approval:${id}`), store.delete(asked), ...(buttons ? [] : [store.delete(typedKey)])]);
      return { ok: false, result: "I couldn't post the request for approval here, so I didn't do it." };
    }
    return waiting;
  }

  /** Shows how a request ended, in place of its buttons where the channel can edit a message. */
  async function show(thread: AnyThread, messageId: string | undefined, pending: Pick<Pending, 'title' | 'text'>, outcome: string): Promise<void> {
    if (messageId && options.capabilities(thread).editMessages) {
      try {
        await thread.adapter.editMessage(thread.id, messageId, card(pending, { outcome }));
        return;
      } catch (error) {
        options.report(error, { thread });
      }
    }
    await thread.post(outcome).catch((error: unknown) => options.report(error, { thread }));
  }

  /**
   * A click on a request that is no longer waiting. Its buttons come off, so it
   * can't be clicked again; where they can't, only the person who clicked is
   * told. Nothing is posted for everyone: a stale button isn't a way to make the bot talk.
   */
  async function gone(thread: AnyThread, user: ActionEvent['user'] | string | undefined, messageId?: string): Promise<void> {
    if (messageId && options.capabilities(thread).editMessages) {
      try {
        await thread.adapter.editMessage(thread.id, messageId, Card({ children: [CardText(EXPIRED)] }) as unknown as AdapterPostableMessage);
        return;
      } catch {
        // Told to the person instead.
      }
    }
    if (user) await thread.postEphemeral(user, EXPIRED, { fallbackToDM: false }).catch(() => null);
  }

  /** One decision on a request: by the person who asked, from where it was asked, once. */
  async function decide(thread: AnyThread, id: string, user: ActionEvent['user'] | string | undefined, approve: boolean, messageId?: string): Promise<void> {
    const store = state();
    const bot = options.bot();
    const userId = typeof user === 'string' ? user : user?.userId;
    const pending = store && id ? await store.get<Pending>(`${KEY}:approval:${id}`) : null;
    // The click's thread isn't always the call's (in a direct message with no thread, the request starts one), so a click is placed by its channel and the request's own message.
    const here = pending && (pending.thread === thread.id || (pending.channel === thread.channelId && (!pending.messageId || pending.messageId === messageId)));
    if (!store || !bot || !pending || !here || pending.expires < Date.now()) {
      await gone(thread, user, messageId);
      return;
    }
    if (!userId || userId !== pending.user) {
      // Said to them alone where the channel can, and not at all where it can't: a notice for every stray click would fill the thread.
      if (user) await thread.postEphemeral(user, NOT_YOURS, { fallbackToDM: false }).catch(() => null);
      return;
    }
    // Two clicks at once: the first takes it.
    if (!(await store.setIfNotExists(`${KEY}:claimed:${id}`, 1, approvalTtl))) return;
    await Promise.allSettled([
      store.delete(`${KEY}:approval:${id}`),
      store.delete(pending.asked),
      store.delete(`${KEY}:typed:${pending.thread}:${pending.user}`),
    ]);
    if (!approve) {
      await show(thread, messageId, pending, 'Cancelled.');
      return;
    }
    // The tool acts for the conversation the call came from, with what was approved.
    let outcome: ToolOutcome = { ok: false, result: "That tool isn't available any more." };
    try {
      const origin = pending.thread === thread.id ? thread : (bot.thread(pending.thread) as AnyThread);
      const tool = toolsOf(origin).find((t) => t.name === pending.tool);
      if (tool) outcome = await run(tool, pending.input, { thread: origin, userId, approved: true });
    } catch (error) {
      options.report(error, { thread, userId });
      outcome = { ok: false, result: FAILED };
    }
    if (isApproval(outcome)) outcome = { ok: false, result: FAILED };
    await show(thread, messageId, pending, outcome.ok ? `✓ ${outcome.result}` : outcome.result);
  }

  /** A call whose pass is good: the tool it names, run for the conversation the pass names. */
  async function answer(bot: Chat<any, any>, claims: { thread: string; user: string; turn: string }, raw: string): Promise<Response> {
    let body: { tool?: unknown; input?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, result: "The tool call wasn't JSON." });
    }
    if (!body || typeof body !== 'object') return json(400, { ok: false, result: "The tool call wasn't JSON." });

    await bot.initialize();
    let thread: AnyThread;
    try {
      thread = bot.thread(claims.thread) as AnyThread;
    } catch {
      return json(401, { ok: false, result: NOT_LIVE });
    }
    // Where the bot's state is shared, a pass ends with its turn; elsewhere, when it expires.
    if (await bot.getState().get(`${KEY}:ended:${claims.turn}`)) return json(401, { ok: false, result: NOT_LIVE });

    const tool = toolsOf(thread).find((t) => t.name === body.tool);
    if (!tool) return json(404, { ok: false, result: `This server has no tool named ${String(body.tool).slice(0, 64)} on this channel.` });
    const input = inputsOf(tool, body.input);
    const mode = policy(tool);
    const turn: ToolTurn = { thread, userId: claims.user || undefined, approved: mode === 'never' };

    let outcome: ToolOutcome;
    if (mode === 'always') {
      // Every input in full, each value quoted under its name, so nothing a value says can pass for another input.
      const text = Object.entries(input)
        .filter(([, value]) => value)
        .map(([name, value]) => `**${name}**\n${quoted(value)}`)
        .join('\n\n');
      outcome = await ask(tool, input, turn, { title: `Approve ${tool.name.replace(/_/g, ' ')}?`, text });
    } else {
      outcome = await run(tool, input, turn, (tool.timeoutMs ?? 0) > 4000 ? tool.timeoutMs! - 2000 : DEFAULT_RUN_TIMEOUT);
      if (isApproval(outcome)) {
        // A tool told it's approved has nothing left to ask.
        outcome = turn.approved ? { ok: false, result: FAILED } : await ask(tool, input, turn, outcome.approval);
      }
    }
    const { ok, result, ...outputs } = outcome as ToolResult;
    return json(200, { ok: ok === true, result: String(result ?? ''), outputs });
  }

  return {
    offers: (thread) => toolsOf(thread).length > 0,

    async mint(ctx) {
      const turn = newTurnId();
      // An adapter's placeholder for a message with no author names no one, so no tool acts for it.
      const user = ctx.userId && ctx.userId !== 'unknown' ? ctx.userId : '';
      const pass = mintPass(await key(), { thread: ctx.thread.id, user, turn, expires: Date.now() + options.passTtlMs });
      return { pass, turn };
    },

    async end(turn) {
      await state()?.set(`${KEY}:ended:${turn}`, 1, options.passTtlMs);
    },

    async handle(request) {
      if (request.method !== 'POST') return json(405, { ok: false, result: 'A tool call is a POST request.' });
      const bot = options.bot();
      if (!bot) return json(503, { ok: false, result: "This server isn't ready for tool calls." });
      // The pass comes first: without one this server made, nothing else is read or done.
      const pass = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      const claims = pass ? readPass(await key(), pass) : null;
      if (!claims) return json(401, { ok: false, result: NOT_LIVE });
      try {
        if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json(413, { ok: false, result: 'That is too much to send to a tool.' });
        const raw = await request.text();
        if (raw.length > MAX_BODY) return json(413, { ok: false, result: 'That is too much to send to a tool.' });
        return await answer(bot, claims, raw);
      } catch (error) {
        // Whatever went wrong (the state adapter, say) is reported here, and the caller hears only that it failed.
        options.report(error);
        return json(500, { ok: false, result: FAILED });
      }
    },

    async choose(event) {
      if (event.actionId !== APPROVE_ACTION && event.actionId !== CANCEL_ACTION) return false;
      if (event.thread) await decide(event.thread as AnyThread, event.value ?? '', event.user, event.actionId === APPROVE_ACTION, event.messageId);
      return true;
    },

    async typed(thread, userId, text) {
      const word = text.trim().toLowerCase();
      if ((word !== 'approve' && word !== 'cancel') || !userId) return false;
      const store = state();
      const id = await store?.get<string>(`${KEY}:typed:${thread.id}:${userId}`);
      const pending = id ? await store?.get<Pending>(`${KEY}:approval:${id}`) : null;
      // A word with nothing of theirs waiting on it is a message for the agent.
      if (!id || !pending || pending.user !== userId) return false;
      await decide(thread, id, userId, word === 'approve');
      return true;
    },
  };
}
