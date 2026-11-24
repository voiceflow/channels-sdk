// Slack's app-management API, called with the Slack CLI's login. Node only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '@voiceflow/channelkit';

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly error: string,
    readonly details: unknown[] = [],
  ) {
    super(`${method}: ${error}${details.length ? ` ${JSON.stringify(details).slice(0, 600)}` : ''}${hint(error)}`);
    this.name = 'SlackApiError';
  }
}

function hint(error: string): string {
  if (error === 'token_expired' || error === 'invalid_auth' || error === 'not_authed') {
    return '. Your Slack CLI login has expired: run `slack auth list` to refresh it, or `slack login`.';
  }
  return '';
}

export interface SlackApiOptions {
  /** A token that can manage apps: the Slack CLI's login (see `slackCliToken`). Never printed. */
  token: string;
  apiURL?: string;
  fetch?: typeof fetch;
}

/** `form` sends the params form-encoded; `multipart` as a multipart form, where a `File` goes as an upload. */
export type SlackApi = <T = any>(
  method: string,
  params?: Record<string, unknown>,
  options?: { form?: boolean; multipart?: boolean; token?: string },
) => Promise<T>;

export function createSlackApi(options: SlackApiOptions): SlackApi {
  const base = (options.apiURL ?? 'https://slack.com/api').replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  return async (method, params = {}, { form = false, multipart = false, token = options.token } = {}) => {
    let body: string | FormData;
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (multipart) {
      // fetch sets the multipart content type, with its boundary.
      body = new FormData();
      for (const [k, v] of Object.entries(params)) body.append(k, v instanceof Blob ? v : String(v));
    } else if (form) {
      body = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify(params);
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    const res = await doFetch(`${base}/${method}`, { method: 'POST', headers, body });
    const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as any;
    if (!json.ok) {
      // What Slack says is cleaned of the token before the error cuts it: a cut could leave most of one behind.
      const clean = (value: unknown) => JSON.parse(redact(JSON.stringify(value), [token, options.token]));
      const details = Array.isArray(json.errors) ? json.errors : [];
      throw new SlackApiError(method, String(clean(json.error ?? 'unknown_error')), clean(details));
    }
    return json;
  };
}

export interface SlackCliLogin {
  teamId: string;
  teamDomain?: string;
  token: string;
}

/** Where the Slack CLI keeps its logins. */
export const SLACK_CLI_CREDENTIALS = path.join(os.homedir(), '.slack', 'credentials.json');

/** Every workspace the Slack CLI is logged in to. A file that isn't there, or can't be read, is no logins. */
export function slackCliLogins(file = SLACK_CLI_CREDENTIALS): SlackCliLogin[] {
  let all: Record<string, { token?: string; team_domain?: string } | null>;
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!all || typeof all !== 'object') return [];
  return Object.entries(all).flatMap(([teamId, login]) =>
    login?.token ? [{ teamId, token: login.token, ...(login.team_domain ? { teamDomain: login.team_domain } : {}) }] : [],
  );
}

/**
 * The Slack CLI's login for a workspace (`slack login`), read from
 * ~/.slack/credentials.json. Its token can create and install apps there.
 */
export function slackCliLogin(teamId?: string, file = SLACK_CLI_CREDENTIALS): SlackCliLogin {
  let all: Record<string, { token?: string; team_domain?: string; team_id?: string }>;
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('No Slack CLI login found. Install the Slack CLI (https://tools.slack.dev/slack-cli) and run `slack login`.');
  }
  const teams = Object.keys(all).filter((id) => all[id]?.token);
  if (teamId) {
    const login = all[teamId];
    if (!login?.token)
      throw new Error(`The Slack CLI isn't logged in to workspace ${teamId}${teams.length ? ` (it is to ${teams.join(', ')})` : ''}. Run \`slack login\`.`);
    return { teamId, token: login.token, ...(login.team_domain ? { teamDomain: login.team_domain } : {}) };
  }
  if (teams.length === 1) {
    const only = all[teams[0]!]!;
    return { teamId: teams[0]!, token: only.token!, ...(only.team_domain ? { teamDomain: only.team_domain } : {}) };
  }
  if (!teams.length) throw new Error('The Slack CLI has no login. Run `slack login`.');
  throw new Error(
    `The Slack CLI is logged in to several workspaces: name one with --team (${teams.map((id) => `${id}${all[id]!.team_domain ? ` ${all[id]!.team_domain}` : ''}`).join(', ')}).`,
  );
}
