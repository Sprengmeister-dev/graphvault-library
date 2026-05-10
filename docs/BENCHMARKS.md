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
- a GVQL grouped aggregate with `HAVING`, aggregate alias ordering, and the primitive-property index
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T16:34:13.764Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL indexed aggregate | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 8.9 ms | 3.9 ms | 1.7 ms | 2.9 ms | - |
| filesystem | 100 | 2949.2 ms | 6.6 ms | 5.2 ms | 44.8 ms | 0.51 MiB |
| memory | 300 | 11.5 ms | 3.7 ms | 3.7 ms | 4.9 ms | - |
| filesystem | 300 | 8026.8 ms | 15.6 ms | 10.4 ms | 76.5 ms | 1.36 MiB |
| memory | 750 | 24.9 ms | 7.4 ms | 7.8 ms | 13.5 ms | - |
| filesystem | 750 | 20374.0 ms | 16.2 ms | 11.7 ms | 178.4 ms | 3.30 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
