# @voiceflow/create-channels-sdk

## 0.2.0

### Minor Changes

- 205ecee: The env file's flag is `--dotenv`, for `connect`, `point`, `disconnect` and `dev`. Node reads `--env-file` itself, even after the command's name, and exits with `node: .env.local: not found` before the command starts when the file isn't there yet ([nodejs/node#54232](https://github.com/nodejs/node/issues/54232)), so a first `connect`, which makes the file, couldn't run. `--env-file` still works for a file that's already there, and says the flag is `--dotenv` now. A new app's `connect` and `dev` scripts use `--dotenv`.

## 0.1.1

No changes in this release.

## 0.1.0

### Minor Changes

- The first release. A Voiceflow agent in Slack, Discord, Microsoft Teams, Telegram, WhatsApp and nine more channels: one package for each, one command to set each up, and a starter that makes the app.
