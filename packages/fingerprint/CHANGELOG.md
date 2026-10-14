## @lunora/fingerprint [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/fingerprint@1.0.0-alpha.8...@lunora/fingerprint@1.0.0-alpha.9) (2026-08-28)

### ⚠ BREAKING CHANGES

* eleven packages now declare peerDependencies. Consumers that
relied on those packages resolving through hoisting must install them; the
alternative was shipping types that fail to resolve off this repo's node_modules.

`@lunora/workflow` is an optional peer of `@lunora/runtime`, so packem inlines
its types rather than importing them — the published `@lunora/runtime` carries no
`@lunora/workflow` dependency, as its source comments already promised.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

* fix: satisfy eslint and the template matrix after the packem gate

Two CI failures from making packem warnings fatal, each a gate that the local
packem sweep does not cover.

`@lunora/advisor` back to a real dependency on `@lunora/errors`. `ae-metrics.ts`
imports `LunoraError` as a VALUE, and import/no-extraneous-dependencies requires
that for anything under `src/` regardless of whether the module reaches the
bundle. packem cannot see it because that module's value exports are
quarantined — `src/index.ts` re-exports only its types — so the throwing code is
tree-shaken out. The two rules disagree by construction; the packem side is now a
commented `unused` exclusion that says which condition would end it.

`@lunora/workflow` becomes a REQUIRED peer of `@lunora/runtime`. As an optional
peer it was auto-installed anyway, and every one of the twelve templates then
resolved `@lunora/workflow` from the npm REGISTRY instead of this checkout — the
scaffold matrix builds its local-tarball map from required peers only, on the
assumption that optional ones are never pulled in. Forcing the type to inline
instead (`resolveExternals.exclude`) does not work: that option governs the JS
bundle, and the declaration build has its own resolver, so the import survived.
A required peer matches the other seven packages here and keeps the type
resolvable for consumers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))

## @lunora/fingerprint [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/fingerprint@1.0.0-alpha.7...@lunora/fingerprint@1.0.0-alpha.8) (2026-08-24)

### Performance Improvements

* **fingerprint:** clamp stacktrace parsing ([#453](https://github.com/anolilab/lunora/issues/453)) ([891531a](https://github.com/anolilab/lunora/commit/891531a79c200aae9457af3909494f868339a92d))

## @lunora/fingerprint [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Ffingerprint%401.0.0-alpha.6...%40lunora%2Ffingerprint%401.0.0-alpha.7) (2026-08-14)

## @lunora/fingerprint [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Ffingerprint%401.0.0-alpha.5...%40lunora%2Ffingerprint%401.0.0-alpha.6) (2026-08-04)

## @lunora/fingerprint [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Ffingerprint%401.0.0-alpha.4...%40lunora%2Ffingerprint%401.0.0-alpha.5) (2026-08-04)

## @lunora/fingerprint [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Ffingerprint%401.0.0-alpha.3...%40lunora%2Ffingerprint%401.0.0-alpha.4) (2026-07-25)

## @lunora/fingerprint [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Ffingerprint%401.0.0-alpha.2...%40lunora%2Ffingerprint%401.0.0-alpha.3) (2026-07-19)

## @lunora/fingerprint [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Ffingerprint%401.0.0-alpha.1...%40lunora%2Ffingerprint%401.0.0-alpha.2) (2026-07-17)

## @lunora/fingerprint 1.0.0-alpha.1 (2026-07-13)
