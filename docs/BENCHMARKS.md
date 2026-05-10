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
- a GVQL property-graph query across object references
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T16:10:18.815Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL select | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 7.5 ms | 2.8 ms | 2.8 ms | - |
| filesystem | 100 | 2619.9 ms | 4.9 ms | 51.1 ms | 0.50 MiB |
| memory | 300 | 11.4 ms | 2.4 ms | 6.7 ms | - |
| filesystem | 300 | 7864.9 ms | 11.0 ms | 82.3 ms | 1.34 MiB |
| memory | 750 | 21.9 ms | 4.1 ms | 10.5 ms | - |
| filesystem | 750 | 20180.6 ms | 13.4 ms | 188.2 ms | 3.26 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
