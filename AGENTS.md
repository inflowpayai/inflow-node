# AGENTS.md

Operating notes for working in this repo. If anything below conflicts with the configs (`eslint.config.js`, `typedoc.json`, `tsconfig.base.json`, `turbo.json`, `.changeset/config.json`, `.prettierrc.json`), the configs win — fix the drift, don't paper over it.

## What this repo is

A pnpm + Turborepo monorepo of InFlow's open-source Node SDKs, organized by product. Every package, example, and product doc folder takes a product prefix (`x402-`, `mpp-`, …) so products coexist without ambiguity.

- Foundation packages: `@x402/*` — declared as `peerDependencies`, never bundled.
- InFlow's published packages: `@inflowpayai/*`.
- Examples illustrate end-to-end use; they don't publish.

## Repo map

- `packages/<product>-*/` — publishable SDKs. One folder per package.
- `examples/<product>-*/` — runnable end-to-end examples. Never published.
- `docs/<product>/` — product docs (overview, architecture, wire format, extensions).
- `docs/monorepo/` — repo-level docs: `contributing.md`, `tooling.md`, `publishing.md`, `documentation.md`.
- `scripts/` — repo-level dev/CI scripts (export checks, publish verification).
- `.changeset/` — pending version bumps. PRs touching `packages/**` need an entry.

Load-bearing root files — touch with care: `tsconfig.base.json`, `turbo.json`, `eslint.config.js`, `.changeset/config.json`, `typedoc.json`, `.prettierrc.json`, `pnpm-workspace.yaml`.

## Before merging

Run all four. CI runs the same.

- `pnpm typecheck` — `tsc --noEmit` against both `tsconfig.json` (src) and `tsconfig.test.json` (src + test) per package.
- `pnpm lint` — eslint with `--max-warnings 0`.
- `pnpm test` — vitest with v8 coverage; per-package thresholds are enforced and the build fails below floor.
- `pnpm typedoc` — generates the public API reference; catches broken `{@link}` and internal-type leakage into public signatures.

Scope to one package with `pnpm --filter @inflowpayai/<name> <task>`.

## Conventions

Rules the tooling can't enforce. Breaking them lands a regression.

- **Product prefix.** Package, example folder, and product doc folder share the same `<product>-` prefix. New product means new prefix everywhere — no exceptions.
- **Peer deps stay external.** Foundation packages (`@x402/*`) are `peerDependencies` and never bundled. tsup leaves declared peers unbundled by default; don't move them into `dependencies`.
- **No `any`, no `!` non-null, no `as unknown as`** except at documented type boundaries. The canonical justified boundary cast is in `packages/x402-buyer/src/inflow-client.ts`.
- **No `console.*` in `packages/**/src/**`.** Publishable code throws typed errors and lets the caller decide what to log. `console.*` is fine in `examples/` (the output is the example) and `scripts/` (dev CLIs).
- **The package barrel is the public surface.** Anything in `src/index.ts` is public API; anything else is implementation detail.
- **`@internal` for exported-but-not-public symbols.** If a source-file export isn't re-exported from the barrel, either add `@internal` or move it into the barrel. Don't leave the question ambiguous.
- **No emoji** in code, commits, or PR descriptions unless the request explicitly calls for them.
- **No "future work" / "phase 2" / "TODO: refactor later" comments.** Describe what the code does now, or delete the comment.

## Adding a package or product

For a new package inside an existing product: follow the template in `docs/monorepo/contributing.md` — `packages/<product>-<name>/{src,test/unit}`, `package.json` with the standard fields (`peerDependencies`, `publishConfig.access: public`, `publishConfig.provenance: true`), `tsconfig.json` + `tsconfig.test.json`, `tsup.config.ts`, `vitest.config.ts`, `README.md`. Then `pnpm install` to refresh the lockfile.

For a new product: pick the prefix once, then apply it everywhere — `packages/<prefix>-*`, `examples/<prefix>-*`, `docs/<prefix>/`. Update the product table in the root `README.md`.

## Writing docs

The short version of `docs/monorepo/documentation.md`:

- TSDoc is for what the signature **doesn't** say. Don't paraphrase parameters, don't restate return types, don't list defaults that live in the signature.
- If no non-obvious sentence comes to mind, leave the symbol bare. The linter does not require TSDoc on every export.
- Use `{@link Foo}` only for symbols re-exported from the package barrel — links must resolve from the published API reference.
- One line per field on wire-shape interfaces, naming what each field represents semantically (`payTo address; signs the authorization`).
- `@internal` for symbols not re-exported from the barrel.
- Every package README ships a working example. Type it into a real `.ts` file before merging — arity drift in copy-pasteable snippets is a recurring bug.

The full guide (quality bar, anti-patterns, good patterns, validation flow) is in `docs/monorepo/documentation.md`. Read it before any non-trivial doc PR.

## Branch model, commits, releases

- Short-lived branches off `main`. Conventional Commits, scoped by package: `feat(x402-seller): …`. Full convention in `docs/monorepo/contributing.md`.
- PRs touching `packages/**` need a Changeset (`pnpm changeset`). CI fails without one.
- Release flow uses `changesets/action@v1` from `.github/workflows/release.yml`. Full flow in `docs/monorepo/publishing.md`.

## When stuck

- Product behavior: `docs/<product>/architecture.md`.
- Workflow, commands, branch model: `docs/monorepo/contributing.md`.
- Tool configuration (pnpm, Turbo, tsup, Vitest, MSW, ESLint, Prettier): `docs/monorepo/tooling.md`.
- Release, changelog, npm publishing: `docs/monorepo/publishing.md`.
- TSDoc and README style: `docs/monorepo/documentation.md`.

## Working as an agent

These rules apply to LLM agents picking up tasks in this repo. They aren't enforceable by CI; the cost of breaking them is wasted reviewer cycles or a regression that ships.

### Interaction

- **Ask when the task is underspecified.** Surface missing **facts** before writing: which package, which scheme (`exact` vs `permit2`), buyer or seller side, which framework adapter, EVM vs SVM. These are knowable — don't guess. For design choices, see the architect rule below.
- **Don't execute on questions, ideas, or plans until the user explicitly says so.** A question is a question; a plan is a plan. Wait for an unambiguous "go" / "do it" / "yes" before writing code or files. Surfacing options is not approval to pick one.
- **You are the architect; the user is the decision maker.** For **design choices** — how to structure something, which pattern to apply, what to name a thing — propose, recommend, and surface the tradeoffs. Don't punt them back as open-ended questions ("what would you like to do?"), and don't make them unilaterally. The user approves or redirects.
- **No hand waving.** Be concrete and specific. No "should generally", "consider whether", "this might work" — if you have a recommendation, make it; if you don't, name what you'd need to know to form one.
- **When explaining, ground the explanation.** Don't state a rule, a tradeoff, or a behavior without the referent — point at the file, quote the call site, sketch the example or the solution. A claim without a referent is noise.

### Code work

- **Don't guess at signatures or behavior.** If you don't know what a function does, read it. If you don't know what a type exports, check the barrel. Inferring from naming alone fails on this repo's foundation/InFlow boundary.
- **Don't fabricate.** Never claim a function exists, a type is exported, or a behavior is implemented without verifying. If something looks like it should exist but doesn't, surface that — don't invent it.
- **Don't improvise patterns.** If a similar problem is already solved in this repo, follow the existing pattern — the canonical example is usually in a sibling package or under `examples/`. Adding a new helper, util, or dependency without justifying why the existing pattern doesn't cover the case is rejected on review.
- **Research before writing.** For non-trivial work, read the relevant `docs/<product>/architecture.md` first. Then grep for the symbol in question to see how it's used elsewhere. Then write.
- **Minimal diffs.** Change as little as possible to achieve the goal. Don't reformat unrelated lines, don't sweep style fixes across files outside your scope, don't bump dependencies unless the task is the bump.

### Done

- **Verify before claiming done.** Run `pnpm typecheck && pnpm lint && pnpm test` (and `pnpm typedoc` if the public surface or any `{@link}` changed) before reporting success. "It looks right" is not verification.
- **Surface conflicts; don't paper over them.** If the request would require breaking a convention above, stop and say so. Don't reach for `eslint-disable`, `@ts-ignore`, or `as any` to make a check pass.
- **No "TODO" / "phase 2" escape hatches.** If a piece of work is out of scope, drop it cleanly and note it — don't leave a stub or a comment promising future cleanup.
