## @lunora/sql-store [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.84...@lunora/sql-store@1.0.0-alpha.85) (2026-08-21)

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


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.33
* **@lunora/do:** upgraded to 1.0.0-alpha.92

## @lunora/sql-store [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.83...%40lunora%2Fsql-store%401.0.0-alpha.84) (2026-08-19)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.91

## @lunora/sql-store [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.82...%40lunora%2Fsql-store%401.0.0-alpha.83) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.90

## @lunora/sql-store [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.81...%40lunora%2Fsql-store%401.0.0-alpha.82) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30
* **@lunora/do:** upgraded to 1.0.0-alpha.89

## @lunora/sql-store [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.80...%40lunora%2Fsql-store%401.0.0-alpha.81) (2026-08-15)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29
* **@lunora/do:** upgraded to 1.0.0-alpha.88

## @lunora/sql-store [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.79...%40lunora%2Fsql-store%401.0.0-alpha.80) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28
* **@lunora/do:** upgraded to 1.0.0-alpha.86

## @lunora/sql-store [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.78...%40lunora%2Fsql-store%401.0.0-alpha.79) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27
* **@lunora/do:** upgraded to 1.0.0-alpha.84

## @lunora/sql-store [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.77...%40lunora%2Fsql-store%401.0.0-alpha.78) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26
* **@lunora/do:** upgraded to 1.0.0-alpha.83

## @lunora/sql-store [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.76...%40lunora%2Fsql-store%401.0.0-alpha.77) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25
* **@lunora/do:** upgraded to 1.0.0-alpha.82

## @lunora/sql-store [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.75...%40lunora%2Fsql-store%401.0.0-alpha.76) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.81

## @lunora/sql-store [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.74...%40lunora%2Fsql-store%401.0.0-alpha.75) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.80

## @lunora/sql-store [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.73...%40lunora%2Fsql-store%401.0.0-alpha.74) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20
* **@lunora/do:** upgraded to 1.0.0-alpha.79

## @lunora/sql-store [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.72...%40lunora%2Fsql-store%401.0.0-alpha.73) (2026-08-09)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19
* **@lunora/do:** upgraded to 1.0.0-alpha.77

## @lunora/sql-store [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.71...%40lunora%2Fsql-store%401.0.0-alpha.72) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18
* **@lunora/do:** upgraded to 1.0.0-alpha.76

## @lunora/sql-store [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.70...%40lunora%2Fsql-store%401.0.0-alpha.71) (2026-08-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17
* **@lunora/do:** upgraded to 1.0.0-alpha.75

## @lunora/sql-store [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.69...%40lunora%2Fsql-store%401.0.0-alpha.70) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16
* **@lunora/do:** upgraded to 1.0.0-alpha.73

## @lunora/sql-store [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.68...%40lunora%2Fsql-store%401.0.0-alpha.69) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.72

## @lunora/sql-store [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.67...%40lunora%2Fsql-store%401.0.0-alpha.68) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.14
* **@lunora/do:** upgraded to 1.0.0-alpha.71

## @lunora/sql-store [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.66...%40lunora%2Fsql-store%401.0.0-alpha.67) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.13
* **@lunora/do:** upgraded to 1.0.0-alpha.70

## @lunora/sql-store [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.65...%40lunora%2Fsql-store%401.0.0-alpha.66) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.12
* **@lunora/do:** upgraded to 1.0.0-alpha.69

## @lunora/sql-store [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.64...%40lunora%2Fsql-store%401.0.0-alpha.65) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.68

## @lunora/sql-store [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.63...%40lunora%2Fsql-store%401.0.0-alpha.64) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.67

## @lunora/sql-store [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.62...%40lunora%2Fsql-store%401.0.0-alpha.63) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.9
* **@lunora/do:** upgraded to 1.0.0-alpha.66

## @lunora/sql-store [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.61...%40lunora%2Fsql-store%401.0.0-alpha.62) (2026-08-03)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.8
* **@lunora/do:** upgraded to 1.0.0-alpha.65

## @lunora/sql-store [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.60...%40lunora%2Fsql-store%401.0.0-alpha.61) (2026-08-03)

## @lunora/sql-store [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.59...%40lunora%2Fsql-store%401.0.0-alpha.60) (2026-08-02)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.7
* **@lunora/do:** upgraded to 1.0.0-alpha.64

## @lunora/sql-store [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.58...%40lunora%2Fsql-store%401.0.0-alpha.59) (2026-08-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.62

## @lunora/sql-store [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.57...%40lunora%2Fsql-store%401.0.0-alpha.58) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.61

## @lunora/sql-store [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.56...%40lunora%2Fsql-store%401.0.0-alpha.57) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.60

## @lunora/sql-store [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.55...%40lunora%2Fsql-store%401.0.0-alpha.56) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.59

## @lunora/sql-store [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.54...%40lunora%2Fsql-store%401.0.0-alpha.55) (2026-07-30)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.1
* **@lunora/do:** upgraded to 1.0.0-alpha.58

## @lunora/sql-store [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.53...%40lunora%2Fsql-store%401.0.0-alpha.54) (2026-07-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.57

## @lunora/sql-store [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.52...%40lunora%2Fsql-store%401.0.0-alpha.53) (2026-07-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.56

## @lunora/sql-store [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.51...%40lunora%2Fsql-store%401.0.0-alpha.52) (2026-07-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.55

## @lunora/sql-store [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.50...%40lunora%2Fsql-store%401.0.0-alpha.51) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.54

## @lunora/sql-store [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.49...%40lunora%2Fsql-store%401.0.0-alpha.50) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.53
* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/sql-store [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.48...%40lunora%2Fsql-store%401.0.0-alpha.49) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.52

## @lunora/sql-store [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.47...%40lunora%2Fsql-store%401.0.0-alpha.48) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.51

## @lunora/sql-store [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.46...%40lunora%2Fsql-store%401.0.0-alpha.47) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.50

## @lunora/sql-store [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.45...%40lunora%2Fsql-store%401.0.0-alpha.46) (2026-07-26)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.49

## @lunora/sql-store [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.44...%40lunora%2Fsql-store%401.0.0-alpha.45) (2026-07-26)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.48

## @lunora/sql-store [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.43...%40lunora%2Fsql-store%401.0.0-alpha.44) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.47

## @lunora/sql-store [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.42...%40lunora%2Fsql-store%401.0.0-alpha.43) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.46

## @lunora/sql-store [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.41...%40lunora%2Fsql-store%401.0.0-alpha.42) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.45

## @lunora/sql-store [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.40...%40lunora%2Fsql-store%401.0.0-alpha.41) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/sql-store [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.39...%40lunora%2Fsql-store%401.0.0-alpha.40) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.43

## @lunora/sql-store [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.38...%40lunora%2Fsql-store%401.0.0-alpha.39) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.42

## @lunora/sql-store [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.37...%40lunora%2Fsql-store%401.0.0-alpha.38) (2026-07-23)

## @lunora/sql-store [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.36...%40lunora%2Fsql-store%401.0.0-alpha.37) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.37

## @lunora/sql-store [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.35...%40lunora%2Fsql-store%401.0.0-alpha.36) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.36

## @lunora/sql-store [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.34...%40lunora%2Fsql-store%401.0.0-alpha.35) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.35

## @lunora/sql-store [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.33...%40lunora%2Fsql-store%401.0.0-alpha.34) (2026-07-20)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/sql-store [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.32...%40lunora%2Fsql-store%401.0.0-alpha.33) (2026-07-19)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.33

## @lunora/sql-store [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.31...%40lunora%2Fsql-store%401.0.0-alpha.32) (2026-07-18)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.32

## @lunora/sql-store [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.30...%40lunora%2Fsql-store%401.0.0-alpha.31) (2026-07-17)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.31
* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/sql-store [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.29...%40lunora%2Fsql-store%401.0.0-alpha.30) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.30

## @lunora/sql-store [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.28...%40lunora%2Fsql-store%401.0.0-alpha.29) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.29

## @lunora/sql-store [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.27...%40lunora%2Fsql-store%401.0.0-alpha.28) (2026-07-12)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.28

## @lunora/sql-store [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.26...%40lunora%2Fsql-store%401.0.0-alpha.27) (2026-07-11)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.27
* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/sql-store [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.25...%40lunora%2Fsql-store%401.0.0-alpha.26) (2026-07-08)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/sql-store [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.24...%40lunora%2Fsql-store%401.0.0-alpha.25) (2026-07-07)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.25

## @lunora/sql-store [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.23...%40lunora%2Fsql-store%401.0.0-alpha.24) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.24
* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/sql-store [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.22...%40lunora%2Fsql-store%401.0.0-alpha.23) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.23

## @lunora/sql-store [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.21...%40lunora%2Fsql-store%401.0.0-alpha.22) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.22
* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/sql-store [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.20...%40lunora%2Fsql-store%401.0.0-alpha.21) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.21

## @lunora/sql-store [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.19...%40lunora%2Fsql-store%401.0.0-alpha.20) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.20

## @lunora/sql-store [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.18...%40lunora%2Fsql-store%401.0.0-alpha.19) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.19

## @lunora/sql-store [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.17...%40lunora%2Fsql-store%401.0.0-alpha.18) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.18

## @lunora/sql-store [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.16...%40lunora%2Fsql-store%401.0.0-alpha.17) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.17

## @lunora/sql-store [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.15...%40lunora%2Fsql-store%401.0.0-alpha.16) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.16

## @lunora/sql-store [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.14...%40lunora%2Fsql-store%401.0.0-alpha.15) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.15

## @lunora/sql-store [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.13...%40lunora%2Fsql-store%401.0.0-alpha.14) (2026-07-01)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.14

## @lunora/sql-store [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.12...%40lunora%2Fsql-store%401.0.0-alpha.13) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.13

## @lunora/sql-store [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.11...%40lunora%2Fsql-store%401.0.0-alpha.12) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.12

## @lunora/sql-store [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.10...%40lunora%2Fsql-store%401.0.0-alpha.11) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.11

## @lunora/sql-store [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.9...%40lunora%2Fsql-store%401.0.0-alpha.10) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.10

## @lunora/sql-store [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.8...%40lunora%2Fsql-store%401.0.0-alpha.9) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.9

## @lunora/sql-store [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fsql-store%401.0.0-alpha.7...%40lunora%2Fsql-store%401.0.0-alpha.8) (2026-06-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.8

## @lunora/sql-store [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.6...@lunora/sql-store@1.0.0-alpha.7) (2026-06-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.7

## @lunora/sql-store [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.5...@lunora/sql-store@1.0.0-alpha.6) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.6

## @lunora/sql-store [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.4...@lunora/sql-store@1.0.0-alpha.5) (2026-06-27)

### Features

* extending db  ([#32](https://github.com/anolilab/lunora/issues/32)) ([6b77a16](https://github.com/anolilab/lunora/commit/6b77a16996e6aa59c19c801c3ea18004deccd6dc))

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.5

## @lunora/sql-store [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.3...@lunora/sql-store@1.0.0-alpha.4) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.4

## @lunora/sql-store [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.2...@lunora/sql-store@1.0.0-alpha.3) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.3

## @lunora/sql-store [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/sql-store@1.0.0-alpha.1...@lunora/sql-store@1.0.0-alpha.2) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.2

## @lunora/sql-store 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.1
