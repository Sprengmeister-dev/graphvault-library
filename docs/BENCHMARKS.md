# Benchmarks

GraphVault ships with a reproducible benchmark so performance claims can be checked on your own machine:

```bash
npm run benchmark
```

For automation, the same benchmark can emit JSON and run a small regression gate:

```bash
npm run benchmark:json
npm run benchmark:check
```

`benchmark:json` writes `benchmark-results.json`. `benchmark:check` runs a shorter 100-document profile against memory and `filesystem/maximum`, writes `benchmark-check.json`, and fails if conservative latency budgets are exceeded. Both JSON files are ignored by Git so they can be collected by CI without dirtying the tree.

The underlying script also supports direct options:

```bash
node benchmarks/object-graph.mjs --sizes 100,300 --targets memory,filesystem/maximum --json --output results.json
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
- persistent `index.json` reuse for committed type, property, and graph-edge lookup tables
- a GVQL computed `RETURN` expression
- GVQL scalar functions in `WHERE` and `RETURN`
- a GVQL `CASE` expression for conditional projections
- a GVQL `WITH` pipeline with aggregate projection
- GVQL `CREATE ... INTO`, `MERGE ... INTO ... ON`, and `DELETE` dry-run mutation previews
- in-memory storage, standard local filesystem storage, and maximum-throughput local filesystem storage

## Latest Local Run

Environment:

- Runtime: Node.js `v26.1.0`
- Platform: `darwin arm64`
- Date: `2026-05-14T19:25:52.028Z`
- Storage format: GraphVault `0.2.3` with WAL and transaction-versioned object records

| target | documents | storeRoot | GVQL traversal | GVQL multi-match join | GVQL optional match | GVQL indexed aggregate | GVQL multi-index lookup | GVQL indexed IN lookup | GVQL indexed OR lookup | GVQL computed return | GVQL scalar functions | GVQL CASE expression | GVQL WITH pipeline | GVQL CREATE preview | GVQL MERGE preview | GVQL DELETE preview | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 21.8 ms | 4.2 ms | 2.4 ms | 2.3 ms | 2.5 ms | 2.4 ms | 1.6 ms | 1.4 ms | 1.9 ms | 1.7 ms | 1.7 ms | 1.7 ms | 2.3 ms | 1.8 ms | 1.4 ms | 5.0 ms | - |
| filesystem | 100 | 2856.9 ms | 2.8 ms | 2.3 ms | 2.4 ms | 1.7 ms | 1.4 ms | 2.1 ms | 1.2 ms | 1.7 ms | 1.7 ms | 2.5 ms | 1.5 ms | 1.7 ms | 1.7 ms | 1.3 ms | 40.7 ms | 1.02 MiB |
| filesystem/maximum | 100 | 60.1 ms | 2.2 ms | 1.7 ms | 2.0 ms | 2.2 ms | 1.8 ms | 2.1 ms | 1.5 ms | 1.4 ms | 2.1 ms | 1.6 ms | 2.3 ms | 1.8 ms | 1.8 ms | 1.3 ms | 31.9 ms | 0.44 MiB |
| memory | 300 | 39.3 ms | 4.5 ms | 4.6 ms | 4.4 ms | 3.6 ms | 3.5 ms | 3.6 ms | 3.7 ms | 3.9 ms | 3.9 ms | 4.4 ms | 4.7 ms | 3.8 ms | 3.6 ms | 4.0 ms | 10.4 ms | - |
| filesystem | 300 | 8220.0 ms | 4.1 ms | 4.1 ms | 3.9 ms | 3.9 ms | 3.4 ms | 3.0 ms | 3.1 ms | 3.0 ms | 3.4 ms | 3.6 ms | 3.3 ms | 3.5 ms | 3.1 ms | 3.0 ms | 94.9 ms | 2.73 MiB |
| filesystem/maximum | 300 | 135.3 ms | 3.2 ms | 3.2 ms | 3.0 ms | 3.8 ms | 2.9 ms | 3.0 ms | 2.9 ms | 3.0 ms | 3.3 ms | 3.6 ms | 3.3 ms | 2.9 ms | 2.8 ms | 2.4 ms | 73.2 ms | 1.18 MiB |
| memory | 750 | 76.5 ms | 9.4 ms | 11.2 ms | 9.1 ms | 8.5 ms | 7.1 ms | 7.5 ms | 8.0 ms | 7.4 ms | 8.4 ms | 7.2 ms | 6.9 ms | 7.2 ms | 6.9 ms | 6.6 ms | 20.8 ms | - |
| filesystem | 750 | 19891.3 ms | 10.2 ms | 10.6 ms | 10.5 ms | 8.7 ms | 8.8 ms | 7.8 ms | 8.9 ms | 9.3 ms | 7.9 ms | 9.1 ms | 8.2 ms | 8.3 ms | 9.2 ms | 7.8 ms | 244.6 ms | 6.62 MiB |
| filesystem/maximum | 750 | 323.1 ms | 12.7 ms | 10.8 ms | 10.0 ms | 8.9 ms | 8.1 ms | 8.6 ms | 8.3 ms | 9.0 ms | 8.2 ms | 9.0 ms | 8.8 ms | 8.3 ms | 7.9 ms | 8.3 ms | 197.0 ms | 2.88 MiB |

## Reading The Numbers

The in-memory target shows the serializer, object graph traversal, and GVQL execution cost. The standard filesystem target is deliberately conservative: it writes binary object records and inspectable JSON records with fsynced atomic file replacement. That favors crash safety and debuggability over raw write throughput.

`filesystem/maximum` uses `writeProfile: "maximum"`: binary-only object records, compact JSON metadata, relaxed local atomic writes, higher object-record concurrency, and manifest-based loading without checkpoint snapshots. In this run, local `storeRoot` improved from `19,891.3 ms` to `323.1 ms` at 750 documents while storage size dropped from `6.62 MiB` to `2.88 MiB`.

Version `0.2.x` adds WAL metadata and transaction-versioned object records for stronger crash behavior. That costs disk space and some write throughput compared with the first public format, but it prevents older manifests from observing partially written newer object records.

For local development, small embedded apps, test harnesses, and admin tooling, the standard trade-off is usually comfortable. For write-heavy workloads, use a write profile explicitly and benchmark your own graph.

Benchmarks are not a replacement for measuring your own graph. They are a regression guard and a quick way to understand the current storage profile.
