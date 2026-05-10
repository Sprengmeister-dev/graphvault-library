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
- a GVQL indexed `IN` lookup with property-index unions and intersections
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T17:05:32.700Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL indexed aggregate | GVQL multi-index lookup | GVQL indexed IN lookup | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 7.5 ms | 4.2 ms | 1.8 ms | 1.6 ms | 1.4 ms | 2.8 ms | - |
| filesystem | 100 | 2811.5 ms | 3.4 ms | 4.4 ms | 2.5 ms | 2.6 ms | 39.4 ms | 0.51 MiB |
| memory | 300 | 11.2 ms | 3.1 ms | 2.6 ms | 2.5 ms | 3.5 ms | 5.0 ms | - |
| filesystem | 300 | 8371.7 ms | 14.0 ms | 7.6 ms | 8.1 ms | 4.2 ms | 91.8 ms | 1.36 MiB |
| memory | 750 | 23.1 ms | 7.3 ms | 6.9 ms | 7.8 ms | 7.0 ms | 12.7 ms | - |
| filesystem | 750 | 19879.0 ms | 8.9 ms | 9.6 ms | 6.8 ms | 8.4 ms | 193.7 ms | 3.30 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
