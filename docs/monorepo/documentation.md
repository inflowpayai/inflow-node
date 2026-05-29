# Documentation

How to write and validate documentation in this monorepo — TSDoc on public exports, READMEs that boot, and the `docs/`
tree.

## The quality bar

When writing TSDoc, ask three questions in order:

1. **When should the caller reach for this?** If the function's name doesn't answer that, write the answer in one
   sentence.
2. **What's the expected outcome?** Surface anything that isn't obvious from the return type — caching behavior,
   idempotency, side effects, server round trips, default values that match server-side limits.
3. **What's non-obvious about the contract?** `@throws` for typed errors, ordering guarantees, what happens at
   boundaries, references to a function that wraps this one.

If none of those produces a useful sentence, **the symbol is self-documenting — leave it bare**. The linter does not
require TSDoc on every export.

## Anti-patterns

Rejected on review:

- `@param x - The x to use.` — paraphrases the signature. Delete.
- `@returns A promise of the result.` — type-level information, not behavior. Delete.
- Long essays explaining why a constant is named what it is. The const definition is right there. Trim to one line.
- Repeating rationale from a sibling doc. Pick one home for the explanation (usually the product's `architecture.md`)
  and link.
- `{@link foo}` to a symbol not re-exported from the package's barrel — the link won't resolve from the published API
  reference.

## Good patterns

- `Pass these as the third argument to paymentMiddlewareFromConfig; the foundation refuses to boot otherwise.` — encodes
  a non-obvious constraint the type system can't enforce.
- `Defaults to 5 seconds; no jitter or backoff.` — surfaces a behavioral fact that matters at debug time.
- `@throws {@link X402PriceParseError} when the input doesn't match any accepted form.` — typed-error contract.
- One line per field on a wire-shape interface, naming what each field represents semantically
  (`payTo address; signs the authorization`). Not "the address field."

## The `@internal` convention

A symbol is `@internal` if it's exported from a source file for testing or composition reasons but is **not** meant for
npm consumers. Mark it in TSDoc with a bare `@internal` tag, and explain "why internal" in the TSDoc body above the tag:

```ts
/**
 * Async factory for {@link InflowSigner}. Implementation detail of {@link createInflowClient}; not re-exported from
 * the package barrel.
 *
 * @internal
 */
export async function createInflowSigner(options: SignerOptions): Promise<InflowSigner> { ... }
```

`@internal` must be bare — the `jsdoc/empty-tags` lint rule enforces this, matching how api-extractor and most
TS-ecosystem tooling reads `@internal` (it's a marker tag, not a header). Any explanatory prose goes into the TSDoc body
above the tag list.

Rule of thumb: if a symbol isn't re-exported from the package's `src/index.ts` barrel, it's either internal (add
`@internal`) or it should be in the barrel. Don't leave the question ambiguous.

A public class with an `@internal` constructor is fine — the type is exported for `instanceof` and generic-constraint
reasons, while construction goes through a factory function.

## READMEs

Every package ships a working example in its README. If a reader copy-pastes it and it doesn't boot, the README is
broken regardless of how accurate the prose is. Type the example into a real `.ts` file before merging — arity drift in
copy-pasteable snippets is a recurring bug class.

## Enforcement

Three tools enforce a slice of the above. Their configurations — not this doc — are the source of truth.

- **`eslint-plugin-jsdoc`** — see `eslint.config.js`. Runs as part of `pnpm lint`. Hard-fails on TSDoc-with-types, empty
  blocks, bad tag names, and formatting drift. Deliberately does **not** require TSDoc on every export — the quality bar
  says "leave bare when self-documenting."
- **`prettier-plugin-jsdoc`** — see `.prettierrc.json`. Runs as part of `pnpm format`. Auto-reflows TSDoc bodies to
  `printWidth`. Write paragraphs as long lines and let format wrap them. Bumping `printWidth` should be committed
  separately from any semantic change so reviewers can ignore the reflow.
- **`typedoc`** — see `typedoc.json`. Run via `pnpm typedoc`. Generates the public API reference into `docs/api/`
  (gitignored). Flags broken `{@link}` references and non-exported types leaking into public signatures.

Companion lint rule: **`no-console` is `error` on `packages/**/src/**/\*.ts`.** Publishable code throws typed errors and
lets the caller decide what to log. `console.*` is fine in `examples/` and `scripts/`.

## Validating a documentation change

```bash
pnpm typecheck   # type-system drift in src + test
pnpm lint        # TSDoc bloat + no-console leaks into publishable code
pnpm format      # reflows TSDoc to printWidth
pnpm typedoc     # broken {@link}, leaked internal types
pnpm test        # behavioral drift the type system missed
```

For doc-only changes that don't touch source: still run `pnpm typedoc` if you edited any `{@link}` references or any
code snippet a reader would copy-paste.

If any of these fail, fix the underlying cause before merging — don't disable the rule. The rules exist because the
patterns they catch shipped to npm in the past.

## When in doubt

- Re-read this file.
- Then re-read the product's `architecture.md` to ground yourself in what the SDK actually does.
- Then write the doc.

Don't write the doc first and reverse-engineer the rationale.
