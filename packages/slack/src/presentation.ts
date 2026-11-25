// Shows the presentation tools' traces in Slack, natively: a reaction on the
// person's message, a table, a chart, a reply only they can see, and a form (a
// button that opens a Slack dialog, whose answers become the person's next
// message to the agent).

import type { ExtensionHost, TraceHandler, TraceTurn } from '@voiceflow/channels-sdk';
import {
  Actions,
  Button,
  Card,
  CardText,
  Chart,
  type Chat,
  chartElementToFallbackText,
  DateInput,
  Modal,
  type ModalChild,
  NumberInput,
  RadioSelect,
  Select,
  SelectOption,
  Table,
  TextInput,
  type Thread,
  tableElementToAscii,
} from 'chat';
import { SLUG, slackAdapter, where } from './adapter.js';

type AnyThread = Thread<any, any>;

/** The action ID of a form's "Open form" button, and the callback ID of its dialog. */
export const FORM_ACTION_ID = 'vf-form';
const FORM_KEY = 'forms';

export interface FormField {
  name: string;
  label: string;
  type: 'text' | 'long_text' | 'number' | 'date' | 'select' | 'radio';
  optional?: boolean;
  placeholder?: string;
  options?: string[];
}

interface OpenForm {
  title: string;
  fields: FormField[];
  /** The person the form was for. Others who click it are told so. */
  userId?: string;
  messageId?: string;
}

export interface PresentationOptions {
  /** A reaction the working reaction must leave alone, because a tool added it. */
  keep(messageId: string, emoji: string): void;
}

/** A short ID for a form, unique enough within a thread. */
function formId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function forms(host: ExtensionHost, thread: AnyThread): Promise<Record<string, OpenForm>> {
  const state = (await host.getState<Record<string, unknown>>(thread)) ?? {};
  return (state[FORM_KEY] as Record<string, OpenForm>) ?? {};
}

async function saveForms(host: ExtensionHost, thread: AnyThread, value: Record<string, OpenForm>): Promise<void> {
  const state = (await host.getState<Record<string, unknown>>(thread)) ?? {};
  await host.setState(thread, { ...state, [FORM_KEY]: value });
}

export function presentation(host: () => ExtensionHost | undefined, options: PresentationOptions): Record<string, TraceHandler> {
  return {
    async slack_react(trace, turn) {
      const emoji = String(trace.payload?.emoji ?? '');
      // A turn from a button has no message of the person's to react to.
      if (!emoji || !turn.message) return;
      options.keep(turn.message.id, emoji);
      await slackAdapter(turn.thread).addReaction(turn.thread.id, turn.message.id, emoji);
    },

    async slack_show_table(trace, turn) {
      const { title, headers, rows } = trace.payload ?? {};
      if (!Array.isArray(headers) || !Array.isArray(rows)) return;
      const table = Table({ headers, rows, ...(title ? { caption: title } : {}), pageSize: Math.min(rows.length || 1, 10) });
      const ascii = `\`\`\`\n${tableElementToAscii(headers, rows)}\n\`\`\``;
      const text = title ? `*${title}*\n${ascii}` : ascii;
      await turn.post({ card: Card({ ...(title ? { title } : {}), children: [table] }), fallbackText: title || 'Table' }, text);
    },

    async slack_show_chart(trace, turn) {
      const { title, chart } = trace.payload ?? {};
      if (!chart?.type) return;
      const element = Chart({ title: title || 'Chart', chart });
      const text = chartElementToFallbackText(element);
      await turn.post({ card: Card({ children: [element] }), fallbackText: title || 'Chart' }, text);
    },

    async slack_reply_privately(trace, turn) {
      const text = String(trace.payload?.text ?? '');
      if (!text) return;
      // In a direct message every reply is private already.
      if (isDirect(turn)) {
        await turn.post(text);
        return;
      }
      if (!turn.userId) throw new Error('slack_reply_privately: the turn has no person to send to, so nothing was sent');
      await turn.flush();
      await turn.thread.postEphemeral(turn.userId, text, { fallbackToDM: true });
    },

    async slack_ask_form(trace, turn) {
      const lent = host();
      const { title, intro, fields } = trace.payload ?? {};
      if (!lent || !Array.isArray(fields) || !fields.length) return;
      const id = formId();
      const form: OpenForm = { title: title || 'Form', fields, ...(turn.userId ? { userId: turn.userId } : {}) };
      const all = await forms(lent, turn.thread);
      all[id] = form;
      await saveForms(lent, turn.thread, all);
      const card = Card({
        title: form.title,
        children: [...(intro ? [CardText(intro)] : []), Actions([Button({ id: FORM_ACTION_ID, label: 'Open form', style: 'primary', value: id })])],
      });
      const fallback = `*${form.title}*${intro ? `\n${intro}` : ''}\nReply with: ${fields.map((f: FormField) => f.label).join('; ')}`;
      const sent = await turn.post({ card, fallbackText: form.title }, fallback);
      if (sent) {
        const saved = await forms(lent, turn.thread);
        if (saved[id]) {
          saved[id]!.messageId = sent.id;
          await saveForms(lent, turn.thread, saved);
        }
      }
    },
  };
}

function isDirect(turn: TraceTurn): boolean {
  return where(turn.thread).channel.startsWith('D');
}

function input(field: FormField): ModalChild {
  const base = { id: field.name, label: field.label, ...(field.optional ? { optional: true } : {}) };
  const placeholder = field.placeholder ? { placeholder: field.placeholder } : {};
  switch (field.type) {
    case 'long_text':
      return TextInput({ ...base, ...placeholder, multiline: true });
    case 'number':
      return NumberInput({ ...base, ...placeholder, decimal: true });
    case 'date':
      return DateInput({ ...base, ...placeholder });
    case 'select':
      return Select({ ...base, ...placeholder, options: (field.options ?? []).map((o) => SelectOption({ label: o, value: o })) });
    case 'radio':
      return RadioSelect({ ...base, options: (field.options ?? []).map((o) => SelectOption({ label: o, value: o })) });
    default:
      return TextInput({ ...base, ...placeholder });
  }
}

/** The answers as the person's next message: the form's title, then one line per field. */
export function answersText(form: { title: string; fields: FormField[] }, values: Record<string, string | undefined>): string {
  const lines = form.fields.map((f) => `${f.label}: ${values[f.name]?.toString().trim() || '(left empty)'}`);
  return `Filled in the form "${form.title}":\n${lines.join('\n')}`;
}

/** The form's button opens its dialog; submitting it sends the answers to the agent as the person's next message. */
export function attachFormEvents(bot: Chat<any, any>, host: ExtensionHost): void {
  bot.onAction(FORM_ACTION_ID, async (event) => {
    if (event.adapter.name !== SLUG || !event.thread) return;
    const thread = event.thread as AnyThread;
    const form = (await forms(host, thread))[event.value ?? ''];
    if (!form) {
      await thread.postEphemeral(event.user, 'This form has already been sent.', { fallbackToDM: false }).catch(() => null);
      return;
    }
    if (form.userId && form.userId !== event.user.userId) {
      await thread.postEphemeral(event.user, `This form is for <@${form.userId}>.`, { fallbackToDM: false }).catch(() => null);
      return;
    }
    await event.openModal(
      Modal({
        callbackId: FORM_ACTION_ID,
        title: form.title,
        submitLabel: 'Send',
        privateMetadata: event.value!,
        children: form.fields.map(input),
      }),
    );
  });

  bot.onModalSubmit(FORM_ACTION_ID, async (event) => {
    if (event.adapter.name !== SLUG || !event.relatedThread || !event.privateMetadata) return;
    const thread = event.relatedThread as AnyThread;
    const id = event.privateMetadata;
    // Slack wants the dialog answered within 3 seconds, so the agent's turn runs after it closes.
    host.defer(
      (async () => {
        const all = await forms(host, thread);
        const form = all[id];
        if (!form) return;
        delete all[id];
        await saveForms(host, thread, all);
        await event.relatedMessage
          ?.edit(Card({ title: form.title, children: [CardText(`✓ Sent by <@${event.user.userId}>`)] }))
          .catch((error) => host.report(error, { thread }));
        await host.run(thread, { type: 'text', payload: answersText(form, event.values) }, { userId: event.user.userId });
      })().catch((error) => host.report(error, { thread })),
    );
  });
}
