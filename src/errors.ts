export type ChannelsErrorCode =
  | 'unknown_channel'
  | 'not_a_platform'
  | 'adapter_not_installed'
  | 'adapter_factory_missing'
  | 'voiceflow_http'
  | 'voiceflow_response';

/** Every error this package throws on purpose carries a stable `code`. */
export class ChannelsError extends Error {
  readonly code: ChannelsErrorCode;

  constructor(code: ChannelsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChannelsError';
    this.code = code;
  }
}
