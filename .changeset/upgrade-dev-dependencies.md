---
---

chore: upgrade dev dependencies and regenerate the pnpm lockfile

Tooling-only, no release. Bumps root `devDependencies` (typescript, typescript-eslint, eslint, prettier, vitest, tsup,
turbo, typedoc, changesets, `@types/node`, and friends) and regenerates `pnpm-lock.yaml`. No published package changes
its runtime or public types — the `mpp`/`x402` `types.ts` edits are prettier reformatting only, and the base-URL
override is in the ignored `@inflowpayai/example-*` workspace.
