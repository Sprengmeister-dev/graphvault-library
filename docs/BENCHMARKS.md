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
- a GVQL multi-property index lookup
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T16:41:28.231Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL indexed aggregate | GVQL multi-index lookup | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 8.9 ms | 4.8 ms | 1.8 ms | 1.7 ms | 3.0 ms | - |
| filesystem | 100 | 2930.8 ms | 4.9 ms | 4.5 ms | 5.0 ms | 42.4 ms | 0.51 MiB |
| memory | 300 | 12.8 ms | 3.5 ms | 4.0 ms | 4.1 ms | 5.1 ms | - |
| filesystem | 300 | 8112.0 ms | 6.7 ms | 4.5 ms | 4.1 ms | 86.5 ms | 1.36 MiB |
| memory | 750 | 25.6 ms | 9.2 ms | 9.2 ms | 8.7 ms | 15.2 ms | - |
| filesystem | 750 | 19824.6 ms | 12.1 ms | 10.9 ms | 7.4 ms | 164.2 ms | 3.30 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
