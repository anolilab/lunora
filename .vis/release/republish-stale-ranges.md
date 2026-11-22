---
"@lunora/agent": patch
"@lunora/astro": patch
"@lunora/bindings": patch
"@lunora/cli": patch
"@lunora/config": patch
"@lunora/do": patch
"@lunora/hyperdrive": patch
"@lunora/nuxt": patch
"@lunora/observability": patch
"@lunora/platform-celld": patch
"@lunora/platform-cloudflare": patch
"@lunora/platform-node": patch
"@lunora/privacy": patch
"@lunora/queue": patch
"@lunora/rspack": patch
"@lunora/runtime": patch
"@lunora/scheduler": patch
"@lunora/shard-engine": patch
"@lunora/sql-store": patch
"@lunora/storage": patch
"@lunora/studio": patch
"@lunora/testing": patch
"@lunora/vite": patch
"lunorash": patch
---
Republish with the internal dependency ranges the release commit declares. These tarballs were packed from the manifest read before the version step, so they shipped older floors (an existing lockfile could keep a sibling that lacks what the code imports) and some exact pins such as `@lunora/platform@1.0.0-alpha.80` (installs hold a second copy). The release tool now publishes the versioned manifest (#1666).
