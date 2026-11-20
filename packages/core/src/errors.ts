export type ChannelsErrorCode =
  | 'unknown_channel'
  | 'not_a_platform'
  | 'adapter_not_installed'
  | 'adapter_factory_missing'
  | 'voiceflow_http'
  | 'voiceflow_response'
  /** The channel refused a post (a card whose image it couldn't download, say); its text form went instead. */
  | 'post_refused'
  /** Buttons from an earlier turn couldn't be taken off their message. */
  | 'edit_failed'
  /** The project to install tools on is in another workspace than the one expected; nothing was changed. */
  | 'wrong_workspace';

/** Every error this package throws on purpose carries a stable `code`. */
export class ChannelsError extends Error {
  readonly code: ChannelsErrorCode;

  constructor(code: ChannelsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChannelsError';
    this.code = code;
  }
}
