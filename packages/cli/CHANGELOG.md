## @lunora/cli [1.0.0-alpha.194](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.193...@lunora/cli@1.0.0-alpha.194) (2026-08-26)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.162
* **@lunora/mcp:** upgraded to 1.0.0-alpha.90

## @lunora/cli [1.0.0-alpha.193](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.192...@lunora/cli@1.0.0-alpha.193) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.130
* **@lunora/config:** upgraded to 1.0.0-alpha.161

## @lunora/cli [1.0.0-alpha.192](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.191...@lunora/cli@1.0.0-alpha.192) (2026-08-26)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.91
* **@lunora/mcp:** upgraded to 1.0.0-alpha.89
* **@lunora/testing:** upgraded to 1.0.0-alpha.126

## @lunora/cli [1.0.0-alpha.191](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.190...@lunora/cli@1.0.0-alpha.191) (2026-08-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.93
* **@lunora/codegen:** upgraded to 1.0.0-alpha.129
* **@lunora/config:** upgraded to 1.0.0-alpha.160
* **@lunora/d1:** upgraded to 1.0.0-alpha.90
* **@lunora/mcp:** upgraded to 1.0.0-alpha.88
* **@lunora/runtime:** upgraded to 1.0.0-alpha.76
* **@lunora/seed:** upgraded to 1.0.0-alpha.87
* **@lunora/testing:** upgraded to 1.0.0-alpha.125

## @lunora/cli [1.0.0-alpha.190](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.189...@lunora/cli@1.0.0-alpha.190) (2026-08-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.92
* **@lunora/codegen:** upgraded to 1.0.0-alpha.128
* **@lunora/config:** upgraded to 1.0.0-alpha.159
* **@lunora/seed:** upgraded to 1.0.0-alpha.86
* **@lunora/testing:** upgraded to 1.0.0-alpha.124

## @lunora/cli [1.0.0-alpha.189](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.188...@lunora/cli@1.0.0-alpha.189) (2026-08-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.91
* **@lunora/codegen:** upgraded to 1.0.0-alpha.127
* **@lunora/config:** upgraded to 1.0.0-alpha.158
* **@lunora/seed:** upgraded to 1.0.0-alpha.85
* **@lunora/testing:** upgraded to 1.0.0-alpha.123

## @lunora/cli [1.0.0-alpha.188](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.187...@lunora/cli@1.0.0-alpha.188) (2026-08-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.90
* **@lunora/bindings:** upgraded to 1.0.0-alpha.39
* **@lunora/codegen:** upgraded to 1.0.0-alpha.126
* **@lunora/config:** upgraded to 1.0.0-alpha.157
* **@lunora/container:** upgraded to 1.0.0-alpha.35
* **@lunora/d1:** upgraded to 1.0.0-alpha.89
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/mcp:** upgraded to 1.0.0-alpha.87
* **@lunora/runtime:** upgraded to 1.0.0-alpha.75
* **@lunora/seed:** upgraded to 1.0.0-alpha.84
* **@lunora/testing:** upgraded to 1.0.0-alpha.122

## @lunora/cli [1.0.0-alpha.187](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.186...@lunora/cli@1.0.0-alpha.187) (2026-08-26)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.89
* **@lunora/bindings:** upgraded to 1.0.0-alpha.38
* **@lunora/codegen:** upgraded to 1.0.0-alpha.125
* **@lunora/config:** upgraded to 1.0.0-alpha.156
* **@lunora/container:** upgraded to 1.0.0-alpha.34
* **@lunora/d1:** upgraded to 1.0.0-alpha.88
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/mcp:** upgraded to 1.0.0-alpha.86
* **@lunora/runtime:** upgraded to 1.0.0-alpha.74
* **@lunora/seed:** upgraded to 1.0.0-alpha.83
* **@lunora/testing:** upgraded to 1.0.0-alpha.121

## @lunora/cli [1.0.0-alpha.186](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.185...@lunora/cli@1.0.0-alpha.186) (2026-08-25)

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

* **@lunora/advisor:** upgraded to 1.0.0-alpha.88
* **@lunora/bindings:** upgraded to 1.0.0-alpha.37
* **@lunora/codegen:** upgraded to 1.0.0-alpha.124
* **@lunora/config:** upgraded to 1.0.0-alpha.155
* **@lunora/d1:** upgraded to 1.0.0-alpha.87
* **@lunora/mcp:** upgraded to 1.0.0-alpha.85
* **@lunora/runtime:** upgraded to 1.0.0-alpha.73
* **@lunora/seed:** upgraded to 1.0.0-alpha.82
* **@lunora/testing:** upgraded to 1.0.0-alpha.120

## @lunora/cli [1.0.0-alpha.185](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.184...@lunora/cli@1.0.0-alpha.185) (2026-08-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.123
* **@lunora/config:** upgraded to 1.0.0-alpha.154

## @lunora/cli [1.0.0-alpha.184](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.183...@lunora/cli@1.0.0-alpha.184) (2026-08-25)

### ⚠ BREAKING CHANGES

* **server:** previously-accepted `contains` on non-string filter
columns is no longer honoured. Consistent with the module's allow-list
mechanism (v.object strips undeclared keys), the key is stripped/dropped
rather than rejected with a validation error — the predicate never
reaches the SQL compiler. Alpha branch, no back-compat shim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): redact camelCase and lowercase secret keys

redactSecrets' keyed-value pass matched any identifier key but tested it
against an uppercase-only suffix regex, so exactly the spellings that
appear in request bodies and thrown errors (password, apiToken,
authSecret) fell through unredacted unless the value happened to hit a
prefix or entropy heuristic.

The suffix regex now matches key/password/secret/token as a real word in
SCREAMING_SNAKE, lower snake/bare, or camelCase form, with a boundary so
MONKEY/monkey/donkey (suffix mid-word) no longer match — the old regex
redacted MONKEY=..., a false positive the boundary removes rather than
extends. Camel-hump keys like sortKey are deliberate over-redaction.

The duplicated regex in @lunora/config's .dev.vars scaffolder (and its
test mirror) is kept byte-identical per the existing cross-reference
comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* docs(server): pin storageRules getUrl sync contract

getUrl is the only synchronous member of the storageRules guarded
surface; the wrapping loop's untyped (unknown) return would let a future
async/await refactor silently turn ctx.storage.getUrl into a Promise for
guarded procedures only. Document the invariant at the declaration and
pin it with a test asserting the wrapped call returns a plain string,
not a thenable. No behaviour change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* perf(server): bound presence reads and self-reap

listPresent collected every row a room had ever accumulated (the TTL is
a read-time filter that hides stale rows but never deletes them) and the
sweep is an internal mutation nothing schedules by default, so an app
that skipped wiring a cron degraded as O(live-set x historical-rows) per
TTL window — on the hottest query in the module, re-run for every
subscriber on every heartbeat.

Two local fixes:
- a (roomId, lastSeen) index and a maxMembers option (default 512):
  listPresent now reads newest-first with a hard cap, so cost scales
  with the cap, not with rows ever written; the in-memory sort is gone
  since index order already delivers newest-first.
- the heartbeat opportunistically reaps up to 8 of its room's oldest
  rows per beat, using a cutoff a full max(grace, ttl) window behind the
  visibility cutoff so a row the read filter could still show — or a
  grace-window reconnect could revive — is never deleted. Active rooms
  self-clean; sweep remains as optional bulk hardening.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): unify the secret-key rule in shared/

Four copies of the "does this key name imply a secret" regex existed —
the runtime redactor, the .dev.vars scaffolder, `lunora deploy`'s
required-secret resolver and `lunora doctor` — kept in step only by a
comment. Two had just been updated for camelCase keys and two had not,
so `apiToken` in a .dev.vars was a secret to the runtime and ordinary
config to the CLI.

They are now one definition in shared/secret-key.ts (zero-dep,
bundler-inlined, so no dependency edge between the app runtime and the
CLI/config layer).

The rule also fixes a regression the boundary-based regex introduced:
requiring `^`/`_`/`-` immediately before the suffix silently stopped
matching no-separator compounds the original caught — OPENAI_APIKEY,
APITOKEN, MYPASSWORD, AUTHSECRET — leaving a short or low-entropy secret
under one of those names unredacted in logs and unminted by the
scaffolder. Matching is now a plain case-insensitive suffix, which also
picks up the Title-case and kebab spellings (Api_Key, Auth-Token) the
previous doc claimed to cover.

MONKEY/monkey/donkey stay excluded by an explicit word list rather than
a boundary rule: MONKEY and APIKEY are structurally identical, so no
positional rule can separate them, and the word list is the only honest
way to keep both properties.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): treat enum columns as string filter columns

Gating `contains` on `validator.kind` alone judged an enum column —
`v.union(v.literal("open"), v.literal("closed"))`, kind "union" — and a
bare `v.literal("x")` as non-string, so the operator was omitted from
the generated validator. Because `v.object` strips an undeclared key and
an emptied predicate is dropped, `?where[status][contains]=ope` against
an enum column silently returned the UNFILTERED set rather than failing
— a silent widening wherever a list filter is doing the scoping.

A union now counts as string-typed when every member is (v.null()
members are transparent, so a nullable string union qualifies); a mixed
union still refuses, since `contains` would otherwise reach non-string
values.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): name the presence cap for sessions, not members

The bounded `listPresent` read caps SESSION ROWS — one per (roomId,
sessionId), so one per open tab — but the option was called maxMembers
and documented as a member cap, and the multi-tab dedup runs after the
read. A 300-person room at two tabs each is 600 rows, so the 512 default
silently truncated ~90 live, currently-heartbeating users out of "who's
here" where the previous unbounded read was complete.

Renamed to `maxSessions`, documented as a session cap to be sized
against expected tabs, and the default raised to 1024. A non-finite
value now falls back to the default instead of reaching the reader as
`LIMIT NaN` (Math.max(1, Math.floor(NaN)) is NaN).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): redact any key ending in a secret suffix

The word list excluding ordinary "-key" words (MONKEY, DONKEY, …) is
gone. It never delivered the property it claimed — turnkey, hokey,
lowkey and smokey all end in "key" and were absent, so the list bought
the appearance of precision and none of it, while being unbounded and
unjustifiable to the next reader.

MONKEY and APIKEY are structurally identical, so the only question is
which way to fail. For a redactor over log and error text, over-
redaction is the safe direction: masking a variable named MONKEY costs
one confusing log line, missing APITOKEN costs the credential. The
JSDoc now states that as the deliberate trade, and the tests assert
MONKEY/monkey/sortKey ARE redacted.

The one consumer that writes rather than logs is safe under over-
matching too: the .dev.vars scaffolder mints a value only where the
example held a placeholder, so an over-match fills a placeholder the
user had to fill anyway and never overwrites a real value.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* test(server): suppress the redaction fixture on the secret scanner

`MYPASSWORD=abc` is an input to a redaction assertion, not a credential, but
the scanner reads the assignment shape and fails the Secrets job. Marked with
`gitleaks:allow` the same way the other redaction and column-name fixtures in
this repo are.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

### Bug Fixes

* **config:** parse .dev.vars like wrangler ([#461](https://github.com/anolilab/lunora/issues/461)) ([258fbb7](https://github.com/anolilab/lunora/commit/258fbb70b3c39aec9d33a5254ef384258acc0cfa))
* **server:** harden validation, presence, filters ([#441](https://github.com/anolilab/lunora/issues/441)) ([ca46d51](https://github.com/anolilab/lunora/commit/ca46d510a3f865df6ed547b4b9521ac625e055a3))
* **studio:** route try-it to the worker ([#466](https://github.com/anolilab/lunora/issues/466)) ([d01a363](https://github.com/anolilab/lunora/commit/d01a3639ee52635df5f94d8190c56c9cd5c34e21))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.87
* **@lunora/bindings:** upgraded to 1.0.0-alpha.36
* **@lunora/codegen:** upgraded to 1.0.0-alpha.122
* **@lunora/config:** upgraded to 1.0.0-alpha.153
* **@lunora/d1:** upgraded to 1.0.0-alpha.86
* **@lunora/mcp:** upgraded to 1.0.0-alpha.84
* **@lunora/runtime:** upgraded to 1.0.0-alpha.72
* **@lunora/seed:** upgraded to 1.0.0-alpha.81
* **@lunora/testing:** upgraded to 1.0.0-alpha.119

## @lunora/cli [1.0.0-alpha.183](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.182...@lunora/cli@1.0.0-alpha.183) (2026-08-24)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.86
* **@lunora/bindings:** upgraded to 1.0.0-alpha.35
* **@lunora/codegen:** upgraded to 1.0.0-alpha.121
* **@lunora/config:** upgraded to 1.0.0-alpha.152
* **@lunora/runtime:** upgraded to 1.0.0-alpha.70
* **@lunora/seed:** upgraded to 1.0.0-alpha.80
* **@lunora/testing:** upgraded to 1.0.0-alpha.117

## @lunora/cli [1.0.0-alpha.182](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.181...@lunora/cli@1.0.0-alpha.182) (2026-08-24)


### Dependencies

* **@lunora/mcp:** upgraded to 1.0.0-alpha.82

## @lunora/cli [1.0.0-alpha.181](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.180...@lunora/cli@1.0.0-alpha.181) (2026-08-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.120
* **@lunora/config:** upgraded to 1.0.0-alpha.151
* **@lunora/container:** upgraded to 1.0.0-alpha.33
* **@lunora/seed:** upgraded to 1.0.0-alpha.79

## @lunora/cli [1.0.0-alpha.180](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.179...@lunora/cli@1.0.0-alpha.180) (2026-08-23)

### Bug Fixes

* **cli:** guard sdk vendoring and imports ([#443](https://github.com/anolilab/lunora/issues/443)) ([981a0fa](https://github.com/anolilab/lunora/commit/981a0fabfd9ffd2d6c1d14604694ea8881f15e78))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.85
* **@lunora/bindings:** upgraded to 1.0.0-alpha.33
* **@lunora/codegen:** upgraded to 1.0.0-alpha.119
* **@lunora/config:** upgraded to 1.0.0-alpha.150
* **@lunora/d1:** upgraded to 1.0.0-alpha.84
* **@lunora/mcp:** upgraded to 1.0.0-alpha.81
* **@lunora/runtime:** upgraded to 1.0.0-alpha.69
* **@lunora/seed:** upgraded to 1.0.0-alpha.78
* **@lunora/testing:** upgraded to 1.0.0-alpha.116

## @lunora/cli [1.0.0-alpha.179](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.178...@lunora/cli@1.0.0-alpha.179) (2026-08-23)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.118
* **@lunora/config:** upgraded to 1.0.0-alpha.149
* **@lunora/mcp:** upgraded to 1.0.0-alpha.80

## @lunora/cli [1.0.0-alpha.178](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.177...@lunora/cli@1.0.0-alpha.178) (2026-08-22)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.148

## @lunora/cli [1.0.0-alpha.177](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.176...@lunora/cli@1.0.0-alpha.177) (2026-08-21)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.83
* **@lunora/mcp:** upgraded to 1.0.0-alpha.79
* **@lunora/testing:** upgraded to 1.0.0-alpha.115

## @lunora/cli [1.0.0-alpha.176](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.175...%40lunora%2Fcli%401.0.0-alpha.176) (2026-08-19)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.117
* **@lunora/config:** upgraded to 1.0.0-alpha.147
* **@lunora/d1:** upgraded to 1.0.0-alpha.82
* **@lunora/mcp:** upgraded to 1.0.0-alpha.78
* **@lunora/testing:** upgraded to 1.0.0-alpha.114

## @lunora/cli [1.0.0-alpha.175](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.174...%40lunora%2Fcli%401.0.0-alpha.175) (2026-08-19)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.68

## @lunora/cli [1.0.0-alpha.174](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.173...%40lunora%2Fcli%401.0.0-alpha.174) (2026-08-18)

## @lunora/cli [1.0.0-alpha.173](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.172...%40lunora%2Fcli%401.0.0-alpha.173) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.116
* **@lunora/config:** upgraded to 1.0.0-alpha.146
* **@lunora/mcp:** upgraded to 1.0.0-alpha.77

## @lunora/cli [1.0.0-alpha.172](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.171...%40lunora%2Fcli%401.0.0-alpha.172) (2026-08-18)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.84
* **@lunora/bindings:** upgraded to 1.0.0-alpha.32
* **@lunora/codegen:** upgraded to 1.0.0-alpha.115
* **@lunora/config:** upgraded to 1.0.0-alpha.145
* **@lunora/d1:** upgraded to 1.0.0-alpha.81
* **@lunora/mcp:** upgraded to 1.0.0-alpha.76
* **@lunora/runtime:** upgraded to 1.0.0-alpha.67
* **@lunora/seed:** upgraded to 1.0.0-alpha.77
* **@lunora/testing:** upgraded to 1.0.0-alpha.113

## @lunora/cli [1.0.0-alpha.171](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.170...%40lunora%2Fcli%401.0.0-alpha.171) (2026-08-18)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.83
* **@lunora/bindings:** upgraded to 1.0.0-alpha.31
* **@lunora/codegen:** upgraded to 1.0.0-alpha.114
* **@lunora/config:** upgraded to 1.0.0-alpha.144
* **@lunora/container:** upgraded to 1.0.0-alpha.32
* **@lunora/d1:** upgraded to 1.0.0-alpha.80
* **@lunora/mcp:** upgraded to 1.0.0-alpha.75
* **@lunora/runtime:** upgraded to 1.0.0-alpha.66
* **@lunora/seed:** upgraded to 1.0.0-alpha.76
* **@lunora/testing:** upgraded to 1.0.0-alpha.112

## @lunora/cli [1.0.0-alpha.170](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.169...%40lunora%2Fcli%401.0.0-alpha.170) (2026-08-18)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.82
* **@lunora/codegen:** upgraded to 1.0.0-alpha.113
* **@lunora/config:** upgraded to 1.0.0-alpha.143
* **@lunora/seed:** upgraded to 1.0.0-alpha.75
* **@lunora/testing:** upgraded to 1.0.0-alpha.111

## @lunora/cli [1.0.0-alpha.169](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.168...%40lunora%2Fcli%401.0.0-alpha.169) (2026-08-18)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.142
* **@lunora/mcp:** upgraded to 1.0.0-alpha.74

## @lunora/cli [1.0.0-alpha.168](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.167...%40lunora%2Fcli%401.0.0-alpha.168) (2026-08-15)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.81
* **@lunora/bindings:** upgraded to 1.0.0-alpha.30
* **@lunora/codegen:** upgraded to 1.0.0-alpha.112
* **@lunora/config:** upgraded to 1.0.0-alpha.141
* **@lunora/d1:** upgraded to 1.0.0-alpha.79
* **@lunora/mcp:** upgraded to 1.0.0-alpha.73
* **@lunora/runtime:** upgraded to 1.0.0-alpha.65
* **@lunora/seed:** upgraded to 1.0.0-alpha.74
* **@lunora/testing:** upgraded to 1.0.0-alpha.110

## @lunora/cli [1.0.0-alpha.167](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.166...%40lunora%2Fcli%401.0.0-alpha.167) (2026-08-14)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.111
* **@lunora/config:** upgraded to 1.0.0-alpha.140
* **@lunora/runtime:** upgraded to 1.0.0-alpha.64

## @lunora/cli [1.0.0-alpha.166](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.165...%40lunora%2Fcli%401.0.0-alpha.166) (2026-08-14)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.80
* **@lunora/bindings:** upgraded to 1.0.0-alpha.29
* **@lunora/codegen:** upgraded to 1.0.0-alpha.110
* **@lunora/config:** upgraded to 1.0.0-alpha.139
* **@lunora/container:** upgraded to 1.0.0-alpha.31
* **@lunora/d1:** upgraded to 1.0.0-alpha.78
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/mcp:** upgraded to 1.0.0-alpha.72
* **@lunora/runtime:** upgraded to 1.0.0-alpha.63
* **@lunora/seed:** upgraded to 1.0.0-alpha.73
* **@lunora/testing:** upgraded to 1.0.0-alpha.109

## @lunora/cli [1.0.0-alpha.165](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.164...%40lunora%2Fcli%401.0.0-alpha.165) (2026-08-12)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.79
* **@lunora/codegen:** upgraded to 1.0.0-alpha.109
* **@lunora/config:** upgraded to 1.0.0-alpha.138
* **@lunora/mcp:** upgraded to 1.0.0-alpha.71
* **@lunora/seed:** upgraded to 1.0.0-alpha.72
* **@lunora/testing:** upgraded to 1.0.0-alpha.108

## @lunora/cli [1.0.0-alpha.164](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.163...%40lunora%2Fcli%401.0.0-alpha.164) (2026-08-11)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.78
* **@lunora/codegen:** upgraded to 1.0.0-alpha.108
* **@lunora/config:** upgraded to 1.0.0-alpha.137
* **@lunora/d1:** upgraded to 1.0.0-alpha.77
* **@lunora/mcp:** upgraded to 1.0.0-alpha.70
* **@lunora/runtime:** upgraded to 1.0.0-alpha.62
* **@lunora/seed:** upgraded to 1.0.0-alpha.71
* **@lunora/testing:** upgraded to 1.0.0-alpha.107

## @lunora/cli [1.0.0-alpha.163](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.162...%40lunora%2Fcli%401.0.0-alpha.163) (2026-08-11)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.77
* **@lunora/codegen:** upgraded to 1.0.0-alpha.107
* **@lunora/config:** upgraded to 1.0.0-alpha.136
* **@lunora/d1:** upgraded to 1.0.0-alpha.76
* **@lunora/mcp:** upgraded to 1.0.0-alpha.69
* **@lunora/testing:** upgraded to 1.0.0-alpha.106

## @lunora/cli [1.0.0-alpha.162](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.161...%40lunora%2Fcli%401.0.0-alpha.162) (2026-08-11)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.76
* **@lunora/bindings:** upgraded to 1.0.0-alpha.28
* **@lunora/codegen:** upgraded to 1.0.0-alpha.106
* **@lunora/config:** upgraded to 1.0.0-alpha.135
* **@lunora/container:** upgraded to 1.0.0-alpha.30
* **@lunora/d1:** upgraded to 1.0.0-alpha.75
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/mcp:** upgraded to 1.0.0-alpha.68
* **@lunora/runtime:** upgraded to 1.0.0-alpha.61
* **@lunora/seed:** upgraded to 1.0.0-alpha.70
* **@lunora/testing:** upgraded to 1.0.0-alpha.105

## @lunora/cli [1.0.0-alpha.161](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.160...%40lunora%2Fcli%401.0.0-alpha.161) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.105
* **@lunora/config:** upgraded to 1.0.0-alpha.134

## @lunora/cli [1.0.0-alpha.160](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.159...%40lunora%2Fcli%401.0.0-alpha.160) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.104
* **@lunora/config:** upgraded to 1.0.0-alpha.133

## @lunora/cli [1.0.0-alpha.159](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.158...%40lunora%2Fcli%401.0.0-alpha.159) (2026-08-10)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.75
* **@lunora/codegen:** upgraded to 1.0.0-alpha.103
* **@lunora/config:** upgraded to 1.0.0-alpha.132
* **@lunora/d1:** upgraded to 1.0.0-alpha.74
* **@lunora/mcp:** upgraded to 1.0.0-alpha.67
* **@lunora/testing:** upgraded to 1.0.0-alpha.104

## @lunora/cli [1.0.0-alpha.158](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.157...%40lunora%2Fcli%401.0.0-alpha.158) (2026-08-10)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.74
* **@lunora/codegen:** upgraded to 1.0.0-alpha.102
* **@lunora/config:** upgraded to 1.0.0-alpha.131
* **@lunora/d1:** upgraded to 1.0.0-alpha.73
* **@lunora/mcp:** upgraded to 1.0.0-alpha.66
* **@lunora/runtime:** upgraded to 1.0.0-alpha.60
* **@lunora/seed:** upgraded to 1.0.0-alpha.69
* **@lunora/testing:** upgraded to 1.0.0-alpha.103

## @lunora/cli [1.0.0-alpha.157](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.156...%40lunora%2Fcli%401.0.0-alpha.157) (2026-08-09)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.73
* **@lunora/bindings:** upgraded to 1.0.0-alpha.25
* **@lunora/codegen:** upgraded to 1.0.0-alpha.101
* **@lunora/config:** upgraded to 1.0.0-alpha.130
* **@lunora/container:** upgraded to 1.0.0-alpha.27
* **@lunora/d1:** upgraded to 1.0.0-alpha.72
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/mcp:** upgraded to 1.0.0-alpha.65
* **@lunora/runtime:** upgraded to 1.0.0-alpha.59
* **@lunora/seed:** upgraded to 1.0.0-alpha.68
* **@lunora/testing:** upgraded to 1.0.0-alpha.102

## @lunora/cli [1.0.0-alpha.156](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.155...%40lunora%2Fcli%401.0.0-alpha.156) (2026-08-09)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.100
* **@lunora/config:** upgraded to 1.0.0-alpha.129

## @lunora/cli [1.0.0-alpha.155](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.154...%40lunora%2Fcli%401.0.0-alpha.155) (2026-08-09)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.71
* **@lunora/mcp:** upgraded to 1.0.0-alpha.64
* **@lunora/testing:** upgraded to 1.0.0-alpha.101

## @lunora/cli [1.0.0-alpha.154](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.153...%40lunora%2Fcli%401.0.0-alpha.154) (2026-08-09)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.72
* **@lunora/bindings:** upgraded to 1.0.0-alpha.24
* **@lunora/codegen:** upgraded to 1.0.0-alpha.99
* **@lunora/config:** upgraded to 1.0.0-alpha.128
* **@lunora/container:** upgraded to 1.0.0-alpha.26
* **@lunora/d1:** upgraded to 1.0.0-alpha.70
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/mcp:** upgraded to 1.0.0-alpha.63
* **@lunora/runtime:** upgraded to 1.0.0-alpha.58
* **@lunora/seed:** upgraded to 1.0.0-alpha.67
* **@lunora/testing:** upgraded to 1.0.0-alpha.100

## @lunora/cli [1.0.0-alpha.153](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.152...%40lunora%2Fcli%401.0.0-alpha.153) (2026-08-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.98
* **@lunora/config:** upgraded to 1.0.0-alpha.127
* **@lunora/d1:** upgraded to 1.0.0-alpha.69
* **@lunora/mcp:** upgraded to 1.0.0-alpha.62
* **@lunora/testing:** upgraded to 1.0.0-alpha.99

## @lunora/cli [1.0.0-alpha.152](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.151...%40lunora%2Fcli%401.0.0-alpha.152) (2026-08-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.97
* **@lunora/config:** upgraded to 1.0.0-alpha.126
* **@lunora/testing:** upgraded to 1.0.0-alpha.98

## @lunora/cli [1.0.0-alpha.151](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.150...%40lunora%2Fcli%401.0.0-alpha.151) (2026-08-08)


### Dependencies

* **@lunora/mcp:** upgraded to 1.0.0-alpha.61

## @lunora/cli [1.0.0-alpha.150](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.149...%40lunora%2Fcli%401.0.0-alpha.150) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.71
* **@lunora/bindings:** upgraded to 1.0.0-alpha.23
* **@lunora/codegen:** upgraded to 1.0.0-alpha.96
* **@lunora/config:** upgraded to 1.0.0-alpha.125
* **@lunora/d1:** upgraded to 1.0.0-alpha.68
* **@lunora/runtime:** upgraded to 1.0.0-alpha.57
* **@lunora/seed:** upgraded to 1.0.0-alpha.66
* **@lunora/testing:** upgraded to 1.0.0-alpha.97

## @lunora/cli [1.0.0-alpha.149](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.148...%40lunora%2Fcli%401.0.0-alpha.149) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.70
* **@lunora/codegen:** upgraded to 1.0.0-alpha.95
* **@lunora/config:** upgraded to 1.0.0-alpha.124
* **@lunora/d1:** upgraded to 1.0.0-alpha.67
* **@lunora/mcp:** upgraded to 1.0.0-alpha.60
* **@lunora/runtime:** upgraded to 1.0.0-alpha.56
* **@lunora/seed:** upgraded to 1.0.0-alpha.65
* **@lunora/testing:** upgraded to 1.0.0-alpha.96

## @lunora/cli [1.0.0-alpha.148](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.147...%40lunora%2Fcli%401.0.0-alpha.148) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.69
* **@lunora/bindings:** upgraded to 1.0.0-alpha.22
* **@lunora/codegen:** upgraded to 1.0.0-alpha.94
* **@lunora/config:** upgraded to 1.0.0-alpha.123
* **@lunora/container:** upgraded to 1.0.0-alpha.25
* **@lunora/d1:** upgraded to 1.0.0-alpha.66
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/mcp:** upgraded to 1.0.0-alpha.59
* **@lunora/runtime:** upgraded to 1.0.0-alpha.55
* **@lunora/seed:** upgraded to 1.0.0-alpha.64
* **@lunora/testing:** upgraded to 1.0.0-alpha.95

## @lunora/cli [1.0.0-alpha.147](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.146...%40lunora%2Fcli%401.0.0-alpha.147) (2026-08-07)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.68
* **@lunora/bindings:** upgraded to 1.0.0-alpha.21
* **@lunora/codegen:** upgraded to 1.0.0-alpha.93
* **@lunora/config:** upgraded to 1.0.0-alpha.122
* **@lunora/container:** upgraded to 1.0.0-alpha.24
* **@lunora/d1:** upgraded to 1.0.0-alpha.65
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/mcp:** upgraded to 1.0.0-alpha.58
* **@lunora/runtime:** upgraded to 1.0.0-alpha.54
* **@lunora/seed:** upgraded to 1.0.0-alpha.63
* **@lunora/testing:** upgraded to 1.0.0-alpha.94

## @lunora/cli [1.0.0-alpha.146](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.145...%40lunora%2Fcli%401.0.0-alpha.146) (2026-08-06)

## @lunora/cli [1.0.0-alpha.145](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.144...%40lunora%2Fcli%401.0.0-alpha.145) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.92
* **@lunora/config:** upgraded to 1.0.0-alpha.121
* **@lunora/testing:** upgraded to 1.0.0-alpha.93

## @lunora/cli [1.0.0-alpha.144](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.143...%40lunora%2Fcli%401.0.0-alpha.144) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.91
* **@lunora/config:** upgraded to 1.0.0-alpha.120
* **@lunora/d1:** upgraded to 1.0.0-alpha.64
* **@lunora/testing:** upgraded to 1.0.0-alpha.92

## @lunora/cli [1.0.0-alpha.143](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.142...%40lunora%2Fcli%401.0.0-alpha.143) (2026-08-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.119

## @lunora/cli [1.0.0-alpha.142](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.141...%40lunora%2Fcli%401.0.0-alpha.142) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.67
* **@lunora/bindings:** upgraded to 1.0.0-alpha.20
* **@lunora/codegen:** upgraded to 1.0.0-alpha.90
* **@lunora/config:** upgraded to 1.0.0-alpha.118
* **@lunora/container:** upgraded to 1.0.0-alpha.23
* **@lunora/d1:** upgraded to 1.0.0-alpha.63
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/mcp:** upgraded to 1.0.0-alpha.57
* **@lunora/runtime:** upgraded to 1.0.0-alpha.53
* **@lunora/seed:** upgraded to 1.0.0-alpha.62
* **@lunora/testing:** upgraded to 1.0.0-alpha.91

## @lunora/cli [1.0.0-alpha.141](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.140...%40lunora%2Fcli%401.0.0-alpha.141) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.66
* **@lunora/codegen:** upgraded to 1.0.0-alpha.89
* **@lunora/config:** upgraded to 1.0.0-alpha.117
* **@lunora/seed:** upgraded to 1.0.0-alpha.61
* **@lunora/testing:** upgraded to 1.0.0-alpha.90

## @lunora/cli [1.0.0-alpha.140](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.139...%40lunora%2Fcli%401.0.0-alpha.140) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.65
* **@lunora/codegen:** upgraded to 1.0.0-alpha.88
* **@lunora/config:** upgraded to 1.0.0-alpha.116
* **@lunora/container:** upgraded to 1.0.0-alpha.22

## @lunora/cli [1.0.0-alpha.139](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.138...%40lunora%2Fcli%401.0.0-alpha.139) (2026-08-04)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.64
* **@lunora/bindings:** upgraded to 1.0.0-alpha.19
* **@lunora/codegen:** upgraded to 1.0.0-alpha.87
* **@lunora/config:** upgraded to 1.0.0-alpha.115
* **@lunora/container:** upgraded to 1.0.0-alpha.21
* **@lunora/d1:** upgraded to 1.0.0-alpha.62
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/mcp:** upgraded to 1.0.0-alpha.55
* **@lunora/runtime:** upgraded to 1.0.0-alpha.52
* **@lunora/seed:** upgraded to 1.0.0-alpha.60
* **@lunora/testing:** upgraded to 1.0.0-alpha.89

## @lunora/cli [1.0.0-alpha.138](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.137...%40lunora%2Fcli%401.0.0-alpha.138) (2026-08-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.114
* **@lunora/d1:** upgraded to 1.0.0-alpha.61
* **@lunora/testing:** upgraded to 1.0.0-alpha.88

## @lunora/cli [1.0.0-alpha.137](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.136...%40lunora%2Fcli%401.0.0-alpha.137) (2026-08-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.113
* **@lunora/d1:** upgraded to 1.0.0-alpha.60
* **@lunora/testing:** upgraded to 1.0.0-alpha.87

## @lunora/cli [1.0.0-alpha.136](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.135...%40lunora%2Fcli%401.0.0-alpha.136) (2026-08-03)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.63
* **@lunora/codegen:** upgraded to 1.0.0-alpha.86
* **@lunora/config:** upgraded to 1.0.0-alpha.112
* **@lunora/d1:** upgraded to 1.0.0-alpha.59
* **@lunora/mcp:** upgraded to 1.0.0-alpha.54
* **@lunora/seed:** upgraded to 1.0.0-alpha.59
* **@lunora/testing:** upgraded to 1.0.0-alpha.86

## @lunora/cli [1.0.0-alpha.135](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.134...%40lunora%2Fcli%401.0.0-alpha.135) (2026-08-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.111

## @lunora/cli [1.0.0-alpha.134](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.133...%40lunora%2Fcli%401.0.0-alpha.134) (2026-08-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.62
* **@lunora/bindings:** upgraded to 1.0.0-alpha.18
* **@lunora/codegen:** upgraded to 1.0.0-alpha.85
* **@lunora/config:** upgraded to 1.0.0-alpha.110
* **@lunora/d1:** upgraded to 1.0.0-alpha.58
* **@lunora/runtime:** upgraded to 1.0.0-alpha.51
* **@lunora/seed:** upgraded to 1.0.0-alpha.58
* **@lunora/testing:** upgraded to 1.0.0-alpha.85

## @lunora/cli [1.0.0-alpha.133](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.132...%40lunora%2Fcli%401.0.0-alpha.133) (2026-08-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.84
* **@lunora/config:** upgraded to 1.0.0-alpha.109

## @lunora/cli [1.0.0-alpha.132](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.131...%40lunora%2Fcli%401.0.0-alpha.132) (2026-08-02)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.61
* **@lunora/codegen:** upgraded to 1.0.0-alpha.83
* **@lunora/config:** upgraded to 1.0.0-alpha.108
* **@lunora/d1:** upgraded to 1.0.0-alpha.57
* **@lunora/mcp:** upgraded to 1.0.0-alpha.53
* **@lunora/runtime:** upgraded to 1.0.0-alpha.50
* **@lunora/seed:** upgraded to 1.0.0-alpha.57
* **@lunora/testing:** upgraded to 1.0.0-alpha.84

## @lunora/cli [1.0.0-alpha.131](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.130...%40lunora%2Fcli%401.0.0-alpha.131) (2026-08-01)

## @lunora/cli [1.0.0-alpha.130](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.129...%40lunora%2Fcli%401.0.0-alpha.130) (2026-07-31)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.60
* **@lunora/codegen:** upgraded to 1.0.0-alpha.82
* **@lunora/config:** upgraded to 1.0.0-alpha.107
* **@lunora/d1:** upgraded to 1.0.0-alpha.56
* **@lunora/mcp:** upgraded to 1.0.0-alpha.52
* **@lunora/runtime:** upgraded to 1.0.0-alpha.49
* **@lunora/seed:** upgraded to 1.0.0-alpha.56

## @lunora/cli [1.0.0-alpha.129](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.128...%40lunora%2Fcli%401.0.0-alpha.129) (2026-07-31)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.59
* **@lunora/bindings:** upgraded to 1.0.0-alpha.15
* **@lunora/codegen:** upgraded to 1.0.0-alpha.81
* **@lunora/config:** upgraded to 1.0.0-alpha.106
* **@lunora/container:** upgraded to 1.0.0-alpha.18
* **@lunora/d1:** upgraded to 1.0.0-alpha.55
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/mcp:** upgraded to 1.0.0-alpha.51
* **@lunora/runtime:** upgraded to 1.0.0-alpha.48
* **@lunora/seed:** upgraded to 1.0.0-alpha.55

## @lunora/cli [1.0.0-alpha.128](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.127...%40lunora%2Fcli%401.0.0-alpha.128) (2026-07-31)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.58
* **@lunora/codegen:** upgraded to 1.0.0-alpha.80
* **@lunora/config:** upgraded to 1.0.0-alpha.105
* **@lunora/d1:** upgraded to 1.0.0-alpha.54
* **@lunora/runtime:** upgraded to 1.0.0-alpha.47
* **@lunora/seed:** upgraded to 1.0.0-alpha.54

## @lunora/cli [1.0.0-alpha.127](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.126...%40lunora%2Fcli%401.0.0-alpha.127) (2026-07-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.104
* **@lunora/d1:** upgraded to 1.0.0-alpha.53

## @lunora/cli [1.0.0-alpha.126](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.125...%40lunora%2Fcli%401.0.0-alpha.126) (2026-07-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.77
* **@lunora/config:** upgraded to 1.0.0-alpha.103
* **@lunora/d1:** upgraded to 1.0.0-alpha.52
* **@lunora/seed:** upgraded to 1.0.0-alpha.52

## @lunora/cli [1.0.0-alpha.125](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.124...%40lunora%2Fcli%401.0.0-alpha.125) (2026-07-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.76
* **@lunora/config:** upgraded to 1.0.0-alpha.102
* **@lunora/d1:** upgraded to 1.0.0-alpha.51
* **@lunora/runtime:** upgraded to 1.0.0-alpha.45
* **@lunora/seed:** upgraded to 1.0.0-alpha.51

## @lunora/cli [1.0.0-alpha.124](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.123...%40lunora%2Fcli%401.0.0-alpha.124) (2026-07-28)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.50

## @lunora/cli [1.0.0-alpha.123](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.122...%40lunora%2Fcli%401.0.0-alpha.123) (2026-07-28)

## @lunora/cli [1.0.0-alpha.122](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.121...%40lunora%2Fcli%401.0.0-alpha.122) (2026-07-28)


### Dependencies

* **@lunora/bindings:** upgraded to 1.0.0-alpha.13
* **@lunora/codegen:** upgraded to 1.0.0-alpha.75
* **@lunora/config:** upgraded to 1.0.0-alpha.101
* **@lunora/container:** upgraded to 1.0.0-alpha.17
* **@lunora/d1:** upgraded to 1.0.0-alpha.49
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/mcp:** upgraded to 1.0.0-alpha.49
* **@lunora/runtime:** upgraded to 1.0.0-alpha.44
* **@lunora/seed:** upgraded to 1.0.0-alpha.50

## @lunora/cli [1.0.0-alpha.121](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.120...%40lunora%2Fcli%401.0.0-alpha.121) (2026-07-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.74
* **@lunora/config:** upgraded to 1.0.0-alpha.100
* **@lunora/mcp:** upgraded to 1.0.0-alpha.48
* **@lunora/runtime:** upgraded to 1.0.0-alpha.43
* **@lunora/seed:** upgraded to 1.0.0-alpha.49

## @lunora/cli [1.0.0-alpha.120](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.119...%40lunora%2Fcli%401.0.0-alpha.120) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.73
* **@lunora/config:** upgraded to 1.0.0-alpha.99
* **@lunora/mcp:** upgraded to 1.0.0-alpha.47
* **@lunora/seed:** upgraded to 1.0.0-alpha.48

## @lunora/cli [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.118...%40lunora%2Fcli%401.0.0-alpha.119) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.72
* **@lunora/config:** upgraded to 1.0.0-alpha.98
* **@lunora/seed:** upgraded to 1.0.0-alpha.47

## @lunora/cli [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.117...%40lunora%2Fcli%401.0.0-alpha.118) (2026-07-27)


### Dependencies

* **@lunora/bindings:** upgraded to 1.0.0-alpha.12
* **@lunora/codegen:** upgraded to 1.0.0-alpha.71
* **@lunora/config:** upgraded to 1.0.0-alpha.97
* **@lunora/d1:** upgraded to 1.0.0-alpha.48
* **@lunora/runtime:** upgraded to 1.0.0-alpha.42
* **@lunora/seed:** upgraded to 1.0.0-alpha.46

## @lunora/cli [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.116...%40lunora%2Fcli%401.0.0-alpha.117) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.70
* **@lunora/config:** upgraded to 1.0.0-alpha.96
* **@lunora/seed:** upgraded to 1.0.0-alpha.45

## @lunora/cli [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.115...%40lunora%2Fcli%401.0.0-alpha.116) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.69
* **@lunora/config:** upgraded to 1.0.0-alpha.95
* **@lunora/d1:** upgraded to 1.0.0-alpha.47
* **@lunora/seed:** upgraded to 1.0.0-alpha.44

## @lunora/cli [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.114...%40lunora%2Fcli%401.0.0-alpha.115) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.68
* **@lunora/config:** upgraded to 1.0.0-alpha.94
* **@lunora/d1:** upgraded to 1.0.0-alpha.46
* **@lunora/runtime:** upgraded to 1.0.0-alpha.41
* **@lunora/seed:** upgraded to 1.0.0-alpha.43

## @lunora/cli [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.113...%40lunora%2Fcli%401.0.0-alpha.114) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.67
* **@lunora/config:** upgraded to 1.0.0-alpha.93
* **@lunora/seed:** upgraded to 1.0.0-alpha.42

## @lunora/cli [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.112...%40lunora%2Fcli%401.0.0-alpha.113) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.66
* **@lunora/config:** upgraded to 1.0.0-alpha.92
* **@lunora/seed:** upgraded to 1.0.0-alpha.41

## @lunora/cli [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.111...%40lunora%2Fcli%401.0.0-alpha.112) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.65
* **@lunora/config:** upgraded to 1.0.0-alpha.91
* **@lunora/seed:** upgraded to 1.0.0-alpha.40

## @lunora/cli [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.110...%40lunora%2Fcli%401.0.0-alpha.111) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.64
* **@lunora/config:** upgraded to 1.0.0-alpha.90
* **@lunora/seed:** upgraded to 1.0.0-alpha.39

## @lunora/cli [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.109...%40lunora%2Fcli%401.0.0-alpha.110) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.63
* **@lunora/config:** upgraded to 1.0.0-alpha.89
* **@lunora/seed:** upgraded to 1.0.0-alpha.38

## @lunora/cli [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.108...%40lunora%2Fcli%401.0.0-alpha.109) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.62
* **@lunora/config:** upgraded to 1.0.0-alpha.88
* **@lunora/seed:** upgraded to 1.0.0-alpha.37

## @lunora/cli [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.107...%40lunora%2Fcli%401.0.0-alpha.108) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.61
* **@lunora/config:** upgraded to 1.0.0-alpha.87
* **@lunora/d1:** upgraded to 1.0.0-alpha.45
* **@lunora/seed:** upgraded to 1.0.0-alpha.36

## @lunora/cli [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.106...%40lunora%2Fcli%401.0.0-alpha.107) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.60
* **@lunora/config:** upgraded to 1.0.0-alpha.86
* **@lunora/d1:** upgraded to 1.0.0-alpha.44
* **@lunora/runtime:** upgraded to 1.0.0-alpha.40
* **@lunora/seed:** upgraded to 1.0.0-alpha.35

## @lunora/cli [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.105...%40lunora%2Fcli%401.0.0-alpha.106) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.59
* **@lunora/config:** upgraded to 1.0.0-alpha.85
* **@lunora/seed:** upgraded to 1.0.0-alpha.34

## @lunora/cli [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.104...%40lunora%2Fcli%401.0.0-alpha.105) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.58
* **@lunora/config:** upgraded to 1.0.0-alpha.84
* **@lunora/seed:** upgraded to 1.0.0-alpha.33

## @lunora/cli [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.103...%40lunora%2Fcli%401.0.0-alpha.104) (2026-07-25)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.43

## @lunora/cli [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.102...%40lunora%2Fcli%401.0.0-alpha.103) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.57
* **@lunora/config:** upgraded to 1.0.0-alpha.83
* **@lunora/d1:** upgraded to 1.0.0-alpha.42
* **@lunora/runtime:** upgraded to 1.0.0-alpha.39
* **@lunora/seed:** upgraded to 1.0.0-alpha.32

## @lunora/cli [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.101...%40lunora%2Fcli%401.0.0-alpha.102) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.56
* **@lunora/config:** upgraded to 1.0.0-alpha.82
* **@lunora/d1:** upgraded to 1.0.0-alpha.41
* **@lunora/runtime:** upgraded to 1.0.0-alpha.38
* **@lunora/seed:** upgraded to 1.0.0-alpha.31

## @lunora/cli [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.100...%40lunora%2Fcli%401.0.0-alpha.101) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.55
* **@lunora/config:** upgraded to 1.0.0-alpha.81

## @lunora/cli [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.99...%40lunora%2Fcli%401.0.0-alpha.100) (2026-07-25)


### Dependencies

* **@lunora/bindings:** upgraded to 1.0.0-alpha.11
* **@lunora/codegen:** upgraded to 1.0.0-alpha.54
* **@lunora/config:** upgraded to 1.0.0-alpha.80
* **@lunora/container:** upgraded to 1.0.0-alpha.16
* **@lunora/d1:** upgraded to 1.0.0-alpha.40
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/runtime:** upgraded to 1.0.0-alpha.37
* **@lunora/seed:** upgraded to 1.0.0-alpha.30

## @lunora/cli [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.98...%40lunora%2Fcli%401.0.0-alpha.99) (2026-07-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.53
* **@lunora/config:** upgraded to 1.0.0-alpha.79
* **@lunora/container:** upgraded to 1.0.0-alpha.15
* **@lunora/d1:** upgraded to 1.0.0-alpha.39
* **@lunora/runtime:** upgraded to 1.0.0-alpha.36

## @lunora/cli [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.97...%40lunora%2Fcli%401.0.0-alpha.98) (2026-07-24)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.38

## @lunora/cli [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.96...%40lunora%2Fcli%401.0.0-alpha.97) (2026-07-23)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.52
* **@lunora/config:** upgraded to 1.0.0-alpha.78
* **@lunora/d1:** upgraded to 1.0.0-alpha.37
* **@lunora/runtime:** upgraded to 1.0.0-alpha.35
* **@lunora/seed:** upgraded to 1.0.0-alpha.29

## @lunora/cli [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.95...%40lunora%2Fcli%401.0.0-alpha.96) (2026-07-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.51
* **@lunora/config:** upgraded to 1.0.0-alpha.77
* **@lunora/runtime:** upgraded to 1.0.0-alpha.34

## @lunora/cli [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.94...%40lunora%2Fcli%401.0.0-alpha.95) (2026-07-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.50
* **@lunora/config:** upgraded to 1.0.0-alpha.76

## @lunora/cli [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.93...%40lunora%2Fcli%401.0.0-alpha.94) (2026-07-21)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.49
* **@lunora/config:** upgraded to 1.0.0-alpha.75
* **@lunora/d1:** upgraded to 1.0.0-alpha.36
* **@lunora/runtime:** upgraded to 1.0.0-alpha.33

## @lunora/cli [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.92...%40lunora%2Fcli%401.0.0-alpha.93) (2026-07-21)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.74
* **@lunora/runtime:** upgraded to 1.0.0-alpha.32

## @lunora/cli [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.91...%40lunora%2Fcli%401.0.0-alpha.92) (2026-07-21)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.73
* **@lunora/d1:** upgraded to 1.0.0-alpha.35
* **@lunora/runtime:** upgraded to 1.0.0-alpha.31

## @lunora/cli [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.90...%40lunora%2Fcli%401.0.0-alpha.91) (2026-07-21)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.48
* **@lunora/config:** upgraded to 1.0.0-alpha.72
* **@lunora/d1:** upgraded to 1.0.0-alpha.34
* **@lunora/seed:** upgraded to 1.0.0-alpha.28

## @lunora/cli [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.89...%40lunora%2Fcli%401.0.0-alpha.90) (2026-07-20)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.47
* **@lunora/config:** upgraded to 1.0.0-alpha.71
* **@lunora/container:** upgraded to 1.0.0-alpha.13
* **@lunora/d1:** upgraded to 1.0.0-alpha.33
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/seed:** upgraded to 1.0.0-alpha.27

## @lunora/cli [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.88...%40lunora%2Fcli%401.0.0-alpha.89) (2026-07-19)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.46
* **@lunora/config:** upgraded to 1.0.0-alpha.70
* **@lunora/d1:** upgraded to 1.0.0-alpha.32
* **@lunora/seed:** upgraded to 1.0.0-alpha.26

## @lunora/cli [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.87...%40lunora%2Fcli%401.0.0-alpha.88) (2026-07-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.45
* **@lunora/config:** upgraded to 1.0.0-alpha.69
* **@lunora/d1:** upgraded to 1.0.0-alpha.31
* **@lunora/seed:** upgraded to 1.0.0-alpha.25

## @lunora/cli [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.86...%40lunora%2Fcli%401.0.0-alpha.87) (2026-07-17)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.44
* **@lunora/config:** upgraded to 1.0.0-alpha.68
* **@lunora/container:** upgraded to 1.0.0-alpha.12
* **@lunora/d1:** upgraded to 1.0.0-alpha.30
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/seed:** upgraded to 1.0.0-alpha.24

## @lunora/cli [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.85...%40lunora%2Fcli%401.0.0-alpha.86) (2026-07-13)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.67
* **@lunora/d1:** upgraded to 1.0.0-alpha.29

## @lunora/cli [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.84...%40lunora%2Fcli%401.0.0-alpha.85) (2026-07-13)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.43
* **@lunora/config:** upgraded to 1.0.0-alpha.66
* **@lunora/d1:** upgraded to 1.0.0-alpha.28
* **@lunora/seed:** upgraded to 1.0.0-alpha.23

## @lunora/cli [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.83...%40lunora%2Fcli%401.0.0-alpha.84) (2026-07-12)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.42
* **@lunora/config:** upgraded to 1.0.0-alpha.65
* **@lunora/container:** upgraded to 1.0.0-alpha.11
* **@lunora/d1:** upgraded to 1.0.0-alpha.27

## @lunora/cli [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.82...%40lunora%2Fcli%401.0.0-alpha.83) (2026-07-12)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.64

## @lunora/cli [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.81...%40lunora%2Fcli%401.0.0-alpha.82) (2026-07-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.41
* **@lunora/config:** upgraded to 1.0.0-alpha.63
* **@lunora/container:** upgraded to 1.0.0-alpha.10

## @lunora/cli [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.80...%40lunora%2Fcli%401.0.0-alpha.81) (2026-07-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.40
* **@lunora/config:** upgraded to 1.0.0-alpha.62
* **@lunora/container:** upgraded to 1.0.0-alpha.9
* **@lunora/d1:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/seed:** upgraded to 1.0.0-alpha.22

## @lunora/cli [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.79...%40lunora%2Fcli%401.0.0-alpha.80) (2026-07-10)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.39
* **@lunora/config:** upgraded to 1.0.0-alpha.61
* **@lunora/seed:** upgraded to 1.0.0-alpha.21

## @lunora/cli [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.78...%40lunora%2Fcli%401.0.0-alpha.79) (2026-07-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.38
* **@lunora/config:** upgraded to 1.0.0-alpha.60
* **@lunora/container:** upgraded to 1.0.0-alpha.8
* **@lunora/d1:** upgraded to 1.0.0-alpha.25
* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/seed:** upgraded to 1.0.0-alpha.20

## @lunora/cli [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.77...%40lunora%2Fcli%401.0.0-alpha.78) (2026-07-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.37
* **@lunora/config:** upgraded to 1.0.0-alpha.59
* **@lunora/seed:** upgraded to 1.0.0-alpha.19

## @lunora/cli [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.76...%40lunora%2Fcli%401.0.0-alpha.77) (2026-07-08)

## @lunora/cli [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.75...%40lunora%2Fcli%401.0.0-alpha.76) (2026-07-08)

## @lunora/cli [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.74...%40lunora%2Fcli%401.0.0-alpha.75) (2026-07-08)

## @lunora/cli [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.73...%40lunora%2Fcli%401.0.0-alpha.74) (2026-07-07)

## @lunora/cli [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.72...%40lunora%2Fcli%401.0.0-alpha.73) (2026-07-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.36
* **@lunora/config:** upgraded to 1.0.0-alpha.58
* **@lunora/seed:** upgraded to 1.0.0-alpha.18

## @lunora/cli [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.71...%40lunora%2Fcli%401.0.0-alpha.72) (2026-07-06)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.35
* **@lunora/config:** upgraded to 1.0.0-alpha.57

## @lunora/cli [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.70...%40lunora%2Fcli%401.0.0-alpha.71) (2026-07-06)

## @lunora/cli [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.69...%40lunora%2Fcli%401.0.0-alpha.70) (2026-07-05)

## @lunora/cli [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.68...%40lunora%2Fcli%401.0.0-alpha.69) (2026-07-05)

## @lunora/cli [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.67...%40lunora%2Fcli%401.0.0-alpha.68) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.34
* **@lunora/config:** upgraded to 1.0.0-alpha.56
* **@lunora/container:** upgraded to 1.0.0-alpha.7
* **@lunora/d1:** upgraded to 1.0.0-alpha.24
* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/seed:** upgraded to 1.0.0-alpha.17

## @lunora/cli [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.66...%40lunora%2Fcli%401.0.0-alpha.67) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.55

## @lunora/cli [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.65...%40lunora%2Fcli%401.0.0-alpha.66) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.33
* **@lunora/config:** upgraded to 1.0.0-alpha.54

## @lunora/cli [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.64...%40lunora%2Fcli%401.0.0-alpha.65) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.53

## @lunora/cli [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.63...%40lunora%2Fcli%401.0.0-alpha.64) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.52

## @lunora/cli [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.62...%40lunora%2Fcli%401.0.0-alpha.63) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.51

## @lunora/cli [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.61...%40lunora%2Fcli%401.0.0-alpha.62) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.32
* **@lunora/config:** upgraded to 1.0.0-alpha.50
* **@lunora/seed:** upgraded to 1.0.0-alpha.16

## @lunora/cli [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.60...%40lunora%2Fcli%401.0.0-alpha.61) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.49

## @lunora/cli [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.59...%40lunora%2Fcli%401.0.0-alpha.60) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.30
* **@lunora/config:** upgraded to 1.0.0-alpha.48
* **@lunora/seed:** upgraded to 1.0.0-alpha.15

## @lunora/cli [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.58...%40lunora%2Fcli%401.0.0-alpha.59) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.47

## @lunora/cli [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.57...%40lunora%2Fcli%401.0.0-alpha.58) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.29
* **@lunora/config:** upgraded to 1.0.0-alpha.46
* **@lunora/container:** upgraded to 1.0.0-alpha.6
* **@lunora/d1:** upgraded to 1.0.0-alpha.22
* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/seed:** upgraded to 1.0.0-alpha.14

## @lunora/cli [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.56...%40lunora%2Fcli%401.0.0-alpha.57) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.28
* **@lunora/config:** upgraded to 1.0.0-alpha.45
* **@lunora/d1:** upgraded to 1.0.0-alpha.21

## @lunora/cli [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.55...%40lunora%2Fcli%401.0.0-alpha.56) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.44

## @lunora/cli [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.54...%40lunora%2Fcli%401.0.0-alpha.55) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.43

## @lunora/cli [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.53...%40lunora%2Fcli%401.0.0-alpha.54) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.27
* **@lunora/config:** upgraded to 1.0.0-alpha.42
* **@lunora/d1:** upgraded to 1.0.0-alpha.20
* **@lunora/seed:** upgraded to 1.0.0-alpha.13

## @lunora/cli [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.52...%40lunora%2Fcli%401.0.0-alpha.53) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.26
* **@lunora/config:** upgraded to 1.0.0-alpha.41
* **@lunora/d1:** upgraded to 1.0.0-alpha.19

## @lunora/cli [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.51...%40lunora%2Fcli%401.0.0-alpha.52) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.25
* **@lunora/config:** upgraded to 1.0.0-alpha.40
* **@lunora/d1:** upgraded to 1.0.0-alpha.18
* **@lunora/seed:** upgraded to 1.0.0-alpha.12

## @lunora/cli [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.50...%40lunora%2Fcli%401.0.0-alpha.51) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.24
* **@lunora/config:** upgraded to 1.0.0-alpha.39
* **@lunora/d1:** upgraded to 1.0.0-alpha.17

## @lunora/cli [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.49...%40lunora%2Fcli%401.0.0-alpha.50) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.23
* **@lunora/config:** upgraded to 1.0.0-alpha.38
* **@lunora/seed:** upgraded to 1.0.0-alpha.11

## @lunora/cli [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.48...%40lunora%2Fcli%401.0.0-alpha.49) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.22
* **@lunora/config:** upgraded to 1.0.0-alpha.37
* **@lunora/d1:** upgraded to 1.0.0-alpha.16
* **@lunora/seed:** upgraded to 1.0.0-alpha.10

## @lunora/cli [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.47...%40lunora%2Fcli%401.0.0-alpha.48) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.21
* **@lunora/config:** upgraded to 1.0.0-alpha.36
* **@lunora/d1:** upgraded to 1.0.0-alpha.15
* **@lunora/seed:** upgraded to 1.0.0-alpha.9

## @lunora/cli [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.46...%40lunora%2Fcli%401.0.0-alpha.47) (2026-07-01)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.35

## @lunora/cli [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.45...%40lunora%2Fcli%401.0.0-alpha.46) (2026-07-01)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.20
* **@lunora/config:** upgraded to 1.0.0-alpha.34
* **@lunora/d1:** upgraded to 1.0.0-alpha.14
* **@lunora/seed:** upgraded to 1.0.0-alpha.8

## @lunora/cli [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.44...%40lunora%2Fcli%401.0.0-alpha.45) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.33

## @lunora/cli [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.43...%40lunora%2Fcli%401.0.0-alpha.44) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.32
* **@lunora/d1:** upgraded to 1.0.0-alpha.13

## @lunora/cli [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.42...%40lunora%2Fcli%401.0.0-alpha.43) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.19
* **@lunora/config:** upgraded to 1.0.0-alpha.31
* **@lunora/d1:** upgraded to 1.0.0-alpha.12

## @lunora/cli [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.41...%40lunora%2Fcli%401.0.0-alpha.42) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.18
* **@lunora/config:** upgraded to 1.0.0-alpha.30

## @lunora/cli [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.40...%40lunora%2Fcli%401.0.0-alpha.41) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.29
* **@lunora/d1:** upgraded to 1.0.0-alpha.11

## @lunora/cli [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.39...%40lunora%2Fcli%401.0.0-alpha.40) (2026-06-30)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.10

## @lunora/cli [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.38...%40lunora%2Fcli%401.0.0-alpha.39) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.28

## @lunora/cli [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.37...%40lunora%2Fcli%401.0.0-alpha.38) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.17
* **@lunora/config:** upgraded to 1.0.0-alpha.27
* **@lunora/d1:** upgraded to 1.0.0-alpha.9
* **@lunora/seed:** upgraded to 1.0.0-alpha.7

## @lunora/cli [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.36...%40lunora%2Fcli%401.0.0-alpha.37) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.16
* **@lunora/config:** upgraded to 1.0.0-alpha.26
* **@lunora/container:** upgraded to 1.0.0-alpha.5

## @lunora/cli [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.35...%40lunora%2Fcli%401.0.0-alpha.36) (2026-06-29)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.25

## @lunora/cli [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.34...%40lunora%2Fcli%401.0.0-alpha.35) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.15
* **@lunora/config:** upgraded to 1.0.0-alpha.24
* **@lunora/d1:** upgraded to 1.0.0-alpha.8

## @lunora/cli [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.33...%40lunora%2Fcli%401.0.0-alpha.34) (2026-06-29)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.23

## @lunora/cli [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fcli%401.0.0-alpha.32...%40lunora%2Fcli%401.0.0-alpha.33) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.14
* **@lunora/config:** upgraded to 1.0.0-alpha.22
* **@lunora/seed:** upgraded to 1.0.0-alpha.6

## @lunora/cli [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.31...@lunora/cli@1.0.0-alpha.32) (2026-06-28)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.21

## @lunora/cli [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.30...@lunora/cli@1.0.0-alpha.31) (2026-06-28)

### Features

* **vite:** error-overlay solution finders ([#42](https://github.com/anolilab/lunora/issues/42)) ([33097e2](https://github.com/anolilab/lunora/commit/33097e2d5638b3e924c506eb5e161e9a20ea6f6f))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.13
* **@lunora/config:** upgraded to 1.0.0-alpha.20

## @lunora/cli [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.29...@lunora/cli@1.0.0-alpha.30) (2026-06-28)

### Features

* **config:** stream dev container logs to terminal ([#38](https://github.com/anolilab/lunora/issues/38)) ([c34dbc6](https://github.com/anolilab/lunora/commit/c34dbc6f40f9e31ce291dbd31c6c4d9e596b4127))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.19

## @lunora/cli [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.28...@lunora/cli@1.0.0-alpha.29) (2026-06-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.12
* **@lunora/config:** upgraded to 1.0.0-alpha.18
* **@lunora/container:** upgraded to 1.0.0-alpha.4

## @lunora/cli [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.27...@lunora/cli@1.0.0-alpha.28) (2026-06-28)

### Documentation

* fix package doc bugs and dead cross-links ([205d74c](https://github.com/anolilab/lunora/commit/205d74c3b730e201e822141191b45015f303336b))


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.7

## @lunora/cli [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.26...@lunora/cli@1.0.0-alpha.27) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.11
* **@lunora/config:** upgraded to 1.0.0-alpha.17
* **@lunora/container:** upgraded to 1.0.0-alpha.3
* **@lunora/d1:** upgraded to 1.0.0-alpha.6
* **@lunora/seed:** upgraded to 1.0.0-alpha.5

## @lunora/cli [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.25...@lunora/cli@1.0.0-alpha.26) (2026-06-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.10
* **@lunora/config:** upgraded to 1.0.0-alpha.16
* **@lunora/container:** upgraded to 1.0.0-alpha.2
* **@lunora/seed:** upgraded to 1.0.0-alpha.4

## @lunora/cli [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.24...@lunora/cli@1.0.0-alpha.25) (2026-06-27)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.9
* **@lunora/config:** upgraded to 1.0.0-alpha.15
* **@lunora/d1:** upgraded to 1.0.0-alpha.5
* **@lunora/seed:** upgraded to 1.0.0-alpha.3

## @lunora/cli [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.23...@lunora/cli@1.0.0-alpha.24) (2026-06-26)

### Features

* **cli:** add --format json to lunora add ([9bb5291](https://github.com/anolilab/lunora/commit/9bb529139844619d11fd12ba9fcc360d6b50103d))
* **cli:** classify init template-download failures with next steps ([2c27c85](https://github.com/anolilab/lunora/commit/2c27c85bf9a03cd83638c577adef1e9ec1395a7b))

### Bug Fixes

* **cli:** exit cleanly when an interactive prompt is cancelled ([6bbc412](https://github.com/anolilab/lunora/commit/6bbc412daec3ce6e1261003e770d436ed3a63f17))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.8
* **@lunora/config:** upgraded to 1.0.0-alpha.14

## @lunora/cli [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.22...@lunora/cli@1.0.0-alpha.23) (2026-06-25)

### Features

* **cli:** env generate + deploy-time missing-secret gate ([c0f6c6f](https://github.com/anolilab/lunora/commit/c0f6c6f68a125c112263237eba8ecb3ac9efdc3e))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.13

## @lunora/cli [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.21...@lunora/cli@1.0.0-alpha.22) (2026-06-25)

### Features

* **config:** generate empty dev secrets + admin token on dev ([c4f729f](https://github.com/anolilab/lunora/commit/c4f729f51bc0a68a356e2750ce49cc7a1edbf9a2))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.12

## @lunora/cli [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.20...@lunora/cli@1.0.0-alpha.21) (2026-06-25)

### Features

* **cli:** branded welcome + advisor-clean messages for create-vite overlay ([d522a91](https://github.com/anolilab/lunora/commit/d522a91f7aed50d00404af6b0f93a918dae7cbc2))

## @lunora/cli [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.19...@lunora/cli@1.0.0-alpha.20) (2026-06-25)

### Bug Fixes

* **cli:** pnpm allowBuilds + overlay [#lunora](https://github.com/anolilab/lunora/issues/lunora) imports mapping ([e437eee](https://github.com/anolilab/lunora/commit/e437eee71369b141677a813eb4be2dce8819be75))

## @lunora/cli [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.18...@lunora/cli@1.0.0-alpha.19) (2026-06-25)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.11

## @lunora/cli [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.17...@lunora/cli@1.0.0-alpha.18) (2026-06-25)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.10

## @lunora/cli [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.16...@lunora/cli@1.0.0-alpha.17) (2026-06-25)

### Bug Fixes

* **cli:** write pnpm-workspace.yaml for build approval ([c6572ae](https://github.com/anolilab/lunora/commit/c6572ae7cbee5b0e79f7a24a48f0c9bf075b5dda))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.7
* **@lunora/config:** upgraded to 1.0.0-alpha.9

## @lunora/cli [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.15...@lunora/cli@1.0.0-alpha.16) (2026-06-25)

### Bug Fixes

* **cli:** fix init install UX and pnpm builds ([8ad019c](https://github.com/anolilab/lunora/commit/8ad019c1b02262d494aa5e9a2ebb9ecbbfd1b771))
* **cli:** scaffold @lunora/studio for /__lunora ([a92299c](https://github.com/anolilab/lunora/commit/a92299c34192f21a0db58a9f62a20c512f3abbc6))

## @lunora/cli [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.14...@lunora/cli@1.0.0-alpha.15) (2026-06-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.6
* **@lunora/config:** upgraded to 1.0.0-alpha.8

## @lunora/cli [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.13...@lunora/cli@1.0.0-alpha.14) (2026-06-25)

### Bug Fixes

* **cli:** pin overlay deps to concrete version ([eb71417](https://github.com/anolilab/lunora/commit/eb714173bcb4f273f17cf41732a1cd32c4408024))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.5
* **@lunora/config:** upgraded to 1.0.0-alpha.7

## @lunora/cli [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.12...@lunora/cli@1.0.0-alpha.13) (2026-06-25)

### Bug Fixes

* **cli:** pin scaffold deps to concrete version ([54cd8ae](https://github.com/anolilab/lunora/commit/54cd8ae441bd48042bc0d63d83717e75821d911b))

## @lunora/cli [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.11...@lunora/cli@1.0.0-alpha.12) (2026-06-25)

### Bug Fixes

* **cli:** align task rows to the badge gutter ([55a380e](https://github.com/anolilab/lunora/commit/55a380edd7c0b82e8ded08fab03d48d5c189457d))
* **cli:** merge schema extension into default export ([4530f38](https://github.com/anolilab/lunora/commit/4530f38390ebbfa481b3e0f96a6bf568d7220ec9))

## @lunora/cli [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.10...@lunora/cli@1.0.0-alpha.11) (2026-06-25)

### Bug Fixes

* **cli:** align progress bar and fix overwrite ([7ce48fd](https://github.com/anolilab/lunora/commit/7ce48fd3e59e64d93a9e23d0b49b5b7e9f4e33fe))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.4
* **@lunora/config:** upgraded to 1.0.0-alpha.6
* **@lunora/seed:** upgraded to 1.0.0-alpha.2

## @lunora/cli [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.9...@lunora/cli@1.0.0-alpha.10) (2026-06-25)

### Features

* **cli:** rebuild init DX in create-astro style ([36638dc](https://github.com/anolilab/lunora/commit/36638dc6b08978509da90861f3b9292205c10300))

### Bug Fixes

* remove not needed package ([d254595](https://github.com/anolilab/lunora/commit/d254595cbc0eb689724fecb87345dbbb30a2245f))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.5

## @lunora/cli [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.8...@lunora/cli@1.0.0-alpha.9) (2026-06-24)

### Features

* **cli:** prompt for binding values on init/add instead of shipping placeholders ([f7538db](https://github.com/anolilab/lunora/commit/f7538dbc3e43ad94416e86255976a94606228e16))

## @lunora/cli [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.7...@lunora/cli@1.0.0-alpha.8) (2026-06-24)

### Features

* **r2sql:** typed R2 SQL client with window functions, DISTINCT and set ops ([#26](https://github.com/anolilab/lunora/issues/26)) ([fe9546b](https://github.com/anolilab/lunora/commit/fe9546bb3473875d47939bf93e6fbb81084a07aa))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.3
* **@lunora/config:** upgraded to 1.0.0-alpha.4
* **@lunora/d1:** upgraded to 1.0.0-alpha.4

## @lunora/cli [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.6...@lunora/cli@1.0.0-alpha.7) (2026-06-23)

### Bug Fixes

* **templates:** replace hardcoded worker port with VITE_LUNORA_URL env ([98e539d](https://github.com/anolilab/lunora/commit/98e539de32acf07c2cabd1ce73c5e52522dae3a1))

## @lunora/cli [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.5...@lunora/cli@1.0.0-alpha.6) (2026-06-23)

### Features

* **cli:** branded init flow — name prompt, spinners, install offer ([fcdfee4](https://github.com/anolilab/lunora/commit/fcdfee450b1ee26b1c9733c50919821dc13e79ed))
* **cli:** create-vite overlay init for SPA frameworks ([fd394c1](https://github.com/anolilab/lunora/commit/fd394c17583dea3059344c2c04188f8cee32e506))
* **cli:** extend the init feature offer beyond auth + email ([e3c4507](https://github.com/anolilab/lunora/commit/e3c4507889e3787b76c61214faacedc163cce5e5))
* **cli:** interactive template picker, ASCII title, non-interactive guard ([ac3f7f3](https://github.com/anolilab/lunora/commit/ac3f7f3c0d2b3d8374a5ff4829810d3f54d60e0d))
* **cli:** offer analog and react-router in the init picker ([8da95b1](https://github.com/anolilab/lunora/commit/8da95b1769c3e759e7bf18a0ed616d9ec44f5fde))

### Bug Fixes

* **cli:** clearer non-interactive init error + tidy test name ([b477b26](https://github.com/anolilab/lunora/commit/b477b26d068d67b5669b025c0b3d0fd2fbff6d7b))
* **cli:** install dependencies as the last init step ([185108d](https://github.com/anolilab/lunora/commit/185108de3ac6138230e286e2d430fb1ecd0d32e8))
* fixed packem config ([633cfe6](https://github.com/anolilab/lunora/commit/633cfe6bb0a3c05e6b00607340013e957c0000bb))
* **templates:** conform vite-react template; stabilize cli deploy CI test ([39d7a0e](https://github.com/anolilab/lunora/commit/39d7a0eccfc8a98154e1a0c66d97956d3273a6ae))

### Documentation

* **cli:** design for the create-vite overlay init engine ([4d196dc](https://github.com/anolilab/lunora/commit/4d196dcf7cc19d560b62bbd40543960376d1942f))

### Code Refactoring

* **cli:** drop bespoke vite-react template, default to create-vite overlay ([bebf7e7](https://github.com/anolilab/lunora/commit/bebf7e7f3c47f3309a59377fb8e75299b1c503ab))

## @lunora/cli [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.4...@lunora/cli@1.0.0-alpha.5) (2026-06-22)

### Features

* **cli:** branded TUI wizard, spinners, searchable lists, all confirms ([4333e01](https://github.com/anolilab/lunora/commit/4333e01e4808d568a3115af4beae9d8f09562562))
* **cli:** rebuild the vite template into a working realtime starter ([ad9ec90](https://github.com/anolilab/lunora/commit/ad9ec907eb56ecebddd2b44f9f0344146258241a))
* **cli:** rich @visulima/tui prompts for init/add selection ([964c7ef](https://github.com/anolilab/lunora/commit/964c7efb02735bbf1d5ad2d5755e5d334cec1fb6))

### Bug Fixes

* **cli:** address thermos review of the TUI prompts ([4777356](https://github.com/anolilab/lunora/commit/47773569f2d6c1870729bde3b837a46a1b70e257))

### Code Refactoring

* **cli:** rename the vite template to vite-react ([05a0573](https://github.com/anolilab/lunora/commit/05a057371581cc7f10bf050f07325be2f71870aa))

## @lunora/cli [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.3...@lunora/cli@1.0.0-alpha.4) (2026-06-22)

### Bug Fixes

* **cli:** make scaffolded projects installable ([7f0d172](https://github.com/anolilab/lunora/commit/7f0d172f6629cc1ac836ea862206e1bab23ef9ff))

## @lunora/cli [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.2...@lunora/cli@1.0.0-alpha.3) (2026-06-22)

### Features

* **cli:** add --ref to init and registry commands ([ffe26aa](https://github.com/anolilab/lunora/commit/ffe26aa726babb9f587ac3403856fc35ce60e4f9))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))

### Code Refactoring

* remove dead code flagged by fallow ([be57eca](https://github.com/anolilab/lunora/commit/be57ecaf4d6f3bc95d7b1a5876305dfb2af80e45))

## @lunora/cli [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.1...@lunora/cli@1.0.0-alpha.2) (2026-06-22)

### Documentation

* fix homepage/cli scaffold command to lunorash@alpha ([8b69b5a](https://github.com/anolilab/lunora/commit/8b69b5af1ad8c2fd6f8bbc96292bc05cc067ffd7))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.2
* **@lunora/config:** upgraded to 1.0.0-alpha.2
* **@lunora/d1:** upgraded to 1.0.0-alpha.2

## @lunora/cli 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Styles

* format source with prettier and ignore generated artifacts ([c63b52a](https://github.com/anolilab/lunora/commit/c63b52a05578b8476cf627babe246acd9730c0f9))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))

### Build System

* **deps:** update @visulima/* packages to latest alpha ([b1c1f14](https://github.com/anolilab/lunora/commit/b1c1f140f79b1804c12ea4e4b08b3ebe5d3e39ef))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.1
* **@lunora/config:** upgraded to 1.0.0-alpha.1
* **@lunora/container:** upgraded to 1.0.0-alpha.1
* **@lunora/d1:** upgraded to 1.0.0-alpha.1
* **@lunora/seed:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.1
* **@lunora/studio:** upgraded to 1.0.0-alpha.1
* **@lunora/values:** upgraded to 1.0.0-alpha.1
