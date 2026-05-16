# Publishing GraphVault TS

This checklist keeps package releases boring and repeatable.

## Release Discipline

Do not publish every fix immediately. Normal feature work and UI/product polish should stay as regular commits on `main` until a maintainer explicitly asks for a release.

Use this rhythm:

1. Implement one or more changes.
2. Run the relevant local checks.
3. Commit and push to `main`.
4. Keep `package.json` at the latest published version until release preparation starts.
5. Only when a release is requested, bump the package version, update the changelog/release notes, tag the exact commit, and publish once.

This avoids noisy npm patch releases and keeps the installable package aligned with intentional release milestones instead of every small iteration.

## Preconditions

- The package name is final for the release.
- `package.json` has the intended `name`, `version`, `repository`, `homepage`, `bugs`, `license`, `engines`, `exports`, and `files`.
- `CHANGELOG.md` and the matching `docs/RELEASE_NOTES_<version>.md` describe the release.
- `NPM_TOKEN` is configured as a GitHub Actions repository secret for npm publishing.

## Local Release Check

Run these from the repository root:

```bash
npm ci
npm test
npm run benchmark:check
npm run pack:dry-run
npm run package:smoke
```

Inspect the dry-run file list and confirm it contains `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs`, `dist`, `examples`, `benchmarks`, and the logo asset. `npm run package:smoke` installs the generated tarball into a fresh temporary project, imports the public API plus internal subpath exports used by GraphVault Studio, and compiles/runs a minimal NestJS consumer with injection, transactional rollback, GVQL, health checks, backup, and restart persistence.

## Tagging

Create the release tag only after the local release check passes:

```bash
git tag -a v0.1.0 -m "GraphVault TS 0.1.0"
git push origin v0.1.0
```

For the current 0.2.6 release:

```bash
git tag -a v0.2.6 -m "GraphVault TS 0.2.6"
git push origin v0.2.6
```

## Publishing

Use the GitHub Actions `Release` workflow with the matching tag input, for example `v0.2.6`, and set the confirmation input to `PUBLISH`.

The workflow checks out the tag, installs with `npm ci`, runs tests, runs the benchmark regression gate, validates the npm tarball with `npm run pack:dry-run`, installs the tarball in a clean smoke project, and publishes with npm provenance.

Only run the release workflow after the tag is intentionally created for a batched release. Do not use it as part of ordinary development or small follow-up fixes. The workflow refuses to continue unless the confirmation input is exactly `PUBLISH`.

## Repository Visibility

Recommended GitHub topics:

```text
typescript, embedded-database, graph-database, object-graph, persistence, local-first, nestjs, gvql, storage
```
