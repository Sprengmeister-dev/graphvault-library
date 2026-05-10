# Benchmarks

GraphVault ships with a reproducible benchmark so performance claims can be checked on your own machine:

```bash
npm run benchmark
```

The benchmark creates a typed object graph with:

- registered classes
- shared owner and category references
- `Map` and `Set`
- `Date` values
- arrays of related objects
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T15:45:55.737Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | reload | storage size |
| --- | ---: | ---: | ---: | ---: |
| memory | 100 | 7.1 ms | 2.8 ms | - |
| filesystem | 100 | 2810.0 ms | 50.9 ms | 0.50 MiB |
| memory | 300 | 11.2 ms | 5.9 ms | - |
| filesystem | 300 | 7890.6 ms | 88.4 ms | 1.34 MiB |
| memory | 750 | 21.8 ms | 10.7 ms | - |
| filesystem | 750 | 20048.4 ms | 182.4 ms | 3.26 MiB |

## Reading The Numbers

The in-memory target shows the serializer and object graph traversal cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
