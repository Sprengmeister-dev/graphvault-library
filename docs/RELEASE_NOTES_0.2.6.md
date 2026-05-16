# GraphVault TS 0.2.6 Release Notes

GraphVault TS 0.2.6 is a small runtime-compatibility release that makes Node.js LTS support explicit for npm consumers and CI.

## Why Upgrade

Use 0.2.6 if your production services run on Node.js LTS rather than the newest Current line. The package now declares Node.js `>=22` instead of requiring Node.js 26.

## What Changed

- `package.json` and `package-lock.json` now declare `engines.node` as `>=22`.
- CI validates GraphVault TS on Node.js 22, 24, and 26.
- Release and GitHub Packages workflows use Node.js 24 LTS.
- README and release notes now describe the LTS runtime baseline.

## Compatibility

There are no API or storage-format changes in this release. Existing GraphVault 0.2.x stores and applications can upgrade without code changes.

Node.js 20 is no longer an appropriate baseline because it has reached end-of-life. Node.js 22 and newer are supported, with Node.js 24 used as the release workflow baseline.
