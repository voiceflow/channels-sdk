// Who the agent is talking to, and where: Slack context set as Voiceflow
// variables on every turn. The Slack tools read these as their identity (wired
// so the agent can't fill them), which is why they come from the verified
// event, never from the model. The model itself sees one only where the
// agent's instructions or global prompt reference it: a variable is stored
// data, not the model's context.
import type { TurnContext } from '@voiceflow/channels-sdk';
import { type SlackWebClient, slackAdapter, where } from './adapter.js';

/** Every variable this package sets, with what it holds. The installer creates them on the agent. */
export const CONTEXT_VARIABLES = {
  slack_user_id: 'The Slack user ID of the person in this conversation.',
  slack_user_name: "The person's name in Slack.",
  slack_user_title: "The person's title in their Slack profile.",
  slack_user_timezone: "The person's time zone, as an IANA name (America/Toronto).",
  slack_user_email: "The person's email address in Slack (needs the users:read.email scope).",
  slack_team_id: 'The Slack workspace ID.',
  slack_channel_id: 'The Slack channel, DM or group DM this conversation is in.',
  slack_channel_name: 'The channel\'s name, without "#". Empty in DMs.',
  slack_channel_type: 'channel, private_channel, dm or group_dm.',
  slack_thread_ts: "The Slack thread this conversation is in (its first message's timestamp).",
  slack_message_ts: "The timestamp of the person's latest message. Empty when the turn came from a button.",
  slack_viewing_channel_id: 'In the assistant panel: the channel the person has open beside it.',
} as const;

export type ContextVariable = keyof typeof CONTEXT_VARIABLES;

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

/** A small time-limited cache, so a busy thread doesn't look the same person up every turn. */
function cache<T>() {
  const entries = new Map<string, { value: T; at: number }>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await load();
    if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    entries.set(key, { value, at: Date.now() });
    return value;
  };
}

interface UserInfo {
  name: string;
  title: string;
  timezone: string;
  email: string;
}

interface ChannelInfo {
  name: string;
  type: 'channel' | 'private_channel' | 'dm' | 'group_dm';
}

export function createContext() {
  const users = cache<UserInfo | null>();
  const channels = cache<ChannelInfo | null>();
  const teams = cache<string>();

  const user = (client: SlackWebClient, id: string) =>
    users(id, async () => {
      const { user: u } = await client.apiCall('users.info', { user: id });
      if (!u) return null;
      return {
        name: u.real_name || u.profile?.real_name || u.profile?.display_name || u.name || '',
        title: u.profile?.title ?? '',
        timezone: u.tz ?? '',
        email: u.profile?.email ?? '',
      };
    });

  const channel = (client: SlackWebClient, id: string) =>
    channels(id, async () => {
      const { channel: c } = await client.apiCall('conversations.info', { channel: id });
      if (!c) return null;
      const type = c.is_im ? 'dm' : c.is_mpim ? 'group_dm' : c.is_private ? 'private_channel' : 'channel';
      return { name: c.is_im ? '' : (c.name ?? ''), type };
    });

  const team = (client: SlackWebClient, botUserId: string) => teams(botUserId, async () => (await client.apiCall('auth.test')).team_id ?? '');

  /**
   * The turn's context variables: every one, every turn, empty when unknown. A
   * variable left out would keep its value from an earlier turn on the
   * session, perhaps someone else's. A lookup Slack refuses (a missing scope)
   * leaves its variables empty.
   */
  return async function variables(ctx: TurnContext, viewing?: string): Promise<Record<ContextVariable, string>> {
    const out = Object.fromEntries(Object.keys(CONTEXT_VARIABLES).map((k) => [k, ''])) as Record<ContextVariable, string>;
    out.slack_user_id = ctx.userId ?? '';
    out.slack_message_ts = ctx.message?.id ?? '';
    out.slack_viewing_channel_id = viewing ?? '';
    try {
      const adapter = slackAdapter(ctx.thread);
      const client = adapter.webClient;
      const { channel: channelId, threadTs } = where(ctx.thread);
      const [u, c, teamId] = await Promise.all([
        out.slack_user_id ? user(client, out.slack_user_id).catch(() => null) : null,
        channel(client, channelId).catch(() => null),
        team(client, adapter.botUserId ?? '').catch(() => ''),
      ]);
      Object.assign(out, {
        slack_user_name: u?.name ?? '',
        slack_user_title: u?.title ?? '',
        slack_user_timezone: u?.timezone ?? '',
        slack_user_email: u?.email ?? '',
        slack_team_id: teamId,
        slack_channel_id: channelId,
        slack_channel_name: c?.name ?? '',
        slack_channel_type: c?.type ?? (channelId.startsWith('D') ? 'dm' : 'channel'),
        slack_thread_ts: threadTs,
      });
    } catch {
      // Where the turn is couldn't be read: the rest stay empty.
    }
    return out;
  };
}
