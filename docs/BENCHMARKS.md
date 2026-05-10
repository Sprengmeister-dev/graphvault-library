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
- a GVQL `OPTIONAL MATCH` query for left-join style graph expansion
- a GVQL grouped aggregate with `HAVING`, aggregate alias ordering, and the primitive-property index
- a GVQL multi-property index lookup
- a GVQL indexed `IN` lookup with property-index unions and intersections
- a GVQL indexed `OR` lookup with property-index union planning
- a GVQL computed `RETURN` expression
- GVQL scalar functions in `WHERE` and `RETURN`
- GVQL `CREATE ... INTO` and `DELETE` dry-run mutation previews
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T18:41:56.949Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL multi-match join | GVQL optional match | GVQL indexed aggregate | GVQL multi-index lookup | GVQL indexed IN lookup | GVQL indexed OR lookup | GVQL computed return | GVQL scalar functions | GVQL CREATE preview | GVQL DELETE preview | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 8.4 ms | 4.3 ms | 1.8 ms | 2.0 ms | 1.8 ms | 1.3 ms | 1.5 ms | 1.2 ms | 2.3 ms | 1.6 ms | 2.0 ms | 0.9 ms | 2.7 ms | - |
| filesystem | 100 | 2718.6 ms | 7.5 ms | 5.2 ms | 5.9 ms | 3.9 ms | 2.8 ms | 3.0 ms | 2.5 ms | 3.2 ms | 2.3 ms | 2.3 ms | 2.3 ms | 32.9 ms | 0.51 MiB |
| memory | 300 | 11.5 ms | 4.4 ms | 3.0 ms | 2.9 ms | 2.6 ms | 3.1 ms | 2.5 ms | 2.5 ms | 2.5 ms | 2.7 ms | 2.5 ms | 2.9 ms | 5.2 ms | - |
| filesystem | 300 | 8129.0 ms | 8.7 ms | 9.2 ms | 5.7 ms | 5.1 ms | 4.2 ms | 4.1 ms | 3.3 ms | 4.0 ms | 3.3 ms | 3.5 ms | 3.3 ms | 68.5 ms | 1.36 MiB |
| memory | 750 | 22.4 ms | 8.6 ms | 6.7 ms | 6.5 ms | 7.0 ms | 5.5 ms | 5.3 ms | 5.6 ms | 5.5 ms | 6.0 ms | 5.6 ms | 5.0 ms | 11.1 ms | - |
| filesystem | 750 | 19921.1 ms | 11.8 ms | 11.3 ms | 9.1 ms | 7.8 ms | 5.9 ms | 5.9 ms | 6.3 ms | 6.1 ms | 5.9 ms | 5.7 ms | 4.7 ms | 166.2 ms | 3.30 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
