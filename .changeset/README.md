# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

When you make a user-visible change to any package under `packages/`, run:

```bash
pnpm changeset
```

Pick the affected packages, pick the bump type (`patch` / `minor` / `major`),
and write a short, user-facing summary. The CLI writes a `*.md` file in this
folder; commit it alongside your code change.

The release workflow (`.github/workflows/release.yml`) consumes these files
on merge to `main` to open or update the "chore(release): version packages"
PR. When that PR is merged, Changesets publishes the bumped packages.

Examples (`@inflowpayai/example-*`) are excluded via the `ignore` field
in `config.json`.

For more, see [docs/monorepo/publishing.md](../docs/monorepo/publishing.md).
