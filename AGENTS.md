# AGENTS.md

Operating notes for working in this repo. If anything below conflicts with the configs (`eslint.config.js`,
`typedoc.json`, `tsconfig.base.json`, `turbo.json`, `.changeset/config.json`, `.prettierrc.json`), the configs win — fix
the drift, don't paper over it.

## What this repo is

A pnpm + Turborepo monorepo of InFlow's open-source Node SDKs, organized by product. Every package, example, and product
doc folder takes a product prefix (`x402-`, `mpp-`, …) so products coexist without ambiguity.

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

Load-bearing root files — touch with care: `tsconfig.base.json`, `turbo.json`, `eslint.config.js`,
`.changeset/config.json`, `typedoc.json`, `.prettierrc.json`, `pnpm-workspace.yaml`.

## Before merging

Run all four. CI runs the same.

- `pnpm typecheck` — `tsc --noEmit` against both `tsconfig.json` (src) and `tsconfig.test.json` (src + test) per
  package.
- `pnpm lint` — eslint with `--max-warnings 0`.
- `pnpm test` — vitest with v8 coverage; per-package thresholds are enforced and the build fails below floor.
- `pnpm typedoc` — generates the public API reference; catches broken `{@link}` and internal-type leakage into public
  signatures.

Scope to one package with `pnpm --filter @inflowpayai/<name> <task>`.

## Conventions

Rules the tooling can't enforce. Breaking them lands a regression.

- **Product prefix.** Package, example folder, and product doc folder share the same `<product>-` prefix. New product
  means new prefix everywhere — no exceptions.
- **Peer deps stay external.** Foundation packages (`@x402/*`) are `peerDependencies` and never bundled. tsup leaves
  declared peers unbundled by default; don't move them into `dependencies`.
- **No `any`, no `!` non-null, no `as unknown as`** except at documented type boundaries. The canonical justified
  boundary cast is in `packages/x402-buyer/src/inflow-client.ts`.
- **No `console.*` in `packages/**/src/**`.** Publishable code throws typed errors and lets the caller decide what to
  log. `console.*` is fine in `examples/` (the output is the example) and `scripts/` (dev CLIs).
- **The package barrel is the public surface.** Anything in `src/index.ts` is public API; anything else is
  implementation detail.
- **`@internal` for exported-but-not-public symbols.** If a source-file export isn't re-exported from the barrel, either
  add `@internal` or move it into the barrel. Don't leave the question ambiguous.
- **No emoji** in code, commits, or PR descriptions unless the request explicitly calls for them.
- **No stub comments.** Don't leave `TODO`, `phase 2`, or `refactor later` notes in shipped code — describe what the
  code does now, or delete the comment. This is about comments, not scope: splitting a task, deferring genuinely
  out-of-scope work to a separate change, or stopping to confirm direction is expected, not a violation.
- **Comments only for what the code can't say.** No restatement of behavior, no rationale-padding, no historical
  justification. If no non-obvious sentence comes to mind, no comment. Applies to every comment syntax — TSDoc, inline,
  YAML, shell, JSON-with-comments. The TSDoc rule under [Writing docs](#writing-docs) is this rule applied to one
  syntax.
- **Write to the current state, not the change.** Comments and docs address a reader who has only the current tree —
  never a prior version they can't see. Don't phrase a fact relative to what changed: avoid "now", "no longer",
  "previously", "used to", "removed", "renamed", "added behavior", "prior/pre-X behavior", "reshaped". State the fact
  directly — not "the server no longer verifies an HMAC binding" but "redemption is not HMAC-bound". This bans the
  framing, not the fact: documenting a notable absence is fine. Change-relative narration belongs in the Changeset and
  commit message, not in code or docs.

## Node version management

Three knobs, three audiences. Don't conflate them.

- **`package.json` `engines.node`** — the floor users of the published packages need. Currently `>=22.0.0` in the root
  and every `packages/*/package.json`. Users see install errors when they're below this; don't bump without a real
  reason.
- **`.github/workflows/ci.yml` `matrix.node`** — what CI tests against. Currently `[22, 24]`. Must be a superset of
  `engines.node`; catches forward-compat drift one LTS cycle ahead. `release.yml` pins a single version (the active LTS,
  currently `24`) for publish reproducibility — that's separate from the test matrix.
- **`.nvmrc`** — what contributors use locally. Currently `22`. Read by `nvm`, `fnm`, and `volta` on directory entry.
  Pinned to the floor so contributors test the floor by default.

These are independent decisions. Bumping CI to test Node 26 does not bump `engines.node`. Bumping `engines.node` to drop
Node 22 does not bump `.nvmrc`.

## Adding a package or product

For a new package inside an existing product: follow the template in `docs/monorepo/contributing.md` —
`packages/<product>-<name>/{src,test/unit}`, `package.json` with the standard fields (`peerDependencies`,
`publishConfig.access: public`, `publishConfig.provenance: true`), `tsconfig.json` + `tsconfig.test.json`,
`tsup.config.ts`, `vitest.config.ts`, `README.md`. Then `pnpm install` to refresh the lockfile.

For a new product: pick the prefix once, then apply it everywhere — `packages/<prefix>-*`, `examples/<prefix>-*`,
`docs/<prefix>/`. Update the product table in the root `README.md`.

## Writing docs

The short version of `docs/monorepo/documentation.md`:

- TSDoc is for what the signature **doesn't** say. Don't paraphrase parameters, don't restate return types, don't list
  defaults that live in the signature.
- If no non-obvious sentence comes to mind, leave the symbol bare. The linter does not require TSDoc on every export.
- Use `{@link Foo}` only for symbols re-exported from the package barrel — links must resolve from the published API
  reference.
- One line per field on wire-shape interfaces, naming what each field represents semantically
  (`payTo address; signs the authorization`).
- `@internal` for symbols not re-exported from the barrel.
- Every package README ships a working example. Type it into a real `.ts` file before merging — arity drift in
  copy-pasteable snippets is a recurring bug.

The full guide (quality bar, anti-patterns, good patterns, validation flow) is in `docs/monorepo/documentation.md`. Read
it before any non-trivial doc PR.

## Branch model, commits, releases

- Short-lived branches off `main`. Conventional Commits, scoped by package: `feat(x402-seller): …`. Full convention in
  `docs/monorepo/contributing.md`.
- PRs touching `packages/**` need a Changeset (`pnpm changeset`). CI fails without one.
- Release flow uses `changesets/action@v1` from `.github/workflows/release.yml`. Full flow in
  `docs/monorepo/publishing.md`.

## When stuck

- Product behavior: `docs/<product>/architecture.md`.
- Workflow, commands, branch model: `docs/monorepo/contributing.md`.
- Tool configuration (pnpm, Turbo, tsup, Vitest, MSW, ESLint, Prettier): `docs/monorepo/tooling.md`.
- Release, changelog, npm publishing: `docs/monorepo/publishing.md`.
- TSDoc and README style: `docs/monorepo/documentation.md`.

## Working as an agent

These rules apply to LLM agents picking up tasks in this repo. They aren't enforceable by CI; the cost of breaking them
is wasted reviewer cycles or a regression that ships.

### Non-negotiables

These three come before the pressure to finish quickly. When they conflict with "get it done," they win.

- **Check the contract before you build on it.** Before you rely on anything across a boundary — an endpoint's audience,
  authentication, and response shape; what a function or framework actually does; what another package exports — read
  the authoritative source and cite where you found it (file and line) in your report. Two things looking alike by name
  is not proof: a seller "config" endpoint is not the buyer "supported" endpoint just because both describe
  capabilities. If the right target does not exist, or the instruction is ambiguous, stop and ask.
- **Pausing to confirm is never a failure.** Shipping on an unchecked assumption is. You may stop at any point — to
  confirm context, check a fact, or ask for direction — and you are encouraged to do so at a low threshold, before you
  have committed to an approach.
- **Do not trust a check that fakes the thing you are unsure about.** A test or stand-in that imitates the exact
  behavior you have not verified proves nothing about the real thing. Confirm against the real implementation.

### Interaction

- **Confirm you have the right context before doing the work.** Surface missing facts before writing — and treat a fact
  you have not checked against the source as missing. Knowable facts here include which package, which scheme (`exact`
  or `permit2`), buyer or seller side, which framework adapter, and EVM or SVM. If a fact is knowable by reading the
  code, read it and cite where you found it before relying on it. When you are unsure about scope, intent, or whether
  you have enough to proceed, stop and ask. A low bar for asking is preferred over guessing.
- **Don't execute on questions, ideas, or plans until the user explicitly says so.** A question is a question; a plan is
  a plan. Wait for an unambiguous "go" / "do it" / "yes" before writing code or files. Surfacing options is not approval
  to pick one.
- **You are the architect; the user decides.** For how to structure, name, or pattern something, propose and recommend
  with the tradeoffs. When the choice is genuinely the user's — a public interface or output shape, scope, anything
  touching money or credentials, or anything where their words are ambiguous — ask. A short question that lays out the
  options and your recommendation is the right move, not a failure; only the bare, analysis-free "what do you want?" is
  discouraged. Ask in the chat as a numbered list — each item with a little context or an example, any options to choose
  from, and your recommendation — rather than a tool that limits the number of questions or the space to read them.
- **No hand waving.** Be concrete and specific. No "should generally", "consider whether", "this might work" — if you
  have a recommendation, make it; if you don't, name what you'd need to know to form one.
- **When explaining, ground the explanation.** Don't state a rule, a tradeoff, or a behavior without the referent —
  point at the file, quote the call site, sketch the example or the solution. A claim without a referent is noise.
- **No abbreviations.** Spell things out in replies, comments, and docs. Don't use abbreviations or acronyms the reader
  may not know (for example, don't write "DoD" for "definition of done"). Names this codebase already uses are fine.

### Code work

- **Don't guess at signatures or behavior.** If you don't know what a function does, read it. If you don't know what a
  type exports, check the barrel. Inferring from naming alone fails on this repo's foundation/InFlow boundary.
- **Don't fabricate.** Never claim a function exists, a type is exported, or a behavior is implemented without
  verifying. If something looks like it should exist but doesn't, surface that — don't invent it.
- **Don't improvise patterns.** If a similar problem is already solved in this repo, follow the existing pattern — the
  canonical example is usually in a sibling package or under `examples/`. Adding a new helper, util, or dependency
  without justifying why the existing pattern doesn't cover the case is rejected on review.
- **Research before writing.** For non-trivial work, read the relevant `docs/<product>/architecture.md` first. Then grep
  for the symbol in question to see how it's used elsewhere. Then write.
- **Cross-repository work.** When a change depends on another repository's behavior, confirm that behavior in that
  repository before writing code against it.
- **Don't silently drop work.** If something you would treat as out of scope is actually needed to finish the agreed
  goal, do not skip it without a word — surface it and ask how to proceed.
- **Minimal diffs.** Change as little as possible to achieve the goal. Don't reformat unrelated lines, don't sweep style
  fixes across files outside your scope, don't bump dependencies unless the task is the bump.
- **Comments are part of the diff.** A 14-line comment above a 9-line code change is not a minimal diff. See the comment
  rule under [Conventions](#conventions).

### Done

- **Run the real checks before you say it works.** Run the full gate set this repo defines — `tsc` against both the
  source config and the test config, lint, tests, and `pnpm typedoc` when the public surface or a documentation link
  changed — not a subset. In your report, name each command you ran and its result. Never write "done", "passing", or
  "verified" for a check you did not actually run; if you could not run one (for example, the environment cannot), say
  so plainly and hand it off — do not imply it passed. Do not claim tests or coverage pass without running the suite.
- **Surface conflicts; don't paper over them.** If the request would require breaking a convention above, stop and say
  so. Don't reach for `eslint-disable`, `@ts-ignore`, or `as any` to make a check pass.
- **Show your work in the report.** List the files you changed, the exact commands you ran with their outcomes, and mark
  each assumption as either checked-against-its-source or not-yet-checked. The reader should be able to see what is
  verified and what is not without rerunning anything.
