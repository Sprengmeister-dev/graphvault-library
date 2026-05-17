# GraphVault TS 0.2.9 Release Notes

GraphVault TS 0.2.9 adds storage-enforced field constraints.

## What Changed

- Added constraint decorators for required fields, persisted value types, enums, min/max bounds, unique values, and reference existence checks.
- Constraints are discovered from registered class annotations and run before WAL prepare, so failed writes do not publish partial transactions.
- Added `StorageManager.validateConstraints()` for explicit validation and `StorageManager.constraintRecord()` for reading the persisted constraint contract.
- Added `constraints.json` metadata so admin tooling can inspect the active constraint definitions and latest validation result.
- Added focused tests for annotation discovery, commit rejection, disabled constraints, persisted records, and reference checks.

## Why It Matters

These constraints cover the fast, practical DB-style invariants that should not live only in application service code. They are intentionally scoped to cheap commit-path checks instead of arbitrary graph scans, preserving GraphVault's write-performance profile.

## Compatibility

This release keeps the Node.js `>=22` baseline. Existing stores without constraint annotations continue to commit without extra validation work.
