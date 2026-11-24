// A stand-in for Linear, as a server on this machine: the real Linear adapter
// talks to it as it talks to Linear. It answers the GraphQL calls a bot makes,
// keeps the comments, and builds what Linear sends a bot: the webhook for a
// comment a person wrote on an issue, signed with the webhook's secret.
//
// The adapter is pointed here by its own settings: `apiUrl` (the address of
// Linear's GraphQL API), `apiKey` (a personal API key, so the bot is a member
// of the workspace and comments as one), `webhookSecret` (what Linear signs
// with) and `userName` (the name the bot is mentioned by: the adapter answers
// a comment that says `@userName`, and `@linear-bot` unless it is told another).
import { createHmac } from 'node:crypto';
import http from 'node:http';

// Made up, and put together from parts so that no one piece reads as a key.
const API_KEY = ['lin', 'api', 'made-up-personal-key'].join('_');
const SECRET = ['lin', 'wh', 'made-up-signing-secret'].join('_');
const SOMEBODY_ELSES = ['lin', 'wh', 'not-this-webhooks-secret'].join('_');
/** Linear's IDs are UUIDs: these count up, so each can be told from the next. */
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const WORKSPACE = { id: uuid(1), urlKey: 'acme' };
const BOT = { id: uuid(2), displayName: 'acme-support' };
const ADA = { id: uuid(3), name: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: null, url: `https://linear.app/${WORKSPACE.urlKey}/profiles/ada` };
const TEAM = { id: uuid(4), key: 'SUP', name: 'Support' };
const ISSUE = {
  id: uuid(5),
  identifier: 'SUP-12',
  title: 'Where is my order?',
  teamId: TEAM.id,
  team: TEAM,
  url: `https://linear.app/${WORKSPACE.urlKey}/issue/SUP-12/where-is-my-order`,
};
const WEBHOOK_ID = uuid(6);
const URL_ = 'https://bot.example.com/api/linear';

/** A comment's text as a person reads it: Linear shows markdown, where a backslash before a mark shows the mark alone. */
const read = (body) => String(body ?? '').replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** The first field a GraphQL call asks for: `commentCreate`, of `mutation createComment($input: …) { commentCreate(…) { … } }`. */
const fieldOf = (query) => /^\s*(?:(?:query|mutation)\s*\w*\s*(?:\([^)]*\))?\s*)?\{\s*(\w+)/.exec(String(query ?? ''))?.[1] ?? '';

/** A refusal as Linear words one. Its SDK reads the kind of error from `extensions.type`. */
const refusal = (type, message, userPresentableMessage, path) => ({
  errors: [{ message, ...(path ? { path: [path] } : {}), extensions: { type, userError: true, userPresentableMessage } }],
  data: null,
});
const notFound = (what, path) => refusal('invalid input', `Entity not found: ${what}`, `Could not find referenced ${what}.`, path);

export async function start() {
  const calls = [];
  const comments = new Map();
  let n = 100;
  /** The comment that opened the conversation: the bot answers under it, and so does the person from then on. */
  let root;

  const comment = ({ body, parentId, userId }) => {
    const id = uuid(++n);
    const now = new Date().toISOString();
    return { id, body, issueId: ISSUE.id, parentId: parentId ?? null, userId, createdAt: now, updatedAt: now, url: `${ISSUE.url}#comment-${id.slice(0, 8)}` };
  };
  const keep = (made) => {
    comments.set(made.id, made);
    return made;
  };

  /** What each call a bot makes is answered with: a comment as the SDK's `Comment` asks for one, field for field. */
  const answers = {
    // Whose key it is. The adapter asks once, as it starts, so that it can tell its own comments from a person's.
    viewer: () => ({ data: { viewer: { id: BOT.id, displayName: BOT.displayName, organization: { id: WORKSPACE.id } } } }),
    commentCreate({ input = {} }) {
      // An issue is named by its ID or by its identifier (SUP-12), and an answer goes under a comment that is there.
      if (input.issueId !== ISSUE.id && input.issueId !== ISSUE.identifier) return notFound('Issue', 'commentCreate');
      if (input.parentId && !comments.has(input.parentId)) return notFound('Comment', 'commentCreate');
      const made = keep(comment({ body: input.body, parentId: input.parentId, userId: BOT.id }));
      return { data: { commentCreate: { __typename: 'CommentPayload', comment: { id: made.id }, lastSyncId: ++n, success: true } } };
    },
    // The SDK reads a comment back by its ID once it is made: the mutation's own answer has only the ID.
    comment({ id }) {
      const found = comments.get(id);
      if (!found) return notFound('Comment', 'comment');
      return {
        data: {
          comment: {
            __typename: 'Comment',
            id: found.id,
            body: found.body,
            url: found.url,
            issueId: found.issueId,
            issue: { id: found.issueId },
            parentId: found.parentId,
            parent: found.parentId ? { id: found.parentId } : null,
            user: { id: found.userId },
            createdAt: found.createdAt,
            updatedAt: found.updatedAt,
            editedAt: null,
            archivedAt: null,
            resolvedAt: null,
            quotedText: null,
            reactionData: [],
            reactions: [],
            agentSession: null,
            botActor: null,
            documentContent: null,
            documentContentId: null,
            externalThread: null,
            externalUser: null,
            initiativeUpdate: null,
            initiativeUpdateId: null,
            projectUpdate: null,
            projectUpdateId: null,
            resolvingComment: null,
            resolvingCommentId: null,
            resolvingUser: null,
            syncedWith: null,
          },
        },
      };
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      if (req.method !== 'POST' || req.url !== '/graphql') return json(404, { error: 'Not found' });
      // A personal API key is the Authorization header's whole value: no "Bearer" before it.
      if (req.headers.authorization !== API_KEY)
        return json(401, refusal('authentication error', 'Authentication required, not authenticated', 'You need to authenticate to access this operation.'));
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}
      const field = fieldOf(body.query);
      const variables = body.variables ?? {};
      calls.push({ field, query: body.query, variables });
      // A call this stand-in has no answer for is refused, never waved through.
      if (!answers[field]) return json(400, refusal('graphql error', `The stand-in for Linear answers no "${field}".`, 'This is not part of the stand-in.'));
      return json(200, answers[field](variables));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  /** Linear's webhook for a comment that was made: its body signed, HMAC-SHA256 in hex, with the webhook's secret. */
  const webhook = (made, secret) => {
    const person = { id: ADA.id, name: ADA.name, email: ADA.email, avatarUrl: ADA.avatarUrl, url: ADA.url };
    const parent = made.parentId ? comments.get(made.parentId) : undefined;
    const body = JSON.stringify({
      action: 'create',
      actor: { ...person, type: 'user' },
      createdAt: made.createdAt,
      data: {
        id: made.id,
        createdAt: made.createdAt,
        updatedAt: made.updatedAt,
        body: made.body,
        issueId: made.issueId,
        ...(parent ? { parentId: parent.id, parent: { id: parent.id, body: parent.body, issueId: parent.issueId, userId: parent.userId } } : {}),
        userId: made.userId,
        reactionData: [],
        user: person,
        issue: ISSUE,
      },
      url: made.url,
      type: 'Comment',
      organizationId: WORKSPACE.id,
      // The time it was sent, which the SDK holds to within a minute of now: an old delivery sent again is refused.
      webhookTimestamp: Date.now(),
      webhookId: WEBHOOK_ID,
    });
    return new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'linear-delivery': uuid(++n),
        'linear-event': 'Comment',
        'linear-signature': createHmac('sha256', secret).update(body).digest('hex'),
        'user-agent': 'Linear-Webhook',
      },
      body,
    });
  };
  // The bot answers a comment that mentions it, and Linear writes a mention into a comment's markdown as @ and the display name.
  const written = (text) => comment({ body: `@${BOT.displayName} ${text}`, parentId: root?.id, userId: ADA.id });

  return {
    adapter: { apiKey: API_KEY, apiUrl: `http://127.0.0.1:${server.address().port}/graphql`, webhookSecret: SECRET, userName: BOT.displayName },
    person: { id: ADA.id, name: ADA.name },
    // The first comment opens a thread on the issue; each one after is a reply in that thread.
    message(text) {
      const made = keep(written(text));
      root ??= made;
      return webhook(made, SECRET);
    },
    // Signed, but with a secret that isn't this webhook's. The comment is not one Linear has.
    forged: (text) => webhook(written(text), SOMEBODY_ELSES),
    sent() {
      return (
        calls
          .splice(0)
          .filter((call) => call.field === 'commentCreate')
          // Linear has no buttons: a comment is markdown and nothing more.
          .map((call) => ({ text: read(call.variables.input?.body), buttons: [], raw: call }))
      );
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
