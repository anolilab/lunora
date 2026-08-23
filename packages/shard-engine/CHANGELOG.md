## @lunora/shard-engine [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/shard-engine@1.0.0-alpha.32...@lunora/shard-engine@1.0.0-alpha.33) (2026-08-21)

### ⚠ BREAKING CHANGES

* **search-core:** an exact-boundary page request
(offset + numItems === 1024) now throws BAD_REQUEST instead of
returning a final page. A ≤1024-match corpus paged right up to the cap
previously got a correct last page; it now gets the same refusal every
other cap-reaching request already got, because without the probe row
the page cannot answer hasMore truthfully. The test that asserted the
boundary page succeeded encoded the bug and now expects the throw;
consumer test regexes tracking the error message were updated to match.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* chore(search-core): align manifest with sibling conventions

Pin @lunora/errors to 1.0.0-alpha.22 like every sibling in the
platform/runtime cluster (runtime, do, shard-engine, d1, sql-store),
so the pin moves with the release tooling instead of floating on
workspace:*. Add the fallow:audit / fallow:dead-code / fallow:health
scripts and the fallow devDependency so the package joins the repo's
dead-code and health gates, and add @vitest/coverage-v8 so the
already-declared test:coverage script can actually run.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(search-core): reject non-finite page sizes

Math.floor(NaN) is NaN and NaN >= MAX_SEARCH_SCAN is false, so a NaN
numItems slid past both the normalization and the cap guard and came
back as a bogus empty terminal page instead of an error. planSearchPage
now refuses any non-finite numItems with the same BAD_REQUEST family
before normalizing; the cap boundary behavior is unchanged for finite
input. Adds a NaN regression test beside the boundary cases.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(search-core): keep the errors dep on workspace:*

The exact-version pins on intra-repo dependencies work because
multi-semantic-release rewrites them on every release — as
pnpm-workspace.yaml documents. @lunora/search-core is private with no
.releaserc.json, so nothing rewrites its manifest: an exact pin
resolves locally only while packages/errors happens to sit at that
version, and the next @lunora/errors release would put the local
package outside the range, make preferWorkspacePackages inert, and
resolve the registry tarball instead — which then gets inlined into
@lunora/server, @lunora/do and @lunora/sql-store, all of which bundle
this package. The lockfile records `specifier: workspace:*` either way,
so CI would not catch the flip. Private packages stay on workspace:*,
as @lunora/auth-ui already does.

Also make the scan-cap refusal actionable: the error now names the
largest numItems that would still leave room for the probe row, since a
power-of-two page walk lands its final page exactly on the cap and the
caller otherwise has to guess. Two comments describing the old
report-isDone-at-the-cap behaviour are corrected to match.
* **search-core:** a search page ending exactly on the 1024-document scan
cap now throws BAD_REQUEST instead of returning a final page. This hits
the last page of any walk whose sizes divide the cap — numItems 512 at
offset 512, 256 at 768, 128 at 896, 64 at 960, 32 at 992, and so on.
Such a page cannot fetch the probe row that distinguishes "exactly this
many matches" from "far more", so its isDone was a guess reported as
fact; the error now names the page size to retry with.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **search-core:** refuse the capped boundary page ([#464](https://github.com/anolilab/lunora/issues/464)) ([86bfa63](https://github.com/anolilab/lunora/commit/86bfa631be8d7eabe4399b138b44dc85bf1026d6))

## @lunora/shard-engine [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.31...%40lunora%2Fshard-engine%401.0.0-alpha.32) (2026-08-19)

## @lunora/shard-engine [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.30...%40lunora%2Fshard-engine%401.0.0-alpha.31) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.14
* **@lunora/bindings:** upgraded to 1.0.0-alpha.32

## @lunora/shard-engine [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.29...%40lunora%2Fshard-engine%401.0.0-alpha.30) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.13
* **@lunora/bindings:** upgraded to 1.0.0-alpha.31

## @lunora/shard-engine [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.28...%40lunora%2Fshard-engine%401.0.0-alpha.29) (2026-08-15)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.12
* **@lunora/bindings:** upgraded to 1.0.0-alpha.30

## @lunora/shard-engine [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.27...%40lunora%2Fshard-engine%401.0.0-alpha.28) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11
* **@lunora/bindings:** upgraded to 1.0.0-alpha.29

## @lunora/shard-engine [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.26...%40lunora%2Fshard-engine%401.0.0-alpha.27) (2026-08-11)

## @lunora/shard-engine [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.25...%40lunora%2Fshard-engine%401.0.0-alpha.26) (2026-08-11)

## @lunora/shard-engine [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.24...%40lunora%2Fshard-engine%401.0.0-alpha.25) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10
* **@lunora/bindings:** upgraded to 1.0.0-alpha.28

## @lunora/shard-engine [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.23...%40lunora%2Fshard-engine%401.0.0-alpha.24) (2026-08-10)

## @lunora/shard-engine [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.22...%40lunora%2Fshard-engine%401.0.0-alpha.23) (2026-08-10)

## @lunora/shard-engine [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.21...%40lunora%2Fshard-engine%401.0.0-alpha.22) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20
* **@lunora/bindings:** upgraded to 1.0.0-alpha.27

## @lunora/shard-engine [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.20...%40lunora%2Fshard-engine%401.0.0-alpha.21) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19
* **@lunora/platform:** upgraded to 1.0.0-alpha.9
* **@lunora/bindings:** upgraded to 1.0.0-alpha.26

## @lunora/shard-engine [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.19...%40lunora%2Fshard-engine%401.0.0-alpha.20) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/bindings:** upgraded to 1.0.0-alpha.25

## @lunora/shard-engine [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.18...%40lunora%2Fshard-engine%401.0.0-alpha.19) (2026-08-09)

## @lunora/shard-engine [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.17...%40lunora%2Fshard-engine%401.0.0-alpha.18) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8
* **@lunora/bindings:** upgraded to 1.0.0-alpha.24

## @lunora/shard-engine [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.16...%40lunora%2Fshard-engine%401.0.0-alpha.17) (2026-08-08)

## @lunora/shard-engine [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.15...%40lunora%2Fshard-engine%401.0.0-alpha.16) (2026-08-07)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.7
* **@lunora/bindings:** upgraded to 1.0.0-alpha.23

## @lunora/shard-engine [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.14...%40lunora%2Fshard-engine%401.0.0-alpha.15) (2026-08-07)

## @lunora/shard-engine [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.13...%40lunora%2Fshard-engine%401.0.0-alpha.14) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/bindings:** upgraded to 1.0.0-alpha.22

## @lunora/shard-engine [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.12...%40lunora%2Fshard-engine%401.0.0-alpha.13) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/bindings:** upgraded to 1.0.0-alpha.21

## @lunora/shard-engine [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.11...%40lunora%2Fshard-engine%401.0.0-alpha.12) (2026-08-04)

## @lunora/shard-engine [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.10...%40lunora%2Fshard-engine%401.0.0-alpha.11) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6
* **@lunora/bindings:** upgraded to 1.0.0-alpha.20

## @lunora/shard-engine [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.9...%40lunora%2Fshard-engine%401.0.0-alpha.10) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5
* **@lunora/bindings:** upgraded to 1.0.0-alpha.19

## @lunora/shard-engine [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.8...%40lunora%2Fshard-engine%401.0.0-alpha.9) (2026-08-04)

## @lunora/shard-engine [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.7...%40lunora%2Fshard-engine%401.0.0-alpha.8) (2026-08-03)

## @lunora/shard-engine [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.6...%40lunora%2Fshard-engine%401.0.0-alpha.7) (2026-08-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.4
* **@lunora/bindings:** upgraded to 1.0.0-alpha.18

## @lunora/shard-engine [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.5...%40lunora%2Fshard-engine%401.0.0-alpha.6) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/platform:** upgraded to 1.0.0-alpha.3
* **@lunora/bindings:** upgraded to 1.0.0-alpha.17

## @lunora/shard-engine [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.4...%40lunora%2Fshard-engine%401.0.0-alpha.5) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11
* **@lunora/platform:** upgraded to 1.0.0-alpha.2
* **@lunora/bindings:** upgraded to 1.0.0-alpha.16

## @lunora/shard-engine [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.3...%40lunora%2Fshard-engine%401.0.0-alpha.4) (2026-07-31)

## @lunora/shard-engine [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.2...%40lunora%2Fshard-engine%401.0.0-alpha.3) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/bindings:** upgraded to 1.0.0-alpha.15

## @lunora/shard-engine [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fshard-engine%401.0.0-alpha.1...%40lunora%2Fshard-engine%401.0.0-alpha.2) (2026-07-31)

## @lunora/shard-engine 1.0.0-alpha.1 (2026-07-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.1
* **@lunora/bindings:** upgraded to 1.0.0-alpha.14
