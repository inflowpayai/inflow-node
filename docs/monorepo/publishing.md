# Publishing

Packages publish through Changesets and the [release workflow](../../.github/workflows/release.yml) on `main`, using npm
Trusted Publishing and provenance.

## Versions and support

Published packages have independent versions. Before version 1.0, incompatible public API changes require a minor
increment; compatible fixes use a patch increment. From version 1.0, use semantic versioning. See the shared
[SDK support policy](https://github.com/inflowpayai/inflow-specs#sdk-compatibility-and-support) for maintenance of older
releases.

Add a Changeset for changes to published packages:

```sh
pnpm changeset
```

Select the affected packages and bump types, and describe the user-visible change. Include every affected package when a
change crosses package boundaries. Examples and repository-only documentation do not need a package release. The
[Changesets configuration](../../.changeset/config.json) defines package exclusions and internal dependency updates.

## Release flow

1. Merge the reviewed change and its Changeset after checks pass.
2. The workflow opens or updates a `chore(release): version packages` pull request. Review its package versions,
   dependency updates, and changelogs.
3. Merging that version pull request allows the workflow to publish unpublished package versions. An ordinary feature
   merge does not itself apply pending version bumps.
4. Confirm that the release workflow succeeds and that every published package has its expected version and provenance
   attestation on npm.

The workflow builds the packages, then `pnpm release` checks package exports and tarball contents before running
`changeset publish`. It verifies npm provenance attestations after publication, retrying registry reads to accommodate
propagation delays. No pending Changesets and no unpublished versions means there is nothing to publish.

## Verification before release

Run the repository gates:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm typedoc
pnpm check-publish
```

`check-publish` builds the packages, validates export paths, and checks publishable tarballs for `dist/`, `README.md`,
and `LICENSE`. CI also runs shared conformance against the pinned and current contracts, with locked and latest
compatible x402 2.x dependencies. These checks do not send live payments.

## Publishing authentication

Each published npm package needs its own Trusted Publisher configuration:

| Field             | Value         |
| ----------------- | ------------- |
| Repository owner  | `inflowpayai` |
| Repository name   | `inflow-node` |
| Workflow filename | `release.yml` |
| Environment       | Leave blank   |

Configure this in the package's npm settings. The workflow requests a short-lived identity token; it does not require a
permanent `NPM_TOKEN` repository secret. Package manifests enable provenance.

For a new package name, arrange its first publication and Trusted Publisher setup before relying on the release
workflow. Existing packages do not require another bootstrap publication, a no-op version bump, or a workflow-trigger
change.

## Recovering a failed release

Inspect the workflow logs and npm package versions before retrying. Publication of multiple packages is not atomic: some
can succeed before another fails. If publication or registry verification was interrupted, rerun from the same reviewed
release commit; Changesets skips versions already present on npm.

The workflow checks provenance for packages published during that run. For versions published by an earlier attempt,
also inspect `npm view <package>@<version> dist.attestations`; rerunning a workflow does not by itself recheck those
attestations.

Never replace a published version or move its release tag. If the package contents must change, prepare a new version.
After a replacement release is available, an incorrect release can be marked deprecated on npm with a message directing
consumers to the replacement.

## See also

- [Contributing](./contributing.md)
- [Tooling](./tooling.md)
