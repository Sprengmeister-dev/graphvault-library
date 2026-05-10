# Contributing

Thanks for helping improve GraphVault Library.

## Local Development

```bash
npm ci
npm test
npm run benchmark
```

`npm test` builds the TypeScript sources and runs a smoke test that stores and reloads a real object graph with class instances, shared references, maps, sets, and cycles.

## Pull Request Checklist

- keep source files focused and reasonably small
- add or update a smoke test when behavior changes
- update the README or docs when public APIs or configuration change
- run `npm test` before opening the PR
- run `npm run benchmark` when touching serialization, storage layout, storage targets, or writer performance

## Release Checklist

1. Update `CHANGELOG.md`.
2. Run `npm test`.
3. Run `npm run benchmark` and refresh `docs/BENCHMARKS.md` when performance changed.
4. Run `npm run pack:dry-run` and inspect the packaged files.
5. Publish with an npm account that owns the chosen package name.
