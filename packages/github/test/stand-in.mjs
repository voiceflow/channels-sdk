// A stand-in for GitHub's REST API, as a server on this machine: the real
// GitHub adapter talks to it as it talks to GitHub. It answers the calls a bot
// makes, records the comments the bot writes, and builds what GitHub sends a
// webhook: a person's comment on an issue, which mentions the bot.
//
// The bot is a GitHub account of its own, signed in with a personal access
// token. The adapter is pointed here by its own settings: `apiUrl` (where it
// calls), `token` (the account's token), `webhookSecret` (the key GitHub signs
// each delivery with) and `userName` (the account's login: the adapter never
// asks GitHub for it, and a mention of any other name isn't one of this bot).
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';

// Made up, and put together from parts, so that nothing written here reads as a real key.
const TOKEN = `ghp_${'MadeUp'.repeat(6)}`;
const SECRET = ['made', 'up', 'webhook', 'secret'].join('-');
const account = (id, login, type = 'User') => ({
  login,
  id,
  avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  html_url: `https://github.com/${login}`,
  type,
  site_admin: false,
});
const BOT = account(900000002, 'acme-support-bot');
const ADA = account(900000001, 'ada');
const REPO = {
  id: 900000004,
  name: 'support',
  full_name: 'acme/support',
  private: true,
  owner: account(900000003, 'acme', 'Organization'),
  html_url: 'https://github.com/acme/support',
};
const ISSUE = { id: 900000005, number: 7, title: 'Where is my order?' };
const URL_ = 'https://bot.example.com/api/github';
const DOCS = 'https://docs.github.com/rest';
/** GitHub takes 65,536 characters in a comment: it refuses a longer one. */
const LIMIT = 65536;

/** A comment as a person reads it: GitHub shows a marked character without the backslash that marks it. */
const read = (body) => String(body ?? '').replace(/\\([!-/:-@[-`{-~])/g, '$1');

export async function start() {
  const posted = [];
  /** Every comment on the issue, the person's and the bot's, by its ID. */
  const comments = new Map();
  let n = 4200000000;
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const comment = (user, body) => {
    const id = ++n;
    const at = now();
    return {
      id,
      html_url: `${REPO.html_url}/issues/${ISSUE.number}#issuecomment-${id}`,
      user,
      created_at: at,
      updated_at: at,
      author_association: user === BOT ? 'MEMBER' : 'NONE',
      body,
    };
  };
  const keep = (made) => {
    comments.set(made.id, made);
    return made;
  };
  const issue = () => ({
    ...ISSUE,
    html_url: `${REPO.html_url}/issues/${ISSUE.number}`,
    user: ADA,
    state: 'open',
    locked: false,
    labels: [],
    assignees: [],
    comments: comments.size,
    body: 'It was due last week.',
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'x-github-media-type': 'github.v3; format=json',
          'x-github-request-id': randomUUID(),
        });
        res.end(JSON.stringify(value));
      };
      const refuse = (status, message, more = {}) => json(status, { message, ...more, documentation_url: DOCS, status: String(status) });
      const invalid = (message) => refuse(422, 'Validation Failed', { errors: [{ resource: 'IssueComment', code: 'unprocessable', field: 'data', message }] });

      // A call says whose it is with the account's token. GitHub knows no other here.
      const token = /^(?:token|bearer) (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return refuse(401, 'Requires authentication');
      if (token !== TOKEN) return refuse(401, 'Bad credentials');

      const path = (req.url ?? '').split('?')[0];
      // The adapter asks who it is when it starts, to know its own comments from a person's.
      if (req.method === 'GET' && path === '/user') return json(200, { ...BOT, name: 'Acme Support' });
      // The one issue of the one repository this account can see. Anything else isn't there, as far as GitHub tells it.
      const at = new RegExp(`^/repos/${REPO.full_name}/issues/(?:(${ISSUE.number})(/comments)?|comments/(\\d+))$`).exec(path);
      if (!at) return refuse(404, 'Not Found');
      if (req.method === 'GET' && at[1] && !at[2]) return json(200, issue());
      if (req.method === 'GET' && at[2]) return json(200, [...comments.values()]);

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return refuse(400, 'Problems parsing JSON');
      }
      const said = typeof body?.body === 'string' ? body.body : '';
      const wrong = !said.trim() ? 'Body cannot be blank' : [...said].length > LIMIT ? `Body is too long (maximum is ${LIMIT} characters)` : null;
      if (req.method === 'POST' && at[2]) {
        if (wrong) return invalid(wrong);
        posted.push({ method: req.method, path, body });
        return json(201, keep(comment(BOT, said)));
      }
      // An edit changes a comment that is there. It isn't something the bot sent: `sent` leaves it out.
      const old = comments.get(Number(at[3]));
      if (req.method === 'PATCH' && old) {
        if (wrong) return invalid(wrong);
        return json(200, Object.assign(old, { body: said, updated_at: now() }));
      }
      return refuse(404, 'Not Found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // The bot answers a comment that mentions it, so Ada writes its name as GitHub has it written: `@login`.
  const written = (text) => comment(ADA, `@${BOT.login} ${text}`);
  /** What GitHub sends a webhook when Ada comments on the issue, signed with `key`: the body's HMAC, in a header. */
  const delivery = (said, key) => {
    const body = JSON.stringify({
      action: 'created',
      issue: issue(),
      comment: said,
      repository: REPO,
      organization: { login: REPO.owner.login, id: REPO.owner.id },
      sender: ADA,
    });
    const signed = (algorithm) => `${algorithm}=${createHmac(algorithm, key).update(body).digest('hex')}`;
    return new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'GitHub-Hookshot/made-up',
        'x-github-event': 'issue_comment',
        'x-github-delivery': randomUUID(),
        'x-github-hook-id': '900000006',
        'x-github-hook-installation-target-id': String(REPO.id),
        'x-github-hook-installation-target-type': 'repository',
        'x-hub-signature': signed('sha1'),
        'x-hub-signature-256': signed('sha256'),
      },
      body,
    });
  };

  return {
    adapter: { token: TOKEN, webhookSecret: SECRET, apiUrl: `http://127.0.0.1:${server.address().port}`, userName: BOT.login },
    // GitHub's webhook names a person by their login alone.
    person: { id: String(ADA.id), name: ADA.login },
    maxTextLength: LIMIT,
    message: (text) => delivery(keep(written(text)), SECRET),
    // The same person's next comment on the same issue, which names nobody.
    unaddressed: (text) => delivery(keep(comment(ADA, text)), SECRET),
    // Somebody who doesn't have the secret signs with one of their own. The comment was never on GitHub.
    forged: (text) => delivery(written(text), 'somebody-elses-secret'),
    // GitHub has no buttons: a comment is its words.
    sent: () => posted.splice(0).map((call) => ({ text: read(call.body.body), buttons: [], raw: call })),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
