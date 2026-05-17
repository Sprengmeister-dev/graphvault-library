# GraphVault TS 0.2.7 Release Notes

GraphVault TS 0.2.7 makes the write profile names match how the package should be used in real applications.

## Why Upgrade

Earlier releases defaulted to the inspectable filesystem profile. That was useful for debugging, but it made first benchmarks look much slower than the production-oriented storage path. Version 0.2.7 makes the high-throughput profile the default.

## What Changed

- `writeProfile` now accepts `production`, `balanced`, and `inspect`.
- The default write profile is now `production`.
- `production` writes compact binary object records, skips checkpoint snapshots by default, and uses higher object-record write concurrency.
- `inspect` keeps the old inspectable behavior: JSON sidecars, binary object records, checkpoint snapshots, pretty metadata, and strict local flush behavior.
- Benchmark targets are now `filesystem/production` and `filesystem/inspect`.

## Migration Note

This release intentionally removes the old profile names `standard`, `fast`, and `maximum`. Update configuration as follows:

| Old | New |
| --- | --- |
| `standard` | `inspect` |
| `fast` | `balanced` |
| `maximum` | `production` |

If your critical store relied on checkpoint snapshots or strict local fsync behavior through the old default profile, set those options explicitly:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
  writeProfile: "production",
  writeDurability: "strict",
  writeSnapshots: true,
});
```

There is no storage-format change in this release.
