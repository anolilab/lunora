---
"@lunora/d1": patch
---
Republish with the `@lunora/sql-store` floor the source already declares (`^1.0.0-alpha.239`). The 1.0.0-alpha.238 tarball shipped the pre-release `^1.0.0-alpha.237`, which admits sql-store 237 and 238; neither exports `prepareGlobalImportRow`, so loading `@lunora/d1` failed with an ESM link error (#1666).
