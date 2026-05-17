# GraphVault TS 0.2.8 Release Notes

GraphVault TS 0.2.8 is a documentation-quality release for TypeScript consumers.

## What Changed

- Public methods now have usage-oriented TSDoc instead of placeholder comments.
- Storage managers, storage targets, serializers, lazy references, GVQL helpers, NestJS integration, and operational APIs now explain what callers can expect from the method.
- The source-quality gate now rejects generic TSDoc patterns such as `Runs X` and catches `static async` public methods as part of the public API scan.

## Why It Matters

Developers evaluating the package through editor IntelliSense should see practical API guidance at the call site, not generated filler. This release makes the documentation closer to how the library is meant to be used in real TypeScript and NestJS applications.

## Compatibility

There are no runtime API changes in this release. The package remains on the Node.js `>=22` baseline with CI coverage for current LTS lines and newer Node versions.
