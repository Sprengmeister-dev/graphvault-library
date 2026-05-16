# GraphVault TS 0.2.5 Release Notes

GraphVault TS 0.2.5 adds field annotations for sensitive, derived, and runtime-only class fields.

## Why Upgrade

Use 0.2.5 if your domain classes contain values that should not be persisted, should not be loaded back from older stores, or should keep runtime defaults after deserialization.

## What Is New Since 0.2.4

- `@GraphVaultIgnore()` excludes a class field from both saving and loading.
- `@GraphVaultIgnoreSave()` omits a field from new commits while still allowing older stored values to load.
- `@GraphVaultIgnoreLoad()` skips assigning stored values during deserialization, preserving constructor or `create()` defaults.
- `registerGraphVaultFieldAnnotation(...)` and `shouldIgnoreGraphVaultField(...)` are exported for custom decorator integrations.
- Field annotations are applied after custom `serialize(...)` and before custom `hydrate(...)`, so they compose with class registrations.

## Example

```ts
import { GraphVaultIgnore, GraphVaultIgnoreLoad, GraphVaultIgnoreSave } from "@sprengmeister/graphvault";

class Account {
  constructor(
    readonly id: string,
    public email: string,
  ) {}

  @GraphVaultIgnore()
  passwordHash = "";

  @GraphVaultIgnoreSave()
  requestCache = new Map<string, unknown>();

  @GraphVaultIgnoreLoad()
  serverComputedRisk = "fresh-default";
}
```

## Verification

Before publishing this release:

```bash
npm test
npm run package:smoke
```

The serializer tests cover normal fields, custom `serialize(...)`, custom `hydrate(...)`, legacy stored values, symbol properties, and standard decorator metadata paths.

## Upgrade Notes

- Node.js 26 or newer remains the supported runtime baseline.
- The feature is additive and does not require store migration.
- TypeScript legacy property-decorator usage requires `experimentalDecorators` in the consuming app.
