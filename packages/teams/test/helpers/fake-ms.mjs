// A stand-in for Microsoft's Teams command (`@microsoft/teams.cli`), at the
// one place this package meets it: arguments in, an exit code and what it
// printed out. It keeps a Microsoft 365 sign-in, the Teams apps made, and
// every call. What it prints is what the real command printed, in a live run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const USER = 'ada@contoso.example';
export const TENANT = '22222222-2222-4222-8222-222222222222';
/**
 * In the shape of a secret Microsoft makes: some forty characters, a "~" among them. Put together here, so that no
 * line of this file reads as a real one to whatever scans a repository for secrets.
 */
export const SECRET = ['abc8Q', 'never-printed-secret-0123456789abcd'].join('~');

const flag = (args, name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
/** A PNG's width and height, from its header. */
const sizeOf = (bytes) => (bytes.length > 24 && bytes[1] === 0x50 ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : undefined);

export function fakeMs(options = {}) {
  const state = {
    signedIn: options.signedIn ?? true,
    /** Whether signing in works when a person is shown how. */
    signInWorks: options.signInWorks ?? true,
    upload: { tenant: true, user: true, ...options.upload },
    apps: new Map(),
    /** Every call, as its arguments, and whether the terminal was handed over. */
    calls: [],
    /** Refuses a call: return `{ code, message }` for the arguments to refuse. */
    fail: options.fail ?? (() => undefined),
    /** The secret a new app is given. */
    secret: options.secret ?? SECRET,
    /** What it prints before its JSON, as npm does the first time it fetches the command. */
    noise: options.noise ?? '',
    n: 0,
  };
  for (const app of options.apps ?? [])
    state.apps.set(app.id, { version: '1.0.0', endpoint: '', permissions: [], validDomains: ['*.botframework.com'], ...app });
  const ok = (value) => ({ code: 0, stdout: `${state.noise}${JSON.stringify(value, null, 2)}\n`, stderr: '' });
  const no = (code, message, suggestion) => ({
    code: 1,
    stdout: `${JSON.stringify({ ok: false, error: { code, message, ...(suggestion ? { suggestion } : {}) } }, null, 2)}\n`,
    stderr: '',
  });
  const link = (id) => `https://teams.microsoft.com/l/app/${id}?installAppPackage=true&appTenantId=${TENANT}`;
  const details = (app) => ({
    appId: app.id,
    teamsAppId: app.id,
    name: app.name,
    longName: app.name,
    version: app.version,
    developer: 'Developer',
    endpoint: app.endpoint || null,
    socketMode: false,
    installLink: link(app.id),
    portalLink: `https://dev.teams.microsoft.com/apps/${app.id}`,
  });

  /** Microsoft's command: `run(args, { show })`. */
  async function run(args, { show = false } = {}) {
    state.calls.push({ args: [...args], show });
    const refused = state.fail(args);
    if (refused) return no(refused.code ?? 'API_ERROR', refused.message);
    const [group, action] = args;
    if (group === 'status') {
      return ok({
        cliVersion: { current: '3.1.0', latest: '3.1.0' },
        loggedIn: state.signedIn,
        username: state.signedIn ? USER : null,
        tenantId: state.signedIn ? TENANT : null,
        tdp: state.signedIn ? { connected: true, sideloading: { tenant: state.upload.tenant, user: state.upload.user } } : null,
      });
    }
    if (group === 'login') {
      if (state.signInWorks) state.signedIn = true;
      return { code: state.signInWorks ? 0 : 1, stdout: '', stderr: '' };
    }
    if (group !== 'app') return { code: 1, stdout: '', stderr: `error: unknown command '${group}'` };
    if (!state.signedIn) return no('AUTH_REQUIRED', 'Not logged in.', 'Run `teams login` first.');
    const bump = (app) => {
      const parts = app.version.split('.').map(Number);
      app.version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    };
    const icon = (app) => {
      const path = flag(args, '--color-icon');
      if (!path) return undefined;
      const size = sizeOf(readFileSync(path));
      if (size?.[0] !== 192 || size?.[1] !== 192) return no('INVALID_ICON', `Icon must be 192x192px, got ${size ? size.join('x') : 'no PNG'}px.`);
      app.icon = readFileSync(path);
      return undefined;
    };
    if (action === 'create') {
      const id = `aaaaaaaa-0000-4000-8000-${String(++state.n).padStart(12, '0')}`;
      const app = {
        id,
        name: flag(args, '--name'),
        version: '1.0.0',
        endpoint: flag(args, '--endpoint') ?? '',
        permissions: [],
        validDomains: ['*.botframework.com'],
      };
      const bad = icon(app);
      if (bad) return bad;
      const file = flag(args, '--env');
      // As the real command writes: the lines there are kept, and these are added.
      const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, `${before}CLIENT_ID=${id}\nCLIENT_SECRET=${state.secret}\nTENANT_ID=${TENANT}\n`);
      app.credentialsFile = file;
      state.apps.set(id, app);
      return ok({
        appName: app.name,
        teamsAppId: id,
        botId: id,
        endpoint: app.endpoint || null,
        installLink: link(id),
        portalLink: `https://dev.teams.microsoft.com/apps/${id}`,
        botLocation: 'teams-managed',
        socketMode: false,
        credentialsFile: file,
      });
    }
    if (action === 'rsc') {
      const app = state.apps.get(args[3]);
      if (!app) return no('UNKNOWN', 'Failed to fetch app details: 404 Not Found');
      if (args[2] === 'list') return ok(app.permissions.map((name) => ({ name, type: 'Application' })));
      app.permissions.push(args[4]);
      bump(app);
      return ok({ added: [{ name: args[4], type: flag(args, '--type') }], skipped: [], needsReinstall: true });
    }
    const app = state.apps.get(args[2]);
    if (!app) return no('UNKNOWN', 'Failed to fetch app details: 404 Not Found');
    if (action === 'get') return ok(details(app));
    if (action === 'update') {
      const bad = icon(app);
      if (bad) return bad;
      const endpoint = flag(args, '--endpoint');
      const name = flag(args, '--name');
      if (endpoint) {
        app.endpoint = endpoint;
        app.validDomains.push(new URL(endpoint).host);
      }
      if (name) app.name = name;
      bump(app);
      return ok({
        teamsAppId: app.id,
        botId: app.id,
        updated: { ...(endpoint ? { endpoint } : {}), ...(name ? { shortName: name } : {}), version: app.version },
        needsReinstall: true,
      });
    }
    return { code: 1, stdout: '', stderr: `error: unknown command '${action}'` };
  }

  return {
    run,
    state,
    apps: () => [...state.apps.values()],
    /** The calls since the last look, each as the command line it was. */
    taken: () => state.calls.splice(0).map((call) => `${call.args.join(' ')}${call.show ? ' (shown)' : ''}`),
  };
}
