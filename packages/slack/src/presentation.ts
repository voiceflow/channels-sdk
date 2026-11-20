// Slack's presentation tools: custom traces a Voiceflow function returns,
// shown natively in their place in the turn. Filled in with the tools.
import type { Chat } from 'chat';
import type { ExtensionHost, TraceHandler } from '@voiceflow/channels-sdk';

export function presentation(_host: () => ExtensionHost | undefined): Record<string, TraceHandler> {
  return {};
}

export function attachFormEvents(_bot: Chat<any, any>, _host: ExtensionHost): void {}
