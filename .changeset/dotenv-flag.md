---
'@voiceflow/channels-sdk': minor
'@voiceflow/channels-slack': minor
'@voiceflow/channels-discord': minor
'@voiceflow/channels-teams': minor
'@voiceflow/create-channels-sdk': minor
---

The env file's flag is `--dotenv`, for `connect`, `point`, `disconnect` and `dev`. Node reads `--env-file` itself, even after the command's name, and exits with `node: .env.local: not found` before the command starts when the file isn't there yet ([nodejs/node#54232](https://github.com/nodejs/node/issues/54232)), so a first `connect`, which makes the file, couldn't run. `--env-file` still works for a file that's already there, and says the flag is `--dotenv` now. A new app's `connect` and `dev` scripts use `--dotenv`.
