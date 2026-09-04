## @lunora/platform-cloudflare [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.31...@lunora/platform-cloudflare@1.0.0-alpha.32) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/platform:** upgraded to 1.0.0-alpha.26

## @lunora/platform-cloudflare [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.30...@lunora/platform-cloudflare@1.0.0-alpha.31) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/platform:** upgraded to 1.0.0-alpha.25

## @lunora/platform-cloudflare [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.29...@lunora/platform-cloudflare@1.0.0-alpha.30) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/platform:** upgraded to 1.0.0-alpha.24

## @lunora/platform-cloudflare [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.28...@lunora/platform-cloudflare@1.0.0-alpha.29) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/platform-cloudflare [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.27...@lunora/platform-cloudflare@1.0.0-alpha.28) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/platform:** upgraded to 1.0.0-alpha.23

## @lunora/platform-cloudflare [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.26...@lunora/platform-cloudflare@1.0.0-alpha.27) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.22

## @lunora/platform-cloudflare [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.25...@lunora/platform-cloudflare@1.0.0-alpha.26) (2026-08-29)

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
* **@lunora/platform:** upgraded to 1.0.0-alpha.21

## @lunora/platform-cloudflare [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.24...@lunora/platform-cloudflare@1.0.0-alpha.25) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/platform:** upgraded to 1.0.0-alpha.20

## @lunora/platform-cloudflare [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.23...@lunora/platform-cloudflare@1.0.0-alpha.24) (2026-08-27)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.19

## @lunora/platform-cloudflare [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.22...@lunora/platform-cloudflare@1.0.0-alpha.23) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/platform:** upgraded to 1.0.0-alpha.18

## @lunora/platform-cloudflare [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.21...@lunora/platform-cloudflare@1.0.0-alpha.22) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/platform-cloudflare [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.20...@lunora/platform-cloudflare@1.0.0-alpha.21) (2026-08-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.17

## @lunora/platform-cloudflare [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.19...@lunora/platform-cloudflare@1.0.0-alpha.20) (2026-08-23)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.15

## @lunora/platform-cloudflare [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.18...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.19) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.14

## @lunora/platform-cloudflare [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.17...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.18) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.13

## @lunora/platform-cloudflare [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.16...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.17) (2026-08-15)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.12

## @lunora/platform-cloudflare [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.15...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.16) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11

## @lunora/platform-cloudflare [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.14...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.15) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10

## @lunora/platform-cloudflare [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.13...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.14) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/platform-cloudflare [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.12...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.13) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19
* **@lunora/platform:** upgraded to 1.0.0-alpha.9

## @lunora/platform-cloudflare [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.11...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.12) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/platform-cloudflare [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.10...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.11) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8

## @lunora/platform-cloudflare [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.9...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.10) (2026-08-07)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.7

## @lunora/platform-cloudflare [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.8...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.9) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/platform-cloudflare [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.7...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.8) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/platform-cloudflare [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.6...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.7) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6

## @lunora/platform-cloudflare [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.5...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.6) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5

## @lunora/platform-cloudflare [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.4...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.5) (2026-08-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.4

## @lunora/platform-cloudflare [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.3...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.4) (2026-08-02)

## @lunora/platform-cloudflare [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.2...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.3) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/platform:** upgraded to 1.0.0-alpha.3

## @lunora/platform-cloudflare [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.1...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.2) (2026-08-01)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.2

## @lunora/platform-cloudflare 1.0.0-alpha.1 (2026-07-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.1
