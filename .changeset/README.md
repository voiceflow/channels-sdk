# Changesets

Each pull request that changes a published package adds a changeset: a small
Markdown file saying which packages change, by how much, and why, in a line
for the changelog.

```bash
npx changeset
```

`@voiceflow/channels-sdk` and `@voiceflow/channels-slack` share one version
number, so a changeset for either moves both. When changesets land on `main`,
the release workflow opens a "version packages" pull request; merging it
publishes to npm. See [CONTRIBUTING.md](../CONTRIBUTING.md#changesets).
