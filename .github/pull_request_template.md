## Summary

<!-- What this changes, and why. Link the issue it fixes: "Fixes #123". -->

## Test plan

<!-- How you checked it. For a change to how something behaves in Slack, say what you tried in Slack itself. -->

## Checklist

- [ ] `npm run validate` passes
- [ ] A test covers the change, and fails without it
- [ ] A changeset is added (`npx changeset`), or the change needs none: see [CONTRIBUTING.md](https://github.com/voiceflow/channelkit/blob/main/CONTRIBUTING.md#changesets)
- [ ] A changed tool's `version` is raised and its hash recorded in `packages/slack/test/tool-versions.json`, or no tool's code changed
- [ ] Docs are updated, or nothing documented changed
- [ ] No token, secret or key appears in the code, tests, logs or this description
