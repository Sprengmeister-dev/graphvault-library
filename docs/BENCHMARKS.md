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
- a GVQL multi-`MATCH` join using shared aliases
- a GVQL grouped aggregate with `HAVING`, aggregate alias ordering, and the primitive-property index
- a GVQL multi-property index lookup
- a GVQL indexed `IN` lookup with property-index unions and intersections
- a GVQL indexed `OR` lookup with property-index union planning
- a GVQL computed `RETURN` expression
- GVQL `CREATE ... INTO` and `DELETE` dry-run mutation previews
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T18:28:41.732Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL multi-match join | GVQL indexed aggregate | GVQL multi-index lookup | GVQL indexed IN lookup | GVQL indexed OR lookup | GVQL computed return | GVQL CREATE preview | GVQL DELETE preview | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 8.5 ms | 4.1 ms | 1.7 ms | 2.1 ms | 1.2 ms | 1.5 ms | 2.6 ms | 1.4 ms | 2.1 ms | 1.1 ms | 3.1 ms | - |
| filesystem | 100 | 2744.6 ms | 6.6 ms | 5.5 ms | 3.8 ms | 3.9 ms | 3.6 ms | 3.2 ms | 2.5 ms | 2.5 ms | 2.1 ms | 34.7 ms | 0.51 MiB |
| memory | 300 | 11.4 ms | 4.8 ms | 4.1 ms | 4.0 ms | 2.6 ms | 2.5 ms | 2.3 ms | 2.8 ms | 2.4 ms | 3.0 ms | 4.7 ms | - |
| filesystem | 300 | 8092.3 ms | 11.2 ms | 7.7 ms | 5.8 ms | 4.6 ms | 5.5 ms | 3.8 ms | 3.4 ms | 3.9 ms | 3.3 ms | 69.2 ms | 1.36 MiB |
| memory | 750 | 22.0 ms | 9.1 ms | 6.2 ms | 7.5 ms | 5.4 ms | 7.0 ms | 6.2 ms | 6.9 ms | 10.1 ms | 5.2 ms | 12.4 ms | - |
| filesystem | 750 | 20057.7 ms | 19.1 ms | 15.7 ms | 9.0 ms | 7.3 ms | 6.7 ms | 10.2 ms | 6.3 ms | 6.2 ms | 6.0 ms | 168.7 ms | 3.30 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
