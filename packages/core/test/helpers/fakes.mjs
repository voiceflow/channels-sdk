// Stand-ins for the Chat SDK, picked by shape: a bot, its state and a thread,
// with only what the agent uses. The real Chat SDK and a real adapter are in
// each channel package's contract tests.

/** A state adapter's key-value part, with expiry. */
export function fakeState() {
  const entries = new Map();
  const live = (key) => {
    const entry = entries.get(key);
    if (entry?.until && entry.until <= Date.now()) entries.delete(key);
    return entries.get(key);
  };
  const put = (key, value, ttlMs) => entries.set(key, { value, until: ttlMs ? Date.now() + ttlMs : 0 });
  return {
    entries,
    get: async (key) => live(key)?.value ?? null,
    set: async (key, value, ttlMs) => void put(key, value, ttlMs),
    setIfNotExists: async (key, value, ttlMs) => (live(key) ? false : (put(key, value, ttlMs), true)),
    delete: async (key) => void entries.delete(key),
  };
}

/**
 * A thread on the adapter named `adapter` (`slack` gets Slack's capabilities
 * from the catalog: buttons, edits; a name the catalog lacks gets text only).
 * Records what is posted, said to one person, and edited.
 */
export function fakeThread(id, adapter = 'slack') {
  let state = null;
  const thread = {
    id,
    channelId: id.split(':').slice(0, 2).join(':'),
    posts: [],
    ephemerals: [],
    edits: [],
    adapter: {
      name: adapter,
      editMessage: async (_threadId, messageId, message) => {
        thread.edits.push({ messageId, message });
        return {};
      },
    },
    get state() {
      return Promise.resolve(state);
    },
    setState: async (next) => {
      state = { ...(state ?? {}), ...next };
    },
    post: async (message) => {
      thread.posts.push(message);
      return { id: `m${thread.posts.length}` };
    },
    postEphemeral: async (user, message) => {
      thread.ephemerals.push({ user, message });
      return null;
    },
    startTyping: async () => {},
    subscribe: async () => {},
  };
  return thread;
}

/** A bot with these threads, as much of `Chat` as the agent's tool server uses. */
export function fakeBot(threads, state = fakeState()) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    state,
    initialize: async () => {},
    getState: () => state,
    thread: (id) => {
      const thread = byId.get(id);
      if (!thread) throw new Error(`Adapter not found for thread ID "${id}"`);
      return thread;
    },
    onNewMention() {},
    onSubscribedMessage() {},
    onAction() {},
  };
}

/** A server tool's call, as the agent's function sends it. */
export function toolCall(pass, tool, input = {}, { url = 'https://app.example/api/tools' } = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-voiceflow-tool-call': '1', ...(pass === undefined ? {} : { authorization: `Bearer ${pass}` }) },
    body: JSON.stringify({ tool, input }),
  });
}

/** Every text and button in a posted card or message, flattened, for assertions. */
export function partsOf(post) {
  const texts = [];
  const buttons = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') return void texts.push(node);
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node !== 'object') return;
    if (node.type === 'button') buttons.push({ id: node.id, label: node.label, value: node.value });
    for (const key of ['title', 'markdown', 'content', 'text']) if (typeof node[key] === 'string') texts.push(node[key]);
    walk(node.children);
  };
  walk(post);
  return { text: texts.join('\n'), buttons };
}
