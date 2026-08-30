## @lunora/ai [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/@lunora/ai@1.0.0-alpha.64...@lunora/ai@1.0.0-alpha.65) (2026-08-30)

### Features

* **hyperdrive:** pgvector-backed ctx.vectors, plus a design plan for the embedded runtime ([#530](https://github.com/anolilab/lunora/issues/530)) ([58e0c0c](https://github.com/anolilab/lunora/commit/58e0c0cf154293ef0be8c48683d471b5533559f6))

## @lunora/ai [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/@lunora/ai@1.0.0-alpha.63...@lunora/ai@1.0.0-alpha.64) (2026-08-29)

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


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.26

## @lunora/ai [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/@lunora/ai@1.0.0-alpha.62...@lunora/ai@1.0.0-alpha.63) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25

## @lunora/ai [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/@lunora/ai@1.0.0-alpha.61...@lunora/ai@1.0.0-alpha.62) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24

## @lunora/ai [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/@lunora/ai@1.0.0-alpha.60...@lunora/ai@1.0.0-alpha.61) (2026-08-26)

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/ai [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.59...%40lunora%2Fai%401.0.0-alpha.60) (2026-08-18)

## @lunora/ai [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.58...%40lunora%2Fai%401.0.0-alpha.59) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/ai [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.57...%40lunora%2Fai%401.0.0-alpha.58) (2026-08-12)

## @lunora/ai [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.56...%40lunora%2Fai%401.0.0-alpha.57) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21

## @lunora/ai [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.55...%40lunora%2Fai%401.0.0-alpha.56) (2026-08-10)

## @lunora/ai [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.54...%40lunora%2Fai%401.0.0-alpha.55) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/ai [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.53...%40lunora%2Fai%401.0.0-alpha.54) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19

## @lunora/ai [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.52...%40lunora%2Fai%401.0.0-alpha.53) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/ai [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.51...%40lunora%2Fai%401.0.0-alpha.52) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17

## @lunora/ai [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.50...%40lunora%2Fai%401.0.0-alpha.51) (2026-08-08)

## @lunora/ai [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.49...%40lunora%2Fai%401.0.0-alpha.50) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/ai [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.48...%40lunora%2Fai%401.0.0-alpha.49) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/ai [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.47...%40lunora%2Fai%401.0.0-alpha.48) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14

## @lunora/ai [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.46...%40lunora%2Fai%401.0.0-alpha.47) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13

## @lunora/ai [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.45...%40lunora%2Fai%401.0.0-alpha.46) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12

## @lunora/ai [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.44...%40lunora%2Fai%401.0.0-alpha.45) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11

## @lunora/ai [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.43...%40lunora%2Fai%401.0.0-alpha.44) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/ai [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.42...%40lunora%2Fai%401.0.0-alpha.43) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/ai [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.41...%40lunora%2Fai%401.0.0-alpha.42) (2026-07-28)

## @lunora/ai [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.40...%40lunora%2Fai%401.0.0-alpha.41) (2026-07-27)

## @lunora/ai [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.39...%40lunora%2Fai%401.0.0-alpha.40) (2026-07-27)

## @lunora/ai [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.38...%40lunora%2Fai%401.0.0-alpha.39) (2026-07-27)

## @lunora/ai [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.37...%40lunora%2Fai%401.0.0-alpha.38) (2026-07-27)

## @lunora/ai [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.36...%40lunora%2Fai%401.0.0-alpha.37) (2026-07-27)

## @lunora/ai [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.35...%40lunora%2Fai%401.0.0-alpha.36) (2026-07-27)

## @lunora/ai [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.34...%40lunora%2Fai%401.0.0-alpha.35) (2026-07-27)

## @lunora/ai [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.33...%40lunora%2Fai%401.0.0-alpha.34) (2026-07-27)

## @lunora/ai [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.32...%40lunora%2Fai%401.0.0-alpha.33) (2026-07-27)

## @lunora/ai [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.31...%40lunora%2Fai%401.0.0-alpha.32) (2026-07-26)

## @lunora/ai [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.30...%40lunora%2Fai%401.0.0-alpha.31) (2026-07-26)

## @lunora/ai [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.29...%40lunora%2Fai%401.0.0-alpha.30) (2026-07-26)

## @lunora/ai [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.28...%40lunora%2Fai%401.0.0-alpha.29) (2026-07-26)

## @lunora/ai [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.27...%40lunora%2Fai%401.0.0-alpha.28) (2026-07-26)

## @lunora/ai [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.26...%40lunora%2Fai%401.0.0-alpha.27) (2026-07-26)

## @lunora/ai [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.25...%40lunora%2Fai%401.0.0-alpha.26) (2026-07-25)

## @lunora/ai [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.24...%40lunora%2Fai%401.0.0-alpha.25) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/ai [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.23...%40lunora%2Fai%401.0.0-alpha.24) (2026-07-23)

## @lunora/ai [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.22...%40lunora%2Fai%401.0.0-alpha.23) (2026-07-22)

## @lunora/ai [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.21...%40lunora%2Fai%401.0.0-alpha.22) (2026-07-22)

## @lunora/ai [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.20...%40lunora%2Fai%401.0.0-alpha.21) (2026-07-22)

## @lunora/ai [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.19...%40lunora%2Fai%401.0.0-alpha.20) (2026-07-22)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.7

## @lunora/ai [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.18...%40lunora%2Fai%401.0.0-alpha.19) (2026-07-22)

## @lunora/ai [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.17...%40lunora%2Fai%401.0.0-alpha.18) (2026-07-22)

## @lunora/ai [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.16...%40lunora%2Fai%401.0.0-alpha.17) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/ai [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.15...%40lunora%2Fai%401.0.0-alpha.16) (2026-07-19)

## @lunora/ai [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.14...%40lunora%2Fai%401.0.0-alpha.15) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/ai [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.13...%40lunora%2Fai%401.0.0-alpha.14) (2026-07-13)

## @lunora/ai [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.12...%40lunora%2Fai%401.0.0-alpha.13) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/ai [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.11...%40lunora%2Fai%401.0.0-alpha.12) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/ai [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.10...%40lunora%2Fai%401.0.0-alpha.11) (2026-07-08)

## @lunora/ai [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.9...%40lunora%2Fai%401.0.0-alpha.10) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/ai [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.8...%40lunora%2Fai%401.0.0-alpha.9) (2026-07-04)

## @lunora/ai [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.7...%40lunora%2Fai%401.0.0-alpha.8) (2026-07-04)

## @lunora/ai [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.6...%40lunora%2Fai%401.0.0-alpha.7) (2026-07-04)

## @lunora/ai [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.5...%40lunora%2Fai%401.0.0-alpha.6) (2026-07-04)

## @lunora/ai [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.4...%40lunora%2Fai%401.0.0-alpha.5) (2026-07-04)

## @lunora/ai [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.3...%40lunora%2Fai%401.0.0-alpha.4) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/ai [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fai%401.0.0-alpha.2...%40lunora%2Fai%401.0.0-alpha.3) (2026-06-29)

## @lunora/ai [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/ai@1.0.0-alpha.1...@lunora/ai@1.0.0-alpha.2) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))
* **release:** @lunora/ai@1.0.0-alpha.1 [skip ci]\n\n## @lunora/ai 1.0.0-alpha.1 (2026-06-25) ([012c2dc](https://github.com/anolilab/lunora/commit/012c2dc8271e64cf3db469fdfaf5dca5c44b055a))
* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))

## @lunora/ai 1.0.0-alpha.1 (2026-06-25)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))
* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))
* **release:** @lunora/ai@1.0.0-alpha.1 [skip ci]\n\n## @lunora/ai 1.0.0-alpha.1 (2026-06-21) ([5b52920](https://github.com/anolilab/lunora/commit/5b52920bacc86045bb50e1e9363574fb1d569b1f))

## @lunora/ai 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))
