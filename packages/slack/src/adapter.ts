// The Slack adapter's public surface this package uses, typed structurally so
// it holds across adapter versions. Every call goes through the adapter (its
// methods, or its `webClient` for Web API methods it has no wrapper for):
// this package never handles Slack's tokens or signatures itself.
import type { Message, Thread } from 'chat';

export interface SlackWebClient {
  apiCall(method: string, options?: Record<string, unknown>): Promise<any>;
}

export interface SlackAdapterLike {
  readonly name: string;
  readonly botUserId?: string;
  readonly webClient: SlackWebClient;
  decodeThreadId(threadId: string): { channel: string; threadTs: string };
  encodeThreadId(data: { channel: string; threadTs: string }): string;
  addReaction(threadId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(threadId: string, messageId: string, emoji: string): Promise<void>;
  fetchMessages(threadId: string, options?: { limit?: number; direction?: 'forward' | 'backward' }): Promise<{ messages: Message<any>[] }>;
  setSuggestedPrompts(channelId: string, threadTs: string, prompts: { title: string; message: string }[], title?: string): Promise<void>;
  setAssistantTitle(channelId: string, threadTs: string, title: string): Promise<void>;
  publishHomeView(userId: string, view: Record<string, unknown>): Promise<void>;
}

export const SLUG = 'slack';

export function slackAdapter(thread: Thread<any, any>): SlackAdapterLike {
  return thread.adapter as unknown as SlackAdapterLike;
}

/** The Slack channel and thread a Chat SDK thread ID names. */
export function where(thread: Thread<any, any>): { channel: string; threadTs: string } {
  return slackAdapter(thread).decodeThreadId(thread.id);
}
