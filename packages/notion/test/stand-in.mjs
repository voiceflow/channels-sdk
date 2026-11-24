// A stand-in for Notion, as a server on this machine: the real Notion adapter
// talks to it as it talks to Notion's API. It keeps one page and the comments
// on it, answers the calls a connection makes (who it is, a comment by its ID,
// the page, the page's comments, a new comment), records what the bot sends,
// and builds what Notion sends a bot: a `comment.created` event, signed with
// the subscription's verification token.
//
// An event says only which comment it is about and which page that is on, by
// their IDs. The adapter reads the comment back from the API before it knows a
// word of it, so a person's comment is kept here first and the event names it.
//
// The bot answers when it is mentioned. A connection can't be picked from the
// @ menu of Notion's comment box (the adapter's own note), so a person writes
// its name as plain text: `@notion-bot`, the name the adapter looks for unless
// it is told another.
//
// The adapter is pointed here by its own settings: `apiBaseUrl` (where it
// calls), `token` (the connection's, sent as a Bearer token) and
// `verificationToken` (the key Notion signs every event with).
import { createHmac } from 'node:crypto';
import http from 'node:http';

// Made up, and put together from parts so that nothing here reads as a real key.
const TOKEN = ['ntn', 'made', 'up', 'connection', 'token'].join('_');
const VERIFICATION_TOKEN = ['secret', 'made', 'up', 'verification', 'token'].join('_');
const SOMEONE_ELSES_TOKEN = ['secret', 'made', 'up', 'token', 'of', 'another', 'subscription'].join('_');

/** A made-up ID in the shape of Notion's: a UUID, in lowercase with its hyphens. */
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const WORKSPACE = uuid(1);
const INTEGRATION = uuid(2);
const SUBSCRIPTION = uuid(3);
const BOT = { id: uuid(4), name: 'notion-bot' };
const ADA = { id: uuid(5), name: 'Ada Lovelace' };
const PAGE = uuid(6);
const DISCUSSION = uuid(7);
const URL_ = 'https://bot.example.com/api/notion';
/** Notion takes 2,000 characters in one piece of a comment's text, and refuses a longer one. The adapter sends none over 1,900. */
const LIMIT = 2000;

/** One piece of rich text, as Notion writes plain words. */
const span = (content) => ({
  type: 'text',
  text: { content, link: null },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
  plain_text: content,
  href: null,
});

const MARKS =
  /\\([!-/:-@[-`{-~])|\[((?:\\.|[^\]\\])+)\]\((?:\\.|[^)\\])*\)|<(https?:\/\/[^>\s]+)>|\*\*|~~|`|\*|(?<![A-Za-z0-9])_(?=\S)|(?<=\S)_(?![A-Za-z0-9])/g;
/**
 * A comment's markdown as a person reads it in Notion: the marks of bold, italic, strikethrough and code gone, a
 * link shown as its label, and a character kept where a backslash guards it.
 */
const read = (markdown) =>
  String(markdown ?? '').replace(MARKS, (_, guarded, label, address) => guarded ?? (label === undefined ? (address ?? '') : read(label)));

export async function start() {
  const calls = [];
  /** Every comment on the page, by its ID: the people's and the bot's. */
  const comments = new Map();
  let n = 500;
  const comment = (author, text, discussion) => {
    const at = new Date().toISOString();
    const made = {
      object: 'comment',
      id: uuid(++n),
      parent: { type: 'page_id', page_id: PAGE },
      discussion_id: discussion,
      created_time: at,
      last_edited_time: at,
      // Notion says who wrote a comment by their ID alone. The name it shows beside the comment is in `display_name`.
      created_by: { object: 'user', id: author.id },
      rich_text: [span(text)],
      display_name: { type: author === BOT ? 'integration' : 'user', resolved_name: author.name },
    };
    comments.set(made.id, made);
    return made;
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...value, request_id: uuid(++n) }));
      };
      const refuse = (status, code, message) => json(status, { object: 'error', status, code, message });
      // Notion answers the same for what isn't there and for what the connection wasn't given.
      const missing = (what, id) =>
        refuse(404, 'object_not_found', `Could not find ${what} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return refuse(401, 'unauthorized', 'API token is invalid.');
      if (!req.headers['notion-version'])
        return refuse(400, 'missing_version', 'Notion-Version header failed validation: Notion-Version header should be defined, instead was `undefined`.');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const [, kind, id] = /^\/v1\/([a-z_]+)(?:\/([\w-]+))?$/.exec(url.pathname) ?? [];

      if (req.method === 'GET' && kind === 'users' && id === 'me') {
        const bot = {
          owner: { type: 'workspace', workspace: true },
          workspace_name: 'Acme',
          workspace_id: WORKSPACE,
          workspace_limits: { max_file_upload_size_in_bytes: 5368709120 },
        };
        return json(200, { object: 'user', id: BOT.id, name: BOT.name, avatar_url: null, type: 'bot', bot });
      }
      if (req.method === 'GET' && kind === 'pages' && id) {
        if (id !== PAGE) return missing('page', id);
        const by = { object: 'user', id: ADA.id };
        const address = `https://www.notion.so/Orders-${PAGE.replace(/-/g, '')}`;
        const properties = { title: { id: 'title', type: 'title', title: [span('Orders')] } };
        return json(200, {
          object: 'page',
          id: PAGE,
          created_time: '2026-01-05T09:00:00.000Z',
          last_edited_time: '2026-01-05T09:00:00.000Z',
          created_by: by,
          last_edited_by: by,
          cover: null,
          icon: null,
          parent: { type: 'workspace', workspace: true },
          archived: false,
          in_trash: false,
          properties,
          url: address,
          public_url: null,
        });
      }
      if (req.method === 'GET' && kind === 'comments' && id) {
        const found = comments.get(id);
        return found ? json(200, found) : missing('comment', id);
      }
      if (req.method === 'GET' && kind === 'comments') {
        const on = url.searchParams.get('block_id');
        if (on !== PAGE) return missing('block', on);
        return json(200, { object: 'list', results: [...comments.values()], next_cursor: null, has_more: false, type: 'comment', comment: {} });
      }
      if (req.method === 'POST' && kind === 'comments' && !id) {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return refuse(400, 'invalid_json', 'Error parsing JSON body.');
        }
        const invalid = (message) => refuse(400, 'validation_error', `body failed validation: ${message}`);
        // The adapter writes a comment as markdown, which is all this takes: Notion takes rich text as well.
        if (typeof body?.markdown !== 'string') return invalid('body.markdown should be a string, instead was `undefined`.');
        if (body.markdown.length > LIMIT) return invalid(`body.markdown.length should be ≤ \`${LIMIT}\`, instead was \`${body.markdown.length}\`.`);
        // A comment is a reply in a discussion, or the first of a new one on the page: one or the other.
        if ((body.discussion_id === undefined) === (body.parent === undefined))
          return invalid('body.parent or body.discussion_id should be defined, and not both.');
        let discussion = body.discussion_id;
        if (discussion === undefined) {
          if (body.parent.page_id !== PAGE) return missing(body.parent.block_id ? 'block' : 'page', body.parent.block_id ?? body.parent.page_id);
          discussion = uuid(++n);
        } else if (![...comments.values()].some((made) => made.discussion_id === discussion)) {
          return missing('discussion', discussion);
        }
        calls.push({ method: 'POST', path: url.pathname, body });
        return json(200, comment(BOT, read(body.markdown), discussion));
      }
      return refuse(400, 'invalid_request_url', 'Invalid request URL.');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  /** Ada comments on the page, and Notion tells the bot: her first comment starts a discussion, and the rest are replies in it. */
  const written = (text, key = VERIFICATION_TOKEN) => {
    const said = comment(ADA, `@${BOT.name} ${text}`, DISCUSSION);
    const body = JSON.stringify({
      id: uuid(++n),
      timestamp: said.created_time,
      workspace_id: WORKSPACE,
      workspace_name: 'Acme',
      subscription_id: SUBSCRIPTION,
      integration_id: INTEGRATION,
      type: 'comment.created',
      authors: [{ id: ADA.id, type: 'person' }],
      attempt_number: 1,
      entity: { id: said.id, type: 'comment' },
      data: { page_id: PAGE, parent: { id: PAGE, type: 'page' } },
    });
    // The signature is over the body's own bytes, keyed with the token Notion sent once when the subscription was made.
    const signature = `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
    return new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'x-notion-signature': signature }, body });
  };

  return {
    adapter: { token: TOKEN, verificationToken: VERIFICATION_TOKEN, apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1` },
    // No name: Notion says who wrote a comment by ID in `created_by`, which is all the adapter reads of them.
    person: { id: ADA.id },
    maxTextLength: LIMIT,
    message: (text) => written(text),
    // The same event, signed with another subscription's token.
    forged: (text) => written(text, SOMEONE_ELSES_TOKEN),
    sent() {
      // Only a comment Notion took is here, and a comment has no buttons.
      return calls.splice(0).map((call) => ({ text: read(call.body.markdown), buttons: [], raw: call }));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
