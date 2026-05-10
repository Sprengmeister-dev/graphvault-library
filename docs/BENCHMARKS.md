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
- a GVQL grouped aggregate using the primitive-property index
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T16:20:41.955Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL indexed aggregate | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 9.4 ms | 3.7 ms | 2.6 ms | 3.1 ms | - |
| filesystem | 100 | 2857.1 ms | 5.4 ms | 3.2 ms | 40.2 ms | 0.50 MiB |
| memory | 300 | 11.4 ms | 2.8 ms | 2.2 ms | 4.8 ms | - |
| filesystem | 300 | 7911.8 ms | 9.9 ms | 9.5 ms | 94.9 ms | 1.34 MiB |
| memory | 750 | 21.9 ms | 5.6 ms | 4.5 ms | 10.5 ms | - |
| filesystem | 750 | 20113.5 ms | 15.1 ms | 10.2 ms | 174.2 ms | 3.26 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
