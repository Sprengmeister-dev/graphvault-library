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
- a GVQL `CASE` expression for conditional projections
- a GVQL `WITH` pipeline with aggregate projection
- GVQL `CREATE ... INTO`, `MERGE ... INTO ... ON`, and `DELETE` dry-run mutation previews
- both in-memory and local filesystem storage targets

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T19:24:58.191Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL multi-match join | GVQL optional match | GVQL indexed aggregate | GVQL multi-index lookup | GVQL indexed IN lookup | GVQL indexed OR lookup | GVQL computed return | GVQL scalar functions | GVQL CASE expression | GVQL WITH pipeline | GVQL CREATE preview | GVQL MERGE preview | GVQL DELETE preview | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 7.6 ms | 4.5 ms | 2.4 ms | 2.2 ms | 1.8 ms | 1.4 ms | 1.5 ms | 1.2 ms | 1.8 ms | 1.4 ms | 1.6 ms | 1.7 ms | 1.7 ms | 1.3 ms | 0.8 ms | 2.9 ms | - |
| filesystem | 100 | 2659.6 ms | 2.8 ms | 2.2 ms | 2.6 ms | 2.0 ms | 1.6 ms | 1.7 ms | 1.5 ms | 1.6 ms | 1.8 ms | 1.5 ms | 1.7 ms | 1.6 ms | 1.3 ms | 1.5 ms | 31.9 ms | 0.51 MiB |
| memory | 300 | 10.7 ms | 3.9 ms | 2.7 ms | 3.4 ms | 2.5 ms | 2.4 ms | 2.4 ms | 2.4 ms | 2.3 ms | 2.7 ms | 3.3 ms | 2.5 ms | 2.3 ms | 2.4 ms | 2.1 ms | 5.1 ms | - |
| filesystem | 300 | 8215.4 ms | 6.8 ms | 5.6 ms | 6.3 ms | 3.7 ms | 3.5 ms | 3.6 ms | 3.4 ms | 3.5 ms | 2.9 ms | 3.1 ms | 3.2 ms | 3.0 ms | 3.3 ms | 2.4 ms | 73.5 ms | 1.36 MiB |
| memory | 750 | 21.8 ms | 8.6 ms | 6.0 ms | 6.4 ms | 6.7 ms | 5.4 ms | 5.1 ms | 5.7 ms | 5.7 ms | 5.5 ms | 5.7 ms | 5.2 ms | 4.8 ms | 5.8 ms | 4.7 ms | 11.7 ms | - |
| filesystem | 750 | 20028.9 ms | 19.1 ms | 14.1 ms | 9.5 ms | 8.2 ms | 6.3 ms | 6.9 ms | 5.9 ms | 5.9 ms | 6.1 ms | 6.0 ms | 5.1 ms | 6.1 ms | 5.0 ms | 5.2 ms | 167.1 ms | 3.30 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with atomic file replacement. That favors crash safety and debuggability over raw write throughput.

For local development, small embedded apps, test harnesses, and admin tooling, this trade-off is usually comfortable. For write-heavy workloads, prefer a remote target with better write parallelism characteristics or tune the storage target implementation for your deployment.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
