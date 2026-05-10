# Publishing GraphVault Library

This checklist keeps the first public package release boring and repeatable.

## Preconditions

- The package name is final for the release.
- `package.json` has the intended `name`, `version`, `repository`, `homepage`, `bugs`, `license`, `engines`, `exports`, and `files`.
- `CHANGELOG.md` and `docs/RELEASE_NOTES_0.1.0.md` describe the release.
- `NPM_TOKEN` is configured as a GitHub Actions repository secret for npm publishing.

## Local Release Check

Run these from the repository root:

```bash
npm ci
npm test
npm run benchmark
npm run pack:dry-run
```

Inspect the dry-run file list and confirm it contains `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs`, `dist`, `examples`, `benchmarks`, and the logo asset.

## Tagging

Create the release tag only after the local release check passes:

```bash
git tag -a v0.1.0 -m "GraphVault Library 0.1.0"
git push origin v0.1.0
```

## Publishing

Use the GitHub Actions `Release` workflow with the matching tag input, for example `v0.1.0`.

The workflow checks out the tag, installs with `npm ci`, runs tests, runs the benchmark, validates the npm tarball with `npm run pack:dry-run`, and publishes with npm provenance.

## Repository Visibility

Recommended GitHub topics:

```text
typescript, embedded-database, graph-database, object-graph, persistence, local-first, nestjs, gvql, storage
```
