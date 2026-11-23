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
  | 'wrong_workspace'
  /** A secret to write a value into exists and isn't restricted, so its value could be revealed; nothing was changed. */
  | 'secret_not_restricted';

/** Every error this package throws on purpose carries a stable `code`. */
export class ChannelsError extends Error {
  readonly code: ChannelsErrorCode;

  constructor(code: ChannelsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChannelsError';
    this.code = code;
  }
}

/**
 * A command can't go on until a person does something: sign in, install a
 * tool, set a key. The message says what, and how to carry on. A command
 * turns it into exit code 3, so a script or a coding agent that ran it knows
 * to hand the message over and run the command again.
 */
export class NeedsYou extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsYou';
  }
}
