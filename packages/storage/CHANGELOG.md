## @lunora/storage [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/storage@1.0.0-alpha.34...@lunora/storage@1.0.0-alpha.35) (2026-08-24)

### ⚠ BREAKING CHANGES

* **storage:** Storage.getPresignedUrl / buildPresignedUrl now
throw a VALIDATION_ERROR (400) at mint time for an explicit
out-of-range expiresInSeconds instead of silently clamping it to a
different lifetime. Per input class, old behaviour -> new behaviour:

  - NaN / Infinity: minted a 900s URL   -> throws
  - 0 or negative:  minted a 1s URL     -> throws
  - 0 < value < 1:  minted a 1s URL     -> throws (floors to 0)
  - value > 604800: minted a 604800s URL -> throws
  - absent:         900s (unchanged)
  - 1 .. 604800:    honoured (unchanged, ceiling still inclusive)

A handler forwarding a user- or config-supplied TTL that previously
served a clamped URL now fails the mutation/action instead. Callers
that relied on the clamp must clamp before calling, or catch
VALIDATION_ERROR. Already-minted URLs are unaffected — verification
is unchanged.


Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

Co-authored-by: Claude Fable 5 <noreply@anthropic.com>

### Bug Fixes

* **storage:** validate signed-url ttl and base path uniformly ([#449](https://github.com/anolilab/lunora/issues/449)) ([cd830bb](https://github.com/anolilab/lunora/commit/cd830bb17b9a0e0932dff71fcef967a2e2aa97cc))

## @lunora/storage [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/storage@1.0.0-alpha.33...@lunora/storage@1.0.0-alpha.34) (2026-08-23)

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.15

## @lunora/storage [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.32...%40lunora%2Fstorage%401.0.0-alpha.33) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.14

## @lunora/storage [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.31...%40lunora%2Fstorage%401.0.0-alpha.32) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.13

## @lunora/storage [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.30...%40lunora%2Fstorage%401.0.0-alpha.31) (2026-08-15)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.12

## @lunora/storage [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.29...%40lunora%2Fstorage%401.0.0-alpha.30) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11

## @lunora/storage [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.28...%40lunora%2Fstorage%401.0.0-alpha.29) (2026-08-12)

## @lunora/storage [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.27...%40lunora%2Fstorage%401.0.0-alpha.28) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10

## @lunora/storage [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.26...%40lunora%2Fstorage%401.0.0-alpha.27) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/storage [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.25...%40lunora%2Fstorage%401.0.0-alpha.26) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19
* **@lunora/platform:** upgraded to 1.0.0-alpha.9

## @lunora/storage [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.24...%40lunora%2Fstorage%401.0.0-alpha.25) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/storage [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.23...%40lunora%2Fstorage%401.0.0-alpha.24) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8

## @lunora/storage [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.22...%40lunora%2Fstorage%401.0.0-alpha.23) (2026-08-07)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.7

## @lunora/storage [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.21...%40lunora%2Fstorage%401.0.0-alpha.22) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/storage [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.20...%40lunora%2Fstorage%401.0.0-alpha.21) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/storage [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.19...%40lunora%2Fstorage%401.0.0-alpha.20) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6

## @lunora/storage [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.18...%40lunora%2Fstorage%401.0.0-alpha.19) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5

## @lunora/storage [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.17...%40lunora%2Fstorage%401.0.0-alpha.18) (2026-08-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.4

## @lunora/storage [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.16...%40lunora%2Fstorage%401.0.0-alpha.17) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/platform:** upgraded to 1.0.0-alpha.3

## @lunora/storage [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.15...%40lunora%2Fstorage%401.0.0-alpha.16) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11
* **@lunora/platform:** upgraded to 1.0.0-alpha.2

## @lunora/storage [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.14...%40lunora%2Fstorage%401.0.0-alpha.15) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/storage [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.13...%40lunora%2Fstorage%401.0.0-alpha.14) (2026-07-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.1

## @lunora/storage [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.12...%40lunora%2Fstorage%401.0.0-alpha.13) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/storage [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.11...%40lunora%2Fstorage%401.0.0-alpha.12) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/storage [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.10...%40lunora%2Fstorage%401.0.0-alpha.11) (2026-07-23)

## @lunora/storage [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.9...%40lunora%2Fstorage%401.0.0-alpha.10) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/storage [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.8...%40lunora%2Fstorage%401.0.0-alpha.9) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/storage [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.7...%40lunora%2Fstorage%401.0.0-alpha.8) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/storage [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.6...%40lunora%2Fstorage%401.0.0-alpha.7) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/storage [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.5...%40lunora%2Fstorage%401.0.0-alpha.6) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/storage [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.4...%40lunora%2Fstorage%401.0.0-alpha.5) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/storage [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fstorage%401.0.0-alpha.3...%40lunora%2Fstorage%401.0.0-alpha.4) (2026-07-02)

## @lunora/storage [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/storage@1.0.0-alpha.2...@lunora/storage@1.0.0-alpha.3) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))
* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))

## @lunora/storage [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/storage@1.0.0-alpha.1...@lunora/storage@1.0.0-alpha.2) (2026-06-22)

### Bug Fixes

* **bench:** seed remaining CodSpeed benches in beforeAll ([0fde66b](https://github.com/anolilab/lunora/commit/0fde66b509a99d09d90c6141e01c12c55ac8f5de))

## @lunora/storage 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))
