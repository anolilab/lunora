## @lunora/hyperdrive [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.87...@lunora/hyperdrive@1.0.0-alpha.88) (2026-08-25)

### ⚠ BREAKING CHANGES

* authorizeShard takes a single ShardCaller object
({ identity, shardKey }) instead of two positional arguments. Both
previously-natural shapes now fail to compile, which is deliberate -- an
optional argument would have documented the trap while leaving every
un-updated gate silently breaking cron dispatch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(examples): update authorizeShard call sites

team-chat's gate no longer type-checks against the ShardCaller object.
The remaining changes are code samples and comments that would otherwise
teach the positional shape that no longer exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(studio): mask the global data browser

The .global() browser had no mask preview at all: a table carrying a
.use(mask(...)) policy rendered in cleartext, with no toggle and no
header chips, while the sharded browser honoured the same policy on every
surface.

The policy metadata was reachable all along -- maskPolicies is
schema-wide rather than shard-scoped, and a .global() table's declared
field names join against it identically.

Covers the grid cells, header chips, the toggle, the facet sidebar, and
the drill-down filter chips. That last one is the non-obvious surface:
facet a covered column with the preview off, click a value, toggle back
on, and the chip still held the secret.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* build(api): pin re-exports to one printed signature

A subpath re-exporting another subpath's declaration printed the whole
signature again, so auth-ui's six framework ports each re-printed core's
271 declarations and the snapshot reached 39,299 lines -- a real surface
change was unreviewable inside it.

A declaration now prints in full once, under the subpath whose entry
directory contains it, and every other subpath records a pin naming where
the signature is tracked. Keyed by declaration identity rather than name,
so two subpaths exporting the same name from different files stay two
sections. The same rule the script already applied across packages, now
applied within one.

Coverage is unchanged: every export is still recorded per subpath, so
losing a re-export still fails for that port by name. auth-ui drops to
16,691 lines.

Also fixes the drift reporter, which keyed sections by bare export name:
in a multi-subpath snapshot the last section overwrote the others, so a
real signature change could summarise as no change. The gate always
compared whole files, so this affected the message, not the verdict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* test(runtime): format and annotate the fixture bearer

The scheduler-dispatch test's authorization header trips the secret
scanner's kingfisher.http.2 rule; it is a fixture matching the stub admin
token asserted a few lines below, so it carries an inline allow naming
what it is rather than a baseline entry.

Both files also went in unformatted -- they predate the pre-commit hooks
being wired up, which is what would otherwise have caught this.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(examples): regenerate every stale _generated tree

All 13 examples carried generated output predating a codegen change --
the lifecycle field on RegisteredLunoraFunction, runShardInit/runReactor
dispatch, the inTransaction predicate and the untracked ctx.runQuery
path. 26 files, and nothing had ever noticed.

Output is deterministic (two consecutive sweeps produced byte-identical
diffs) and every regenerated tree typechecks clean.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* build: gate lunora codegen output

check-generated-files.mjs proved three generators reproduce their
committed output and did not cover lunora codegen -- the repo's primary
generator -- so every _generated tree under examples/ drifted unwatched.
All 13 were stale.

The generator list now discovers an entry per example with a codegen
script, so a new example is covered as soon as it has one. Templates are
not gated because they commit no generated output at all: every one of
the 13 lists lunora/_generated in its .gitignore, so there is nothing to
hold to a generator.

The job gains the build the sweep needs, matching what the api-surface
job already pays.

The gate was also not triggering: the generated_files filter matched
manifests and generate-*.js, so a change to packages/codegen/src/emit.ts
-- the exact thing that caused this drift -- matched nothing and the job
never ran. The filter now covers packages/codegen, examples, and the
script itself.

Known limitation, unchanged and now documented: the script compares git
status codes rather than content, so drift inside a file that was already
dirty before the sweep is invisible. Harmless in CI, which starts clean;
it means a local run mid-change cannot detect drift in files you have
already modified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* docs(studio): record why filter rows stay unmasked

The question of whether the sharded browser's filter bar should mask has
now been asked twice and answered from memory both times. The answer is
no, and the reason is an invariant rather than a preference: a filter
clause rendered in that bar is always simultaneously rendered verbatim in
the address bar, because useDataBrowser mirrors toFilterClauses through
onViewChange into ?filters=. Masking a row would blank a value legible
three inches above it while making the input uneditable.

That is what separates it from the .global() drill-down chips, which are
masked: those are read-only, fed only by a facet click, and held in local
state that never reaches the URL. The two data-derived paths into a
sharded filter are already closed at the source -- a facet click cannot
reach a covered column while the preview is on, and FK traversal seeds
search rather than filters.

Two tests now pin the halves the rationale rests on, so it fails loudly
rather than rotting into a stale comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(sdk): chain the dart generated-check analysis

A `\` continuation followed by a comment terminates the command, so the
prose spliced mid-chain detached everything after it: the analysis ran
unchained from the `cp` that stages the smoke, in a script that runs
without `set -e`.

That is the hole the chain was added to close, still open on the one leg
this script exists to gate. The comment moves above the case label, with a
note saying why it cannot live inside the chain. No other shell file in
the repo has the pattern.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(shared): one fnv1a, not four

`shared/fnv1a.ts` argues in its own header that a shared definition is
what enforces non-drift. Four definitions existed, one of them
`shared/content-digest.ts` in the same directory, and
`notify`'s carried a comment requiring it to reproduce the algorithm
byte-for-byte or delete the wrong subscription row -- a hand-maintained
contract against a function it did not import.

Equivalence was proven before consolidating, across 4,016 inputs
including astral characters and lone surrogates, because a digest change
here picks which row gets deleted. The offset is now a parameter so
`contentDigest` can run its second pass through the same function.

`@lunora/client`'s `hashToken` is deliberately NOT folded in: it uses
`charCodeAt` and combines FNV with djb2, so it is a different digest.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(studio): share the toolbar button classes

Five copies across the data feature, several commenting themselves
"shared", two already differing in class order. A theme tweak had to land
in five files.

Two exports rather than one, because three of the five carried
`aria-pressed:` styling and two did not. The pressed classes are inert
without the attribute so a single constant would render identically --
but which buttons are toggles is the thing a reader needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* refactor(codegen): let tsc classify the capabilities

The gate map was `Partial`, with the unmapped keys repeated in a second
list and a test asserting the two partitioned `CapabilityKey`. The map is
now total and credential-based is spelled `null`, so an unclassified
capability fails `tsc` where it is written instead of a test at CI time
-- verified by deleting an entry and reading TS2741.

The surviving test covers what the type cannot: `CAPABILITIES` is a
runtime array, so a row added there without widening `CapabilityKey`
would still leave a real capability out of the map. That is the fail-open
`notify` had.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(runtime): throw the typed error on a denied voice shard

The voice upgrade returned a bare 403 `Response` where every other shard
path throws `FORBIDDEN_SHARD`, so a denied caller there got a status with
no error code to branch on.

Deliberately NOT collapsed into `assertShardAuthorized`, despite reading
like a copy of it: that helper default-denies only a NON-default shard,
and there is no default voice shard, so routing through it would admit a
caller who names the default shard as their threadKey. The difference now
says so in a comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* fix(studio): mask the foreign-key hover preview

Hovering an FK cell fetched the TARGET row and rendered its first eight
fields verbatim. The grid's mask view covers the browsed table and says
nothing about another table's columns, so a target's covered columns
showed in the clear in a tooltip beside a grid masking exactly those.

The policies are deployment-wide, so the target resolves without another
fetch. The test uses a column the NAME HEURISTIC cannot catch: the first
version used `apiKey`, which the heuristic masks whichever table is
looked up, so it passed against the unfixed code and proved nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* docs: fix an authorizeShard that 403s the default shard

`assertShardAuthorized` runs the callback for EVERY shard the caller
names once one is configured -- the non-default test is in the `else`,
reached only when there is no callback. So `identity?.userId === shardKey`
rejects the default shard, which is where an unsharded table lives, and an
app copying the snippet 403s every unsharded RPC it has.

The snippets are corrected across the concept docs, the scaling tutorial
and the template comments, and the package's own docs already recommended
the safe form -- the two contradicted each other on lines this branch had
just touched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* ci: self-list lint.yml in the generated_files filter

The job's workflow now carries the `build:packages` step the codegen
sweep cannot run without. A PR editing only `lint.yml` to drop it matched
`frontend_lintable` -- so eslint ran -- but not `generated_files`, so the
generated-files job was skipped and its required check stayed green while
the guard it protects was removed. The file's own header states this
self-listing rule; four other filters already follow it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* test: pin the AI filter grounding and drop two tautologies

The studio's rationale for leaving filter rows unmasked cited
generateFilter sending column names only, in a comment about another
package with nothing checking it. Now asserted subtractively -- everything
the caller supplied is removed from the serialised payload and the residue
must contain no user data -- rather than as a not.toContain of a value the
test never supplied, which would pass whatever the code did.

Also: a bigint equality assertion that called one pure function twice with
the same argument, and an admin-function count pinned at 50 that would
fail the day someone legitimately adds one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

* style(studio): format useMaskView

An eslint --fix arrow-body-style rewrite landed after the file was
formatted, and the version restored from a mutation-test backup captured
that state -- so the concise body became a block body Prettier had never
seen. CI's `prettier --check .` caught it.

This is the ordering CLAUDE.md warns about, in reverse: Prettier must run
BEFORE eslint --fix, and anything restored from a backup afterwards needs
the check re-run against it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fJuLhuqLNnWwP1F9zqmPc

### Bug Fixes

* restore guards and gates that passed silently ([#478](https://github.com/anolilab/lunora/issues/478)) ([62af245](https://github.com/anolilab/lunora/commit/62af2456030c28cba83814e410a9dc2ea1d3e580))


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.37
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.89

## @lunora/hyperdrive [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.86...@lunora/hyperdrive@1.0.0-alpha.87) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.88

## @lunora/hyperdrive [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.85...@lunora/hyperdrive@1.0.0-alpha.86) (2026-08-23)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.86

## @lunora/hyperdrive [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.84...@lunora/hyperdrive@1.0.0-alpha.85) (2026-08-21)

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
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.85

## @lunora/hyperdrive [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.83...%40lunora%2Fhyperdrive%401.0.0-alpha.84) (2026-08-19)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.84

## @lunora/hyperdrive [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.82...%40lunora%2Fhyperdrive%401.0.0-alpha.83) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.83

## @lunora/hyperdrive [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.81...%40lunora%2Fhyperdrive%401.0.0-alpha.82) (2026-08-18)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.82

## @lunora/hyperdrive [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.80...%40lunora%2Fhyperdrive%401.0.0-alpha.81) (2026-08-15)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.81

## @lunora/hyperdrive [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.79...%40lunora%2Fhyperdrive%401.0.0-alpha.80) (2026-08-14)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.80
* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/hyperdrive [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.78...%40lunora%2Fhyperdrive%401.0.0-alpha.79) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.79

## @lunora/hyperdrive [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.77...%40lunora%2Fhyperdrive%401.0.0-alpha.78) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.78

## @lunora/hyperdrive [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.76...%40lunora%2Fhyperdrive%401.0.0-alpha.77) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.77

## @lunora/hyperdrive [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.75...%40lunora%2Fhyperdrive%401.0.0-alpha.76) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.76

## @lunora/hyperdrive [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.74...%40lunora%2Fhyperdrive%401.0.0-alpha.75) (2026-08-10)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.75

## @lunora/hyperdrive [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.73...%40lunora%2Fhyperdrive%401.0.0-alpha.74) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.74

## @lunora/hyperdrive [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.72...%40lunora%2Fhyperdrive%401.0.0-alpha.73) (2026-08-09)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.73

## @lunora/hyperdrive [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.71...%40lunora%2Fhyperdrive%401.0.0-alpha.72) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.72

## @lunora/hyperdrive [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.70...%40lunora%2Fhyperdrive%401.0.0-alpha.71) (2026-08-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.71

## @lunora/hyperdrive [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.69...%40lunora%2Fhyperdrive%401.0.0-alpha.70) (2026-08-08)

## @lunora/hyperdrive [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.68...%40lunora%2Fhyperdrive%401.0.0-alpha.69) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.70

## @lunora/hyperdrive [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.67...%40lunora%2Fhyperdrive%401.0.0-alpha.68) (2026-08-07)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.15
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.69

## @lunora/hyperdrive [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.66...%40lunora%2Fhyperdrive%401.0.0-alpha.67) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.14
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.68

## @lunora/hyperdrive [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.65...%40lunora%2Fhyperdrive%401.0.0-alpha.66) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.13
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.67

## @lunora/hyperdrive [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.64...%40lunora%2Fhyperdrive%401.0.0-alpha.65) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.12
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.66

## @lunora/hyperdrive [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.63...%40lunora%2Fhyperdrive%401.0.0-alpha.64) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.11
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.65

## @lunora/hyperdrive [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.62...%40lunora%2Fhyperdrive%401.0.0-alpha.63) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.10
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.64

## @lunora/hyperdrive [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.61...%40lunora%2Fhyperdrive%401.0.0-alpha.62) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.9
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.63

## @lunora/hyperdrive [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.60...%40lunora%2Fhyperdrive%401.0.0-alpha.61) (2026-08-03)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.8
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.62

## @lunora/hyperdrive [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.59...%40lunora%2Fhyperdrive%401.0.0-alpha.60) (2026-08-03)


### Dependencies

* **@lunora/sql-store:** upgraded to 1.0.0-alpha.61

## @lunora/hyperdrive [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.58...%40lunora%2Fhyperdrive%401.0.0-alpha.59) (2026-08-02)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.7
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.60

## @lunora/hyperdrive [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.57...%40lunora%2Fhyperdrive%401.0.0-alpha.58) (2026-08-02)


### Dependencies

* **@lunora/sql-store:** upgraded to 1.0.0-alpha.59

## @lunora/hyperdrive [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.56...%40lunora%2Fhyperdrive%401.0.0-alpha.57) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.4
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.58

## @lunora/hyperdrive [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.55...%40lunora%2Fhyperdrive%401.0.0-alpha.56) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.3
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.57

## @lunora/hyperdrive [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.54...%40lunora%2Fhyperdrive%401.0.0-alpha.55) (2026-07-31)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.2
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.56

## @lunora/hyperdrive [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.53...%40lunora%2Fhyperdrive%401.0.0-alpha.54) (2026-07-30)

## @lunora/hyperdrive [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.52...%40lunora%2Fhyperdrive%401.0.0-alpha.53) (2026-07-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.56
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.53

## @lunora/hyperdrive [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.51...%40lunora%2Fhyperdrive%401.0.0-alpha.52) (2026-07-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.55
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.52

## @lunora/hyperdrive [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.50...%40lunora%2Fhyperdrive%401.0.0-alpha.51) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.54
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.51

## @lunora/hyperdrive [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.49...%40lunora%2Fhyperdrive%401.0.0-alpha.50) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.53
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.50

## @lunora/hyperdrive [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.48...%40lunora%2Fhyperdrive%401.0.0-alpha.49) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.52
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.49

## @lunora/hyperdrive [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.47...%40lunora%2Fhyperdrive%401.0.0-alpha.48) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.51
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.48

## @lunora/hyperdrive [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.46...%40lunora%2Fhyperdrive%401.0.0-alpha.47) (2026-07-27)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.50
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.47

## @lunora/hyperdrive [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.45...%40lunora%2Fhyperdrive%401.0.0-alpha.46) (2026-07-26)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.49
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.46

## @lunora/hyperdrive [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.44...%40lunora%2Fhyperdrive%401.0.0-alpha.45) (2026-07-26)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.48
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.45

## @lunora/hyperdrive [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.43...%40lunora%2Fhyperdrive%401.0.0-alpha.44) (2026-07-25)

## @lunora/hyperdrive [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.42...%40lunora%2Fhyperdrive%401.0.0-alpha.43) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.47
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.44

## @lunora/hyperdrive [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.41...%40lunora%2Fhyperdrive%401.0.0-alpha.42) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.46
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.43

## @lunora/hyperdrive [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.40...%40lunora%2Fhyperdrive%401.0.0-alpha.41) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.45
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.42

## @lunora/hyperdrive [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.39...%40lunora%2Fhyperdrive%401.0.0-alpha.40) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.41

## @lunora/hyperdrive [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.38...%40lunora%2Fhyperdrive%401.0.0-alpha.39) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.43
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.40

## @lunora/hyperdrive [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.37...%40lunora%2Fhyperdrive%401.0.0-alpha.38) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.42
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.39

## @lunora/hyperdrive [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.36...%40lunora%2Fhyperdrive%401.0.0-alpha.37) (2026-07-23)


### Dependencies

* **@lunora/sql-store:** upgraded to 1.0.0-alpha.38

## @lunora/hyperdrive [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.35...%40lunora%2Fhyperdrive%401.0.0-alpha.36) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.37
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.37

## @lunora/hyperdrive [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.34...%40lunora%2Fhyperdrive%401.0.0-alpha.35) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.36
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.36

## @lunora/hyperdrive [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.33...%40lunora%2Fhyperdrive%401.0.0-alpha.34) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.35
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.35

## @lunora/hyperdrive [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.32...%40lunora%2Fhyperdrive%401.0.0-alpha.33) (2026-07-20)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.34

## @lunora/hyperdrive [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.31...%40lunora%2Fhyperdrive%401.0.0-alpha.32) (2026-07-19)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.33
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.33

## @lunora/hyperdrive [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.30...%40lunora%2Fhyperdrive%401.0.0-alpha.31) (2026-07-18)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.32
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.32

## @lunora/hyperdrive [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.29...%40lunora%2Fhyperdrive%401.0.0-alpha.30) (2026-07-17)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.31
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.31

## @lunora/hyperdrive [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.28...%40lunora%2Fhyperdrive%401.0.0-alpha.29) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.30
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.30

## @lunora/hyperdrive [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.27...%40lunora%2Fhyperdrive%401.0.0-alpha.28) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.29
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.29

## @lunora/hyperdrive [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.26...%40lunora%2Fhyperdrive%401.0.0-alpha.27) (2026-07-12)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.28
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.28

## @lunora/hyperdrive [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.25...%40lunora%2Fhyperdrive%401.0.0-alpha.26) (2026-07-11)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.27
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.27

## @lunora/hyperdrive [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.24...%40lunora%2Fhyperdrive%401.0.0-alpha.25) (2026-07-08)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.26

## @lunora/hyperdrive [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.23...%40lunora%2Fhyperdrive%401.0.0-alpha.24) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.24
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.24

## @lunora/hyperdrive [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.22...%40lunora%2Fhyperdrive%401.0.0-alpha.23) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.23
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.23

## @lunora/hyperdrive [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.21...%40lunora%2Fhyperdrive%401.0.0-alpha.22) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.22
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.22

## @lunora/hyperdrive [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.20...%40lunora%2Fhyperdrive%401.0.0-alpha.21) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.21
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.21

## @lunora/hyperdrive [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.19...%40lunora%2Fhyperdrive%401.0.0-alpha.20) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.20
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.20

## @lunora/hyperdrive [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.18...%40lunora%2Fhyperdrive%401.0.0-alpha.19) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.19
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.19

## @lunora/hyperdrive [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.17...%40lunora%2Fhyperdrive%401.0.0-alpha.18) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.18
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.18

## @lunora/hyperdrive [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.16...%40lunora%2Fhyperdrive%401.0.0-alpha.17) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.17
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.17

## @lunora/hyperdrive [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.15...%40lunora%2Fhyperdrive%401.0.0-alpha.16) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.16
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.16

## @lunora/hyperdrive [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.14...%40lunora%2Fhyperdrive%401.0.0-alpha.15) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.15
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.15

## @lunora/hyperdrive [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.13...%40lunora%2Fhyperdrive%401.0.0-alpha.14) (2026-07-01)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.14
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.14

## @lunora/hyperdrive [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.12...%40lunora%2Fhyperdrive%401.0.0-alpha.13) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.13
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.13

## @lunora/hyperdrive [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.11...%40lunora%2Fhyperdrive%401.0.0-alpha.12) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.12
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.12

## @lunora/hyperdrive [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.10...%40lunora%2Fhyperdrive%401.0.0-alpha.11) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.11
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.11

## @lunora/hyperdrive [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.9...%40lunora%2Fhyperdrive%401.0.0-alpha.10) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.10
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.10

## @lunora/hyperdrive [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.8...%40lunora%2Fhyperdrive%401.0.0-alpha.9) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.9
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.9

## @lunora/hyperdrive [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fhyperdrive%401.0.0-alpha.7...%40lunora%2Fhyperdrive%401.0.0-alpha.8) (2026-06-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.8
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.8

## @lunora/hyperdrive [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.6...@lunora/hyperdrive@1.0.0-alpha.7) (2026-06-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.7
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.7

## @lunora/hyperdrive [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.5...@lunora/hyperdrive@1.0.0-alpha.6) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.6
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.6

## @lunora/hyperdrive [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.4...@lunora/hyperdrive@1.0.0-alpha.5) (2026-06-27)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.5
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.5

## @lunora/hyperdrive [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.3...@lunora/hyperdrive@1.0.0-alpha.4) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.4
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.4

## @lunora/hyperdrive [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.2...@lunora/hyperdrive@1.0.0-alpha.3) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.3
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.3

## @lunora/hyperdrive [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/hyperdrive@1.0.0-alpha.1...@lunora/hyperdrive@1.0.0-alpha.2) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.2
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.2

## @lunora/hyperdrive 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.1
* **@lunora/sql-store:** upgraded to 1.0.0-alpha.1
