// Slack's presentation tools: Voiceflow functions that check what the model
// gave them and return a custom trace, which this package then shows in Slack
// natively (a reaction, a table, a chart, a private reply, a form). They need
// no Slack token: nothing leaves Voiceflow but the trace.
//
// Each function is written here as real code and sent to Voiceflow as its text
// (functionSource), so it must be self-contained: no imports, no constants from
// this module, nothing the Voiceflow sandbox lacks (Node and browser globals,
// `URLSearchParams`, `setTimeout`). The tests run each one in an emulated sandbox.
import { functionSource, type ToolDefinition } from '@voiceflow/channelkit';

/** The custom trace each presentation tool returns, by tool. The trace type is the tool's name. */
export const PRESENTATION_TRACES = ['slack_react', 'slack_show_table', 'slack_show_chart', 'slack_reply_privately', 'slack_ask_form'] as const;
export type PresentationTrace = (typeof PRESENTATION_TRACES)[number];

// ── slack_react ─────────────────────────────────────────────────────────────

export async function slackReact(args: any) {
  const emoji = String((args.inputVars || {}).emoji || '')
    .trim()
    .replace(/^:+|:+$/g, '')
    .toLowerCase();
  if (!/^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/.test(emoji) || emoji.length > 100) {
    return {
      outputVars: { result: 'No reaction added: give a Slack emoji name such as thumbsup, tada or white_check_mark.' },
      next: { path: 'error' },
    };
  }
  return {
    outputVars: { result: `Reacted with :${emoji}: to the person's message.` },
    trace: [{ type: 'slack_react', payload: { emoji } }],
    next: { path: 'success' },
  };
}

// ── slack_show_table ────────────────────────────────────────────────────────

/** Text to cells, for CSV or tab-separated text with a header line. Quoted cells may hold the separator and quotes (""). */
export function parseDelimited(text: string) {
  const firstLine = text.split('\n')[0] || '';
  const separator = firstLine.indexOf('\t') !== -1 && firstLine.indexOf(',') === -1 ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === separator) {
      row.push(cell.trim());
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** One cell as text. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The model's table, in any of the shapes it may give, as headers and rows of text. */
export function tableOf(data: unknown): { headers: string[]; rows: string[][] } | { error: string } {
  let value: any = data;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return { error: 'The table is empty.' };
    if (text[0] === '[' || text[0] === '{') {
      try {
        value = JSON.parse(text);
      } catch (error: any) {
        return { error: `The table isn't valid JSON (${error && error.message}).` };
      }
    } else {
      const lines = parseDelimited(text);
      if (lines.length < 1) return { error: 'The table is empty.' };
      return { headers: lines[0]!, rows: lines.slice(1) };
    }
  }
  if (value && !Array.isArray(value) && typeof value === 'object' && Array.isArray(value.rows)) {
    const rows = value.rows;
    const headers = Array.isArray(value.headers) ? value.headers.map(cellText) : Array.isArray(value.columns) ? value.columns.map(cellText) : null;
    if (rows.length && !Array.isArray(rows[0])) return tableOf(rows);
    if (!headers) return { error: 'The table has rows but no headers.' };
    return { headers, rows: rows.map((r: unknown[]) => headers.map((_: string, i: number) => cellText(r[i]))) };
  }
  if (value && !Array.isArray(value) && typeof value === 'object') value = [value];
  if (!Array.isArray(value) || !value.length) return { error: 'The table has no rows.' };
  if (Array.isArray(value[0])) {
    const headers = value[0].map(cellText);
    return { headers, rows: value.slice(1).map((r: unknown[]) => headers.map((_: string, i: number) => cellText(Array.isArray(r) ? r[i] : ''))) };
  }
  const headers: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return { error: 'Each row must be an object (or the first row the headers).' };
    for (const key of Object.keys(item)) if (headers.indexOf(key) === -1) headers.push(key);
  }
  return { headers, rows: value.map((item: Record<string, unknown>) => headers.map((h) => cellText(item[h]))) };
}

export async function slackShowTable(args: any) {
  const input = args.inputVars || {};
  const parsed = tableOf(input.data);
  if ('error' in parsed) return { outputVars: { result: `No table shown. ${parsed.error}` }, next: { path: 'error' } };
  const maxRows = 100;
  const maxColumns = 20;
  const headers = parsed.headers.slice(0, maxColumns).map((h) => h.slice(0, 200));
  const rows = parsed.rows.slice(0, maxRows).map((r) => r.slice(0, maxColumns).map((c) => c.slice(0, 500)));
  const notes: string[] = [];
  if (parsed.rows.length > maxRows) notes.push(`only the first ${maxRows} of ${parsed.rows.length} rows fit`);
  if (parsed.headers.length > maxColumns) notes.push(`only the first ${maxColumns} of ${parsed.headers.length} columns fit`);
  const title = String(input.title || '').trim().slice(0, 200);
  return {
    outputVars: {
      result: `Shown as a table: ${rows.length} rows, ${headers.length} columns.${notes.length ? ` Tell the person ${notes.join(' and ')}.` : ''}`,
    },
    trace: [{ type: 'slack_show_table', payload: { title, headers, rows } }],
    next: { path: 'success' },
  };
}

// ── slack_show_chart ────────────────────────────────────────────────────────

/** A label as Slack's charts take it: at most `max` characters. */
export function shortLabel(value: unknown, max: number): string {
  const text = cellText(value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The model's chart data as Chat SDK's chart definition, within Slack's limits. */
export function chartOf(type: string, data: unknown): { chart: any; notes: string[] } | { error: string } {
  let value: any = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error: any) {
      return { error: `The chart data isn't valid JSON (${error && error.message}).` };
    }
  }
  const notes: string[] = [];
  const number = (v: unknown) => (typeof v === 'number' ? v : Number(String(v).replace(/[,$%\s]/g, '')));
  if (type === 'pie') {
    let pairs: [unknown, unknown][] = [];
    if (Array.isArray(value)) pairs = value.map((s: any) => [s && (s.label !== undefined ? s.label : s.name), s && s.value]);
    else if (value && typeof value === 'object') pairs = Object.keys(value).map((k) => [k, value[k]]);
    const segments = pairs.map(([label, v]) => ({ label: shortLabel(label, 20), value: number(v) })).filter((s) => s.label && s.value > 0);
    if (!segments.length) return { error: 'A pie chart needs at least one label with a value above 0.' };
    if (segments.length > 12) notes.push(`only the first 12 of ${segments.length} slices fit`);
    return { chart: { type: 'pie', segments: segments.slice(0, 12) }, notes };
  }
  if (type !== 'bar' && type !== 'line' && type !== 'area') return { error: 'The chart type must be bar, line, area or pie.' };
  let categories: unknown[] = [];
  let series: { name: unknown; data: unknown[] }[] = [];
  if (value && !Array.isArray(value) && Array.isArray(value.categories) && Array.isArray(value.series)) {
    categories = value.categories;
    series = value.series.map((s: any) => ({ name: s && s.name, data: Array.isArray(s && s.data) ? s.data.map((d: any) => (d && typeof d === 'object' ? d.value : d)) : [] }));
  } else if (Array.isArray(value) && value.length && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) {
    // Rows: the first key is the category, every other key a series.
    const keys = Object.keys(value[0]);
    categories = value.map((row: any) => row[keys[0]!]);
    series = keys.slice(1).map((k) => ({ name: k, data: value.map((row: any) => row[k]) }));
  } else {
    return { error: 'Give the chart as {"categories": [...], "series": [{"name": "...", "data": [numbers]}]}, or as rows whose first field is the category.' };
  }
  if (!categories.length || !series.length) return { error: 'The chart needs at least one category and one series.' };
  if (categories.length > 20) notes.push(`only the first 20 of ${categories.length} categories fit`);
  if (series.length > 12) notes.push(`only the first 12 of ${series.length} series fit`);
  const labels = categories.slice(0, 20).map((c) => shortLabel(c, 20));
  const out = series.slice(0, 12).map((s, i) => ({
    name: shortLabel(s.name, 20) || `Series ${i + 1}`,
    data: labels.map((label, j) => ({ label, value: number(s.data[j]) })),
  }));
  if (out.some((s) => s.data.some((d) => !isFinite(d.value)))) return { error: 'Every series needs a number for every category.' };
  return { chart: { type, categories: labels, series: out }, notes };
}

export async function slackShowChart(args: any) {
  const input = args.inputVars || {};
  const type = String(input.chart_type || 'bar').trim().toLowerCase();
  const made = chartOf(type, input.data);
  if ('error' in made) return { outputVars: { result: `No chart shown. ${made.error}` }, next: { path: 'error' } };
  const title = shortLabel(input.title || 'Chart', 50);
  if (made.chart.type !== 'pie') {
    if (input.x_label) made.chart.xLabel = shortLabel(input.x_label, 50);
    if (input.y_label) made.chart.yLabel = shortLabel(input.y_label, 50);
  }
  return {
    outputVars: { result: `Shown as a ${type} chart.${made.notes.length ? ` Tell the person ${made.notes.join(' and ')}.` : ''}` },
    trace: [{ type: 'slack_show_chart', payload: { title, chart: made.chart } }],
    next: { path: 'success' },
  };
}

// ── slack_reply_privately ───────────────────────────────────────────────────

export async function slackReplyPrivately(args: any) {
  const text = String((args.inputVars || {}).text || '').trim();
  if (!text) return { outputVars: { result: 'Nothing sent: the text is empty.' }, next: { path: 'error' } };
  return {
    outputVars: { result: 'Sent privately: only the person can see it. Do not repeat it in the conversation.' },
    trace: [{ type: 'slack_reply_privately', payload: { text: text.slice(0, 3000) } }],
    next: { path: 'success' },
  };
}

// ── slack_ask_form ──────────────────────────────────────────────────────────

/** The model's fields, checked and shaped for a Slack modal. */
export function formFields(data: unknown): { fields: any[] } | { error: string } {
  let value: any = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error: any) {
      return { error: `The fields aren't valid JSON (${error && error.message}).` };
    }
  }
  if (value && !Array.isArray(value)) value = [value];
  if (!Array.isArray(value) || !value.length) return { error: 'A form needs at least one field.' };
  if (value.length > 20) return { error: 'A form takes at most 20 fields.' };
  const types = ['text', 'long_text', 'number', 'date', 'select', 'radio'];
  const fields: any[] = [];
  for (let i = 0; i < value.length; i++) {
    const f = value[i] || {};
    const label = String(f.label || f.name || '').trim().slice(0, 2000);
    const name = String(f.name || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `field_${i + 1}`;
    const type = types.indexOf(f.type) === -1 ? 'text' : f.type;
    if (!label) return { error: `Field ${i + 1} needs a label.` };
    if (fields.some((x) => x.name === name)) return { error: `Two fields are named ${name}.` };
    const field: any = { name, label, type, optional: f.optional === true || f.required === false };
    if (f.placeholder) field.placeholder = String(f.placeholder).slice(0, 150);
    if (type === 'select' || type === 'radio') {
      const options = (Array.isArray(f.options) ? f.options : []).map((o: any) => String(o && typeof o === 'object' ? o.label || o.value : o).trim().slice(0, 75)).filter(Boolean);
      const max = type === 'radio' ? 10 : 100;
      if (!options.length) return { error: `${label} needs options.` };
      if (options.length > max) return { error: `${label} takes at most ${max} options.` };
      field.options = options;
    }
    fields.push(field);
  }
  return { fields };
}

export async function slackAskForm(args: any) {
  const input = args.inputVars || {};
  const made = formFields(input.fields);
  if ('error' in made) return { outputVars: { result: `No form shown. ${made.error}` }, next: { path: 'error' } };
  const title = String(input.title || 'Form').trim();
  return {
    outputVars: {
      result: 'The form is in front of the person. Their answers arrive as their next message: stop here and wait for them.',
    },
    trace: [
      {
        type: 'slack_ask_form',
        payload: { title: title.length > 24 ? `${title.slice(0, 23)}…` : title, intro: String(input.intro || '').trim().slice(0, 3000), fields: made.fields },
      },
    ],
    next: { path: 'success' },
  };
}

// ── Definitions ─────────────────────────────────────────────────────────────

export const presentationTools: ToolDefinition[] = [
  {
    name: 'slack_react',
    kind: 'presentation',
    version: 1,
    description:
      "Add an emoji reaction to the person's latest Slack message, as a teammate would: to acknowledge a request, celebrate, or agree, without a message. Use it sparingly, and still answer in words when they asked something.",
    get code() {
      return functionSource(slackReact);
    },
    inputs: { emoji: { description: 'A Slack emoji name without colons: thumbsup, tada, white_check_mark, eyes, pray, heart, rocket.' } },
    outputs: { result: 'What happened.' },
    requires: ['reactions:write'],
  },
  {
    name: 'slack_show_table',
    kind: 'presentation',
    version: 1,
    description:
      'Show data as a native Slack table, below your reply. Use it for rows of records (orders, tickets, prices, schedules) rather than writing a table in text. Up to 100 rows and 20 columns.',
    get code() {
      return functionSource(slackShowTable, [parseDelimited, cellText, tableOf]);
    },
    inputs: {
      title: { description: 'A short caption for the table, or empty for none.' },
      data: {
        description:
          'The table as JSON: an array of objects with the same keys (one object per row), or {"headers": [...], "rows": [[...], ...]}. CSV with a header line also works.',
      },
    },
    outputs: { result: 'What was shown.' },
  },
  {
    name: 'slack_show_chart',
    kind: 'presentation',
    version: 1,
    description:
      'Show numbers as a native Slack chart (bar, line, area or pie), below your reply. Use it when a trend or comparison is easier to see than read. Up to 20 categories and 12 series.',
    get code() {
      return functionSource(slackShowChart, [cellText, shortLabel, chartOf]);
    },
    inputs: {
      title: { description: 'The chart title, up to 50 characters.' },
      chart_type: { description: 'bar, line, area or pie.' },
      data: {
        description:
          'JSON. For bar, line and area: {"categories": ["Jan", "Feb"], "series": [{"name": "Revenue", "data": [120, 140]}]}, or an array of rows whose first field is the category ([{"month": "Jan", "revenue": 120}]). For pie: {"Label": value, ...} or [{"label": "...", "value": 3}].',
      },
      x_label: { description: 'The x-axis title, or empty. Not for pie charts.' },
      y_label: { description: 'The y-axis title, or empty. Not for pie charts.' },
    },
    outputs: { result: 'What was shown.' },
  },
  {
    name: 'slack_reply_privately',
    kind: 'presentation',
    version: 1,
    description:
      "Send the person a message only they can see (Slack's ephemeral message), in a channel others are reading. Use it for anything personal or sensitive: their account details, a private link, a correction others needn't see. In a direct message every reply is already private.",
    get code() {
      return functionSource(slackReplyPrivately);
    },
    inputs: { text: { description: 'The private message, in Slack markdown.' } },
    outputs: { result: 'What happened.' },
  },
  {
    name: 'slack_ask_form',
    kind: 'presentation',
    version: 1,
    description:
      'Ask the person for several details at once with a native Slack form: a button that opens a dialog with text, number, date and choice fields. Use it when you need three or more answers, or dates and choices that are easy to get wrong in text. Their answers arrive as their next message.',
    get code() {
      return functionSource(slackAskForm, [formFields]);
    },
    inputs: {
      title: { description: "The form's title, up to 24 characters." },
      intro: { description: 'One line above the button saying what the form is for, or empty.' },
      fields: {
        description:
          'JSON array of fields, each {"name": "start_date", "label": "Start date", "type": "date"}. type is text, long_text, number, date, select or radio; select and radio take "options": ["A", "B"]; add "optional": true for a field that may be left empty.',
      },
    },
    outputs: { result: 'What happened.' },
  },
];
