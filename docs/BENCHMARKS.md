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
- in-memory storage, standard local filesystem storage, and maximum-throughput local filesystem storage

## Latest Local Run

Environment:

- Runtime: Node.js `v25.9.0`
- Platform: `darwin arm64`
- Date: `2026-05-10T19:55:53.432Z`
- Storage format: GraphVault `0.1.0`

| target | documents | storeRoot | GVQL traversal | GVQL multi-match join | GVQL optional match | GVQL indexed aggregate | GVQL multi-index lookup | GVQL indexed IN lookup | GVQL indexed OR lookup | GVQL computed return | GVQL scalar functions | GVQL CASE expression | GVQL WITH pipeline | GVQL CREATE preview | GVQL MERGE preview | GVQL DELETE preview | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 7.2 ms | 4.0 ms | 1.8 ms | 2.0 ms | 2.3 ms | 1.3 ms | 1.3 ms | 1.4 ms | 1.4 ms | 1.8 ms | 1.4 ms | 1.6 ms | 1.4 ms | 1.1 ms | 0.9 ms | 3.3 ms | - |
| filesystem | 100 | 2883.6 ms | 4.8 ms | 6.7 ms | 4.0 ms | 3.4 ms | 3.0 ms | 3.3 ms | 2.7 ms | 2.2 ms | 2.1 ms | 2.0 ms | 1.8 ms | 1.6 ms | 1.7 ms | 2.0 ms | 33.8 ms | 0.51 MiB |
| filesystem/maximum | 100 | 35.7 ms | 1.6 ms | 1.4 ms | 1.9 ms | 1.0 ms | 0.9 ms | 1.0 ms | 1.0 ms | 1.3 ms | 1.9 ms | 1.2 ms | 1.1 ms | 1.0 ms | 1.1 ms | 0.8 ms | 21.7 ms | 0.16 MiB |
| memory | 300 | 11.1 ms | 4.2 ms | 2.7 ms | 3.1 ms | 3.5 ms | 2.6 ms | 2.4 ms | 2.5 ms | 2.3 ms | 2.8 ms | 2.8 ms | 2.9 ms | 2.2 ms | 3.2 ms | 2.8 ms | 6.0 ms | - |
| filesystem | 300 | 7851.8 ms | 8.7 ms | 8.6 ms | 7.3 ms | 6.4 ms | 4.3 ms | 4.2 ms | 3.3 ms | 4.1 ms | 3.5 ms | 3.1 ms | 3.0 ms | 2.9 ms | 2.9 ms | 3.8 ms | 75.8 ms | 1.36 MiB |
| filesystem/maximum | 300 | 85.0 ms | 2.7 ms | 4.0 ms | 2.5 ms | 2.4 ms | 2.2 ms | 2.8 ms | 2.1 ms | 3.2 ms | 2.4 ms | 2.9 ms | 2.2 ms | 2.1 ms | 2.1 ms | 2.0 ms | 61.4 ms | 0.44 MiB |
| memory | 750 | 22.2 ms | 5.6 ms | 7.7 ms | 6.5 ms | 5.5 ms | 5.5 ms | 5.7 ms | 5.1 ms | 6.3 ms | 5.6 ms | 5.8 ms | 6.1 ms | 5.7 ms | 5.1 ms | 6.5 ms | 10.5 ms | - |
| filesystem | 750 | 19277.9 ms | 17.3 ms | 16.3 ms | 10.1 ms | 9.2 ms | 6.9 ms | 10.5 ms | 6.5 ms | 8.4 ms | 7.0 ms | 10.9 ms | 5.6 ms | 5.7 ms | 7.3 ms | 7.7 ms | 199.9 ms | 3.30 MiB |
| filesystem/maximum | 750 | 226.7 ms | 13.0 ms | 8.6 ms | 8.1 ms | 6.9 ms | 8.7 ms | 6.7 ms | 7.3 ms | 5.7 ms | 8.4 ms | 5.6 ms | 5.6 ms | 6.4 ms | 7.6 ms | 6.1 ms | 156.2 ms | 1.07 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The standard filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with fsynced atomic file replacement. That favors crash safety and debuggability over raw write throughput.

`filesystem/maximum` uses `writeProfile: "maximum"`: binary-only object records, compact JSON metadata, relaxed local atomic writes, higher object-record concurrency, and manifest-based loading without checkpoint snapshots. In this run, local `storeRoot` improved from `19,277.9 ms` to `226.7 ms` at 750 documents while storage size dropped from `3.30 MiB` to `1.07 MiB`.

For local development, small embedded apps, test harnesses, and admin tooling, the standard trade-off is usually comfortable. For write-heavy workloads, use a write profile explicitly and benchmark your own graph.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
