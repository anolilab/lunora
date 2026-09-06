## @lunora/testing [1.0.0-alpha.148](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.147...@lunora/testing@1.0.0-alpha.148) (2026-09-05)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.90
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.53
* **@lunora/server:** upgraded to 1.0.0-alpha.104
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.57
* **@lunora/do:** upgraded to 1.0.0-alpha.120
* **@lunora/observability:** upgraded to 1.0.0-alpha.58

## @lunora/testing [1.0.0-alpha.147](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.146...@lunora/testing@1.0.0-alpha.147) (2026-09-05)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.89
* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/mail:** upgraded to 1.0.0-alpha.64
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.52
* **@lunora/server:** upgraded to 1.0.0-alpha.103
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.56
* **@lunora/do:** upgraded to 1.0.0-alpha.118
* **@lunora/observability:** upgraded to 1.0.0-alpha.57

## @lunora/testing [1.0.0-alpha.146](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.145...@lunora/testing@1.0.0-alpha.146) (2026-09-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.87
* **@lunora/mail:** upgraded to 1.0.0-alpha.63

## @lunora/testing [1.0.0-alpha.145](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.144...@lunora/testing@1.0.0-alpha.145) (2026-09-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.86

## @lunora/testing [1.0.0-alpha.144](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.143...@lunora/testing@1.0.0-alpha.144) (2026-09-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.85
* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/mail:** upgraded to 1.0.0-alpha.62
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.51
* **@lunora/server:** upgraded to 1.0.0-alpha.102
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.55
* **@lunora/do:** upgraded to 1.0.0-alpha.117
* **@lunora/observability:** upgraded to 1.0.0-alpha.56

## @lunora/testing [1.0.0-alpha.143](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.142...@lunora/testing@1.0.0-alpha.143) (2026-09-03)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.84
* **@lunora/server:** upgraded to 1.0.0-alpha.101
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.54
* **@lunora/do:** upgraded to 1.0.0-alpha.116
* **@lunora/observability:** upgraded to 1.0.0-alpha.55

## @lunora/testing [1.0.0-alpha.142](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.141...@lunora/testing@1.0.0-alpha.142) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.83
* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/mail:** upgraded to 1.0.0-alpha.61
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.50
* **@lunora/server:** upgraded to 1.0.0-alpha.100
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.53
* **@lunora/do:** upgraded to 1.0.0-alpha.115
* **@lunora/observability:** upgraded to 1.0.0-alpha.54

## @lunora/testing [1.0.0-alpha.141](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.140...@lunora/testing@1.0.0-alpha.141) (2026-09-02)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.82
* **@lunora/mail:** upgraded to 1.0.0-alpha.60

## @lunora/testing [1.0.0-alpha.140](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.139...@lunora/testing@1.0.0-alpha.140) (2026-09-02)

### ⚠ BREAKING CHANGES

* `lunora import` and `lunora backup restore` against a remote
URL now require `--yes`, as does `lunora seed --reset` off a TTY.
`lunora deploy --allow-schema-drift` no longer advances the schema baseline;
use `--update-schema-baseline` for that.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(protocol): close the wire-codec divergences the fixture never asserted

All eight non-JS ports accepted a map entry with MORE than two elements while
the reference rejects it, so `[["k","v","EXTRA"]]` threw in the JS client and the
Durable Object runtime and decoded to `Map{k→v}` everywhere else — two peers of
one deployment reading different values from identical bytes.

The cause is instructive: an earlier fix hardened the reference in both
directions and added only the too-short case to
`protocol/fixtures/wire-codec.json`. Every port was written against the fixture,
not against the reference, so the too-long half was never implemented. The
fixture is the contract, and it was incomplete.

So each divergence here is fixed fixture-first — add the entry, watch all eight
go red, then fix — which is both the repair and the permanent guard. Kotlin
turned out to have no map-entry check at all, and its rejection helper was
catching the resulting `ClassCastException` only by accident.

Also aligned: a typed-array payload whose byte length is not a multiple of its
element size is now rejected rather than handed back as raw bytes for the
consumer to misread; an unknown typed-array constructor name decodes to raw
bytes and drops the name, which is what the protocol README already specified
and only the reference did, and which matters because the name survived into
`stableWireKey` and therefore into subscription dedup; and duplicate map keys
collapse last-wins to match the reference. That last one was measured rather
than assumed — `Map.prototype.set` overwrites at the FIRST occurrence's position
and collapses under SameValueZero, so bigint keys merge while structurally equal
`Date` and bytes keys do not, and a second fixture case pins that half.

Python's decoder leaked `IndexError`, `TypeError` and `ValueError` out of a read
loop whose guard catches only `WireFormatError`, so one malformed frame killed
every subscription on the client — and on the built-in socket path it was
swallowed instead, leaving the query silently stale. Fixed at the source: the
decoder now raises only `WireFormatError`, and `_is_bigint_literal` no longer
uses Unicode-aware `str.isdigit()`, which accepted digits `int()` refuses. A
string `set`/`arr` payload decoded to a set of its characters — inventing data —
where the `map` branch in the same file already had the type guard its siblings
lacked; Ruby raised a `NoMethodError` its own assertion could not accept. Java
and Kotlin charged the WebSocket frame envelope against the value's depth
budget, so a value the reference legitimately encodes at the cap produced a
frame they refused.

Two reference behaviours are tightened rather than reproduced. A payload-less
`date` decoded `undefined` into an Invalid Date and re-encoded it as a NaN
timestamp, and a non-object `error` props slot ran `Object.keys` over a string
and produced `{0:"a",1:"b"}` where every port produced `{}`. Both are JS
accidents rather than contracts, both are shapes `encodeWire` never emits, and
every port already rejected them — so the reference now agrees with the ports
instead of eight languages reproducing the accident.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sql-store): store a global bigint in an order-preserving key

`v.bigint()` on a `.global()` table was stored as plain decimal text, so every
range filter, `ORDER BY`, page cursor and `MAX` over it compared
lexicographically. `where: { cents: { gt: 9n } }` returned ZERO rows while 10n
and 100n sat in the table, and `max` answered 9 for a set whose maximum was 100.
`=` stayed exact under both encodings, which is why nothing ever surfaced
loudly and five audit rounds went past it.

The shard plane solved this and says so in its own comment: "Plain decimal text
(`"10"`) is exact for `=` but sorts `"9"` after `"10"`, so ranges and `ORDER BY`
would silently return the wrong rows instead." Same schema, `.shardBy()`
correct, `.global()` wrong. That encoder is now exported and imported rather
than restated — a second copy of an order-preserving encoding is the thing that
drifts, and a cross-plane parity test compares the two answers row for row.

A backfill ships with it, because read-tolerance alone would be a NEW silent
break: with the format changed, `eq: 10n` binds the key and stops matching a row
written as `"10"`. The rewrite is keyset-paged and in-place, self-terminating
(its probe matches nothing on a converted table), and the decoder still reads
plain decimal text so no row is garbage mid-conversion. Reductions over a padded
key are refused with a typed error naming the aggregate index that answers them,
where `sum` past 2^53 previously escaped as a raw driver `RangeError`.

MySQL `.global()` tables inherited `utf8mb4_0900_ai_ci`, folding distinct values
together: `count` for tenant "Acme" answered 3 where two rows were "Acme" and
one "acme", `.unique()` rejected `alice@` against `Alice@`, and `rankPage`
partitioned by tenant returned another tenant's row. Every character column now
declares `utf8mb4_0900_bin` — column-level because a column's own collation
beats the connection's on every `column = 'literal'` comparison, and the `0900`
variant because `utf8mb4_bin` is PAD SPACE and would still disagree with SQLite
and Postgres on trailing whitespace. Pre-existing tables keep their collation;
`CREATE TABLE IF NOT EXISTS` cannot reshape one, so that is an operator `ALTER`,
documented in the dialect.

Three more: adding a field to an existing global table provisioned nothing and
every later insert died on `table p has no column named slug` — an untyped
driver message that never mentioned `lunora migrate` — while two siblings in the
same package already ALTER their own tables; `patch`/`replace`/`delete` ran
their compare-and-swap through `all`, which had no `onBookmark`, so D1's session
bookmark never advanced and read-your-writes was lost for exactly the write path
it exists for; and the admin import iterated only declared columns, so a field
renamed since the snapshot was dropped and reported as a clean success, where
the shard twin refuses the identical row.
* `v.bigint()` columns on `.global()` tables are re-encoded once,
automatically and in place, on the next migration. Values past 39 digits are now
refused with a typed `BAD_REQUEST` rather than mis-sorted. Existing MySQL tables
need `ALTER TABLE <t> CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
to pick up the collation fix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent): bound what a delegated run, a voice session and a retry can spend

An unauthenticated caller could start a run on another user's owned thread: both
owner guards read `owner !== undefined`, so a named stranger was refused and the
identity-less caller was not. That admits second-order prompt injection — the
injected row persists and is read into the model context on the victim's NEXT
turn, with the victim's tools — plus victim-billed inference and, under
`onConcurrentRun: "replace"`, termination of their in-flight run. The docblock
asserted the opposite ("the owner is immutable"), and the test that covered it
blessed the gap in its comment. The match is exact in both directions now: no
owner is an identity that owns nothing, not a wildcard.

`agent.asTool` had no depth bound. Each child gets a distinct thread key, so the
per-thread run-queue cap never applied across a delegation chain, and a
timed-out parent did not terminate its child — it reported "did not finish"
while the subtree kept growing and billing. Depth rides the run input; the
refusal is returned as the tool's answer rather than thrown, so the parent's
model answers with what it has instead of failing and retrying its durable step.

A voice session had no bound of any kind — no turn cap, no text-frame cap, and
an audio overflow that reset its own counter, so the utterance limit bounded
peak memory rather than throughput and never closed the socket. Voice turns also
ignored the agent's `compaction` config while text turns honoured it, on a
thread the two share, and the greeting was re-synthesised on every reconnect.
Turns, text length and audio are capped; wall-clock is not, deliberately — a
hibernating socket is not billed for time, and every paid action now is.

The scheduler's `recordRetry` wrote the time index while skipping every guard
`handleSchedule` enforces on the same value, two hundred lines below a comment
explaining that anything past 15 digits breaks the index's lexical ordering and
anything at 1e21 "would corrupt the index outright". A raised `maxAttempts`
walked the backoff ladder past both: the job sorted above every alarm bound and
was never dispatched again, then `parseInt` on the exponential form armed the
alarm at epoch millisecond 8 — permanently in the past, so the object re-woke
forever. Over-cap retries dead-letter now rather than firing at the cap, which
would park the job in year 33658 with no `/dead` row and nothing to act on.

A leaked workpool slot had no reset path in any shipped surface: `/status`
diagnosed the wedge perfectly and offered no way out. An admin release route
proxies the DO's existing `/complete`; a lease was the wrong shape, since it
would steal the slot of a job that is legitimately running long.

Also: `/list` and `/dead` are cursored and their clients walk every page, so a
dedupe check past 100 pending jobs stops silently scheduling duplicates and the
dead-letter panel stops hiding the backlog it exists to show; a cron trigger
that matches no registered key warns instead of reporting success; and a queue
message is only recorded as dead-lettered when a dead-letter queue exists.

One bad subscription used to abort an entire client reconnect — nothing
resubscribed, offline mutations never flushed, streams never resumed — while the
status still read `connected`. Args are encoded once at subscribe time, the way
the shape path already did it, and a decode failure reaches the subscription's
`onError` instead of escaping the socket listener. Subscribers are no longer
deduped by callback identity, so two consumers sharing one function reference
get two registrations rather than the first unsubscribe silently killing the
second.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(auth): key the rate limiter on a header the client cannot write

better-auth reads only `x-forwarded-for`, which Cloudflare does not set and any
client can send, and nothing in the repo configured otherwise. Every request
whose XFF was not exactly one bare IP collapsed onto a single shared bucket, so
three clients behind any proxy chain exhausted it and a fourth was denied
sign-in on its first attempt — at 3 requests per 10 seconds, app-wide. The same
package already refuses that header elsewhere as "attacker-chosen" and reads
`cf-connecting-ip` instead; the limiter now expresses that same policy through
better-auth's own configuration rather than a second one beside it.

Reading a header the client cannot write closes both directions of the hazard,
which matters because it was not possible to verify whether the edge appends to
a client-supplied XFF (shared-bucket denial of service) or replaces it (limiter
bypass). When no trustworthy IP resolves at all, a catch-all rule applies a
coarse global flood cap instead — a shared bucket cannot be sized for one
client, and dropping the limit discards the protection entirely.

A `javascript:` OAuth `redirectURI` reached `location.assign` in the auth app's
origin. The surrounding docblock argues correctly that the value is
authorization-server-vetted against registered redirect URIs — a claim about
HOST trust that says nothing about scheme.

A storage-rule table and a shape both gained a registration-time refusal rather
than a silent wrong answer. A `defineShape` over a `.memory()` table seeded once
and then never updated: the poke path replicates from the changelog and a memory
table is deliberately never appended to it, so the diff could not move. Making
memory tables pokeable is not implementable correctly — without the log nothing
records which keys LEFT, so a presence row for a departed user would survive on
the client forever — and the same root cause let the resume path vouch for a
table it has no record of, so a reconnecting client kept its pre-disconnect
state indefinitely. Both refuse now, and the docs page that promised live
queries "work exactly as they do on a durable one" says what is true.

A hard delete followed by a re-insert of the same id in one poke window emitted
no delta, because the changelog reports only the latest op per id and the
diff's never-replicated exemption assumed a sole op.

The remaining half is coverage for controls that had none. Deleting the RLS
filter from the legacy reader, or the masking from `.filter()`/`.first()`, left
the entire server suite green; so did removing the bulk-insert methods from the
writer guard's gated list. Those gaps are closed with tests proven RED by
mutation, and the gated-method list is now a `Record` over the writer interface,
so a new table-first method fails to compile until it is classified. The DO
admin read dispatch table was reachable but never driven by a test, leaving its
prototype-pollution guard with a permanently-dead branch. And the playground's
tests, excluded from CI as a hang, were a 15-second cold codegen against a
10-second local timeout — they run now.
* a `defineShape` over a `.memory()` table is refused at
subscribe with `SHAPE_MEMORY_TABLE`, and a read of a memory table marks its
subscription un-resumable. Both were previously silent wrong answers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(cli): keep the provisioned config in scope for the artifacts built from it

`lunora build --emit-bindings` handed an IaC deployer a manifest describing the
UN-provisioned config — the exact failure the function's own docblock says it
exists to prevent ("reading it earlier would describe the requirements the
project happened to have written down, not the ones the bundle actually has").
The dry-run rollback added last round restored the file before the artifact
steps ran, so a project with a declared nightly cron emitted `"crons": []` for
Terraform and the deployed worker never fired it. Two fixes in one branch
cancelled out. The rollback now belongs to whoever produces the last artifact,
so the manifest and the wrangler bundle are both built inside the provisioned
window.

`lunora add --from <dir>` skipped the untrusted-source confirmation that
`--source` triggers, and the same predicate was duplicated one file over, so
fixing only the reported site would still have written a files-only item
silently. One shared check covers both.

Registry output stripped C0/C1 controls but not the Unicode bidirectional
overrides that are the actual terminal-spoofing vector, and `JSON.stringify`
carried them through binding and env-var values regardless. There were also two
subtly different strippers in one directory, one citing the other; there is one
now, at the render boundary — deliberately not at parse time, because that
layer's output is WRITTEN to the user's manifests and it validates by rejection
rather than silent mutation.

Also: an export whose atomic rename failed left the complete plaintext dump in
its staging file; the `d1-to-hyperdrive` self-migration guard compared raw URLs,
so a trailing slash walked past it while both legs resolved to one worker; and
`lunora verify --format json` reported only the first platform diagnostic from
the documented CI gate.

A signed image URL decoded to a transform the signer never authorised: values
were not escaped, so a user-influenced `background` spliced new keys under a
valid signature. The sibling builder in the same directory already guarded this.
Escaping the separators fixes it without rejecting the legitimate overlay URLs
that guard would have refused.

Every live studio panel stopped streaming after an admin-token change: the
subscription effect omitted `client` from its deps under a comment claiming it
was provider-stable, while a docblock in the same file said the opposite. And
`vite build` continued after codegen threw, bundling the previous run's
generated output — the plugin failed the build on the softer signal (an ERROR
advisory) while the hard one was log-only.

Also in the studio: "Delete N matching" could send a predicate-free request
during the search debounce, because the button read the raw search box while the
request sent the debounced one — and the server accepted it as a full-table
delete, indistinguishable from `clearTable`. Both halves are closed. The
operation tape now names what a truncate or a restore actually targeted, the
"Apply index" button says Copy because that is what it does, and the flags
documented as making the studio "read-only" now say they hide controls, which is
all they ever did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: auto-review pull requests stacked on the audit branch

CodeRabbit only auto-reviews a pull request whose base branch is listed in
`reviews.auto_review.base_branches`; every other base gets a "Review skipped"
notice and a manual `@coderabbitai review` runs against an empty file set. The
audit fixes ship as one pull request per subsystem stacked on
`fix/audit-round-5` so each is a bounded, reviewable diff, which means that
branch has to be on the list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix: close the review findings on rounds 5-6

Sixteen review threads plus the two the description left open, each with a
regression test verified RED against the unfixed code.

The two open ones:

`.meta()` cleared the unbounded-string lint and enforces nothing. The
predicate matched source TEXT, so `.meta({ schema: { maxLength: 200 } })`
cleared it — and so did the bare substrings `length`/`max` anywhere in the
initializer: a comment, a nested field NAME, a default string. Detection is
now an AST walk over the validator chain, and the 132 call sites across
examples, templates and the registry that believed they were bounded now use
`.max(n)`, which emits the same JSON Schema fragment AND enforces it.
`v.string().max(<literal>)` is modelled in the AOT args compiler rather than
declining the node, so adding the bound the advisor asks for does not cost
the function its fast path; a repeated bound keeps the tighter one.

`describeObject` skipped the truncation every sibling branch applies. A JSON
body carrying its own `constructor` property is a plain object whose OWN
`constructor.name` is whatever was sent, so a client sized the validation
error it got back, and that lands in logs.

Also fixed:

- The staged export wrote at 0666-before-umask and was world-readable for the
  length of the dump.
- The registry display sanitiser passed LF through, so a manifest value could
  forge its own CLI output lines.
- The custom-source confirmation named `--source` when the resolver reads
  `--from`, asking the operator to confirm a place nothing read from.
- A voice control frame was JSON-parsed in full before its size was checked,
  so a 32MiB message was parsed once per frame on the DO's single thread.
- `cf-connecting-ip` was trusted off Cloudflare, where nothing sets it:
  rotate the header, get a fresh rate-limit bucket. Gated on the runtime;
  declared proxies still get `x-forwarded-for`.
- Import validation used `key in shape`, so a snapshot key named
  `constructor` read as declared and reached the writer unvalidated.
- A dead-letter park that got its row durable and then failed to clear the
  pending rows had its time-index claim restored, re-dispatching a job the
  dead-letter says is finished.
- A shape joining a `.memory()` relation target froze the same way a
  memory-backed shape table does; the walk now rejects both.
- A `staged: true` search index over an empty table refused every query
  forever, because nothing ever wrote its progress row.
- The bigint re-encoding pass scanned the whole table on every ctx-db — per
  request on a Hyperdrive binding — because completion was never recorded,
  and its length-only predicate skipped every negative 39-digit value,
  leaving one stored as decimal text that `eq` no longer matches.
- Studio's advisory-index metadata accepted `[null]`/`[42]` as fields, and
  its operation tape threw on a null import row before the RPC could
  validate it.
- Two docblocks in `value-codec.ts` described symbols that had moved out, so
  IDE hover attributed them to `sqliteEncode`.
- The `__agg_` companion is a DOUBLE, so it is exact per contribution, not
  per total; the aggregate refusal said otherwise.
- The CodeQL suppression named `js/unsafe-code-construction`; the alert is
  `js/bad-code-sanitization`.

`__lunora_*` tables are excluded from the studio table browser, and a
pre-existing `lint:types` failure in `@lunora/client`'s test is fixed.
* a `v.string().meta({ schema: { maxLength: n } })` never
bounded anything at runtime and now reads as unbounded to the
`unbounded_string_arg` lint. Replace it with `.max(n)`, which emits the same
schema fragment and enforces the length.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019dhrsvdiJJuDAMjmiKVrae

* test(client): type the dead-jobs fetch mock's request input

`fetch`'s input is `string | URL | Request`; the mock narrowed only the `URL`
case and called `.includes` on the rest, which fails `tsc` on the `Request`
member. Only a URL string can be substring-matched for the cursor.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: list every audit chain branch as a CodeRabbit base

Each audit-round group PR is based on the previous group's branch so the
reviewer sees one bounded diff; CodeRabbit auto-reviews only the bases on
this list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: run the lint, test and scan workflows for PRs based on fix branches

The audit fixes ship as a chain of pull requests, each based on the previous
`fix/*` branch so a reviewer sees one bounded diff. The lint, test, CodeQL and
dependency-review workflows only triggered for pull requests targeting the
release branches, so every PR in the chain was green with nothing but the
metadata checks. A `fix/**` base pattern runs the real gates for them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: run an app's codegen before its tests

The vis `test` and `test:coverage` targets depended only on upstream builds,
while the lint targets also depend on the app's own `codegen`. The playground's
`lunora/_generated` is gitignored, so a fresh CI checkout had none of it and
its tests failed on a missing module while passing locally, where the directory
already existed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: match any audit-chain branch as a CodeRabbit base

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* rounds 5-6 — session expiry, global bigint ordering, MySQL collation, agent bounds, CLI safety, SDK parity ([#544](https://github.com/anolilab/lunora/issues/544)) ([811de77](https://github.com/anolilab/lunora/commit/811de77004306ce4556a63b045628a9de2244202)), closes [#545](https://github.com/anolilab/lunora/issues/545)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.81
* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/mail:** upgraded to 1.0.0-alpha.59
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.49
* **@lunora/server:** upgraded to 1.0.0-alpha.99
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.52
* **@lunora/do:** upgraded to 1.0.0-alpha.114
* **@lunora/observability:** upgraded to 1.0.0-alpha.53

## @lunora/testing [1.0.0-alpha.139](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.138...@lunora/testing@1.0.0-alpha.139) (2026-09-01)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.80
* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/mail:** upgraded to 1.0.0-alpha.58
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.48
* **@lunora/server:** upgraded to 1.0.0-alpha.98
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.51
* **@lunora/do:** upgraded to 1.0.0-alpha.113
* **@lunora/observability:** upgraded to 1.0.0-alpha.52

## @lunora/testing [1.0.0-alpha.138](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.137...@lunora/testing@1.0.0-alpha.138) (2026-09-01)

### ⚠ BREAKING CHANGES

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests (#541)

### Bug Fixes

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests ([#541](https://github.com/anolilab/lunora/issues/541)) ([dfc2d4d](https://github.com/anolilab/lunora/commit/dfc2d4d07bf8f67214122dc7f14d83a9b1533d07))


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.79
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.47
* **@lunora/server:** upgraded to 1.0.0-alpha.97
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.50
* **@lunora/do:** upgraded to 1.0.0-alpha.112
* **@lunora/observability:** upgraded to 1.0.0-alpha.51

## @lunora/testing [1.0.0-alpha.137](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.136...@lunora/testing@1.0.0-alpha.137) (2026-09-01)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.78
* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/mail:** upgraded to 1.0.0-alpha.57
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.46
* **@lunora/server:** upgraded to 1.0.0-alpha.96
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.49
* **@lunora/do:** upgraded to 1.0.0-alpha.111
* **@lunora/observability:** upgraded to 1.0.0-alpha.50

## @lunora/testing [1.0.0-alpha.136](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.135...@lunora/testing@1.0.0-alpha.136) (2026-08-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.77
* **@lunora/mail:** upgraded to 1.0.0-alpha.56
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.95
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.48
* **@lunora/do:** upgraded to 1.0.0-alpha.110
* **@lunora/observability:** upgraded to 1.0.0-alpha.49

## @lunora/testing [1.0.0-alpha.135](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.134...@lunora/testing@1.0.0-alpha.135) (2026-08-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.76
* **@lunora/server:** upgraded to 1.0.0-alpha.94

## @lunora/testing [1.0.0-alpha.134](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.133...@lunora/testing@1.0.0-alpha.134) (2026-08-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.75

## @lunora/testing [1.0.0-alpha.133](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.132...@lunora/testing@1.0.0-alpha.133) (2026-08-29)

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

* **@lunora/agent:** upgraded to 1.0.0-alpha.74
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/mail:** upgraded to 1.0.0-alpha.55
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.44
* **@lunora/server:** upgraded to 1.0.0-alpha.93
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.47
* **@lunora/do:** upgraded to 1.0.0-alpha.109
* **@lunora/observability:** upgraded to 1.0.0-alpha.48

## @lunora/testing [1.0.0-alpha.132](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.131...@lunora/testing@1.0.0-alpha.132) (2026-08-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.73
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/mail:** upgraded to 1.0.0-alpha.54
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.43
* **@lunora/server:** upgraded to 1.0.0-alpha.92
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.46
* **@lunora/do:** upgraded to 1.0.0-alpha.108
* **@lunora/observability:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.131](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.130...@lunora/testing@1.0.0-alpha.131) (2026-08-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.72
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.42
* **@lunora/server:** upgraded to 1.0.0-alpha.91
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.45
* **@lunora/do:** upgraded to 1.0.0-alpha.107
* **@lunora/observability:** upgraded to 1.0.0-alpha.46

## @lunora/testing [1.0.0-alpha.130](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.129...@lunora/testing@1.0.0-alpha.130) (2026-08-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.71
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.41
* **@lunora/server:** upgraded to 1.0.0-alpha.90
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.44
* **@lunora/do:** upgraded to 1.0.0-alpha.106
* **@lunora/observability:** upgraded to 1.0.0-alpha.45

## @lunora/testing [1.0.0-alpha.129](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.128...@lunora/testing@1.0.0-alpha.129) (2026-08-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.70
* **@lunora/server:** upgraded to 1.0.0-alpha.89

## @lunora/testing [1.0.0-alpha.128](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.127...@lunora/testing@1.0.0-alpha.128) (2026-08-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.69
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.88
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.43
* **@lunora/do:** upgraded to 1.0.0-alpha.105
* **@lunora/observability:** upgraded to 1.0.0-alpha.44

## @lunora/testing [1.0.0-alpha.127](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.126...@lunora/testing@1.0.0-alpha.127) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.42
* **@lunora/do:** upgraded to 1.0.0-alpha.103
* **@lunora/observability:** upgraded to 1.0.0-alpha.43

## @lunora/testing [1.0.0-alpha.126](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.125...@lunora/testing@1.0.0-alpha.126) (2026-08-26)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.41
* **@lunora/do:** upgraded to 1.0.0-alpha.102
* **@lunora/observability:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.125](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.124...@lunora/testing@1.0.0-alpha.125) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.68
* **@lunora/server:** upgraded to 1.0.0-alpha.87
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.40
* **@lunora/do:** upgraded to 1.0.0-alpha.101
* **@lunora/observability:** upgraded to 1.0.0-alpha.41

## @lunora/testing [1.0.0-alpha.124](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.123...@lunora/testing@1.0.0-alpha.124) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.67
* **@lunora/server:** upgraded to 1.0.0-alpha.86

## @lunora/testing [1.0.0-alpha.123](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.122...@lunora/testing@1.0.0-alpha.123) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.66
* **@lunora/server:** upgraded to 1.0.0-alpha.85

## @lunora/testing [1.0.0-alpha.122](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.121...@lunora/testing@1.0.0-alpha.122) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.65
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/mail:** upgraded to 1.0.0-alpha.53
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.39
* **@lunora/server:** upgraded to 1.0.0-alpha.84
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.39
* **@lunora/do:** upgraded to 1.0.0-alpha.100
* **@lunora/observability:** upgraded to 1.0.0-alpha.40

## @lunora/testing [1.0.0-alpha.121](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.120...@lunora/testing@1.0.0-alpha.121) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.64
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/mail:** upgraded to 1.0.0-alpha.52
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.38
* **@lunora/server:** upgraded to 1.0.0-alpha.83
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.38
* **@lunora/do:** upgraded to 1.0.0-alpha.99
* **@lunora/observability:** upgraded to 1.0.0-alpha.39

## @lunora/testing [1.0.0-alpha.120](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.119...@lunora/testing@1.0.0-alpha.120) (2026-08-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.63
* **@lunora/server:** upgraded to 1.0.0-alpha.82
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.37
* **@lunora/do:** upgraded to 1.0.0-alpha.98
* **@lunora/observability:** upgraded to 1.0.0-alpha.38

## @lunora/testing [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.118...@lunora/testing@1.0.0-alpha.119) (2026-08-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.62
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.81
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36
* **@lunora/do:** upgraded to 1.0.0-alpha.97
* **@lunora/observability:** upgraded to 1.0.0-alpha.37

## @lunora/testing [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.117...@lunora/testing@1.0.0-alpha.118) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.35
* **@lunora/do:** upgraded to 1.0.0-alpha.96
* **@lunora/observability:** upgraded to 1.0.0-alpha.36

## @lunora/testing [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.116...@lunora/testing@1.0.0-alpha.117) (2026-08-24)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.61
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.80
* **@lunora/do:** upgraded to 1.0.0-alpha.95

## @lunora/testing [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.115...@lunora/testing@1.0.0-alpha.116) (2026-08-23)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.60
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.79
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34
* **@lunora/do:** upgraded to 1.0.0-alpha.93
* **@lunora/observability:** upgraded to 1.0.0-alpha.34

## @lunora/testing [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.114...@lunora/testing@1.0.0-alpha.115) (2026-08-21)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.33
* **@lunora/do:** upgraded to 1.0.0-alpha.92
* **@lunora/observability:** upgraded to 1.0.0-alpha.33

## @lunora/testing [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.113...%40lunora%2Ftesting%401.0.0-alpha.114) (2026-08-19)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.91
* **@lunora/observability:** upgraded to 1.0.0-alpha.32

## @lunora/testing [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.112...%40lunora%2Ftesting%401.0.0-alpha.113) (2026-08-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.59
* **@lunora/mail:** upgraded to 1.0.0-alpha.51
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.34
* **@lunora/server:** upgraded to 1.0.0-alpha.78
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.90
* **@lunora/observability:** upgraded to 1.0.0-alpha.31

## @lunora/testing [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.111...%40lunora%2Ftesting%401.0.0-alpha.112) (2026-08-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.58
* **@lunora/server:** upgraded to 1.0.0-alpha.77
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30
* **@lunora/do:** upgraded to 1.0.0-alpha.89
* **@lunora/observability:** upgraded to 1.0.0-alpha.30

## @lunora/testing [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.110...%40lunora%2Ftesting%401.0.0-alpha.111) (2026-08-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.57
* **@lunora/server:** upgraded to 1.0.0-alpha.76

## @lunora/testing [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.109...%40lunora%2Ftesting%401.0.0-alpha.110) (2026-08-15)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.56
* **@lunora/server:** upgraded to 1.0.0-alpha.75
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29
* **@lunora/do:** upgraded to 1.0.0-alpha.88
* **@lunora/observability:** upgraded to 1.0.0-alpha.29

## @lunora/testing [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.108...%40lunora%2Ftesting%401.0.0-alpha.109) (2026-08-14)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.55
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/mail:** upgraded to 1.0.0-alpha.50
* **@lunora/server:** upgraded to 1.0.0-alpha.74
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28
* **@lunora/do:** upgraded to 1.0.0-alpha.86
* **@lunora/observability:** upgraded to 1.0.0-alpha.28

## @lunora/testing [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.107...%40lunora%2Ftesting%401.0.0-alpha.108) (2026-08-12)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.54
* **@lunora/mail:** upgraded to 1.0.0-alpha.49
* **@lunora/server:** upgraded to 1.0.0-alpha.73
* **@lunora/do:** upgraded to 1.0.0-alpha.85
* **@lunora/observability:** upgraded to 1.0.0-alpha.27

## @lunora/testing [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.106...%40lunora%2Ftesting%401.0.0-alpha.107) (2026-08-11)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.53
* **@lunora/server:** upgraded to 1.0.0-alpha.72
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27
* **@lunora/do:** upgraded to 1.0.0-alpha.84
* **@lunora/observability:** upgraded to 1.0.0-alpha.26

## @lunora/testing [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.105...%40lunora%2Ftesting%401.0.0-alpha.106) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26
* **@lunora/do:** upgraded to 1.0.0-alpha.83
* **@lunora/observability:** upgraded to 1.0.0-alpha.25

## @lunora/testing [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.104...%40lunora%2Ftesting%401.0.0-alpha.105) (2026-08-11)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.52
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/mail:** upgraded to 1.0.0-alpha.48
* **@lunora/server:** upgraded to 1.0.0-alpha.71
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25
* **@lunora/do:** upgraded to 1.0.0-alpha.82
* **@lunora/observability:** upgraded to 1.0.0-alpha.24

## @lunora/testing [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.103...%40lunora%2Ftesting%401.0.0-alpha.104) (2026-08-10)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.51
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.81
* **@lunora/observability:** upgraded to 1.0.0-alpha.23

## @lunora/testing [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.102...%40lunora%2Ftesting%401.0.0-alpha.103) (2026-08-10)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.50
* **@lunora/server:** upgraded to 1.0.0-alpha.70
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.80
* **@lunora/observability:** upgraded to 1.0.0-alpha.22

## @lunora/testing [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.101...%40lunora%2Ftesting%401.0.0-alpha.102) (2026-08-09)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.49
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/mail:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.68
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20
* **@lunora/do:** upgraded to 1.0.0-alpha.79
* **@lunora/observability:** upgraded to 1.0.0-alpha.20

## @lunora/testing [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.100...%40lunora%2Ftesting%401.0.0-alpha.101) (2026-08-09)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19
* **@lunora/do:** upgraded to 1.0.0-alpha.77
* **@lunora/observability:** upgraded to 1.0.0-alpha.18

## @lunora/testing [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.99...%40lunora%2Ftesting%401.0.0-alpha.100) (2026-08-09)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.48
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/mail:** upgraded to 1.0.0-alpha.44
* **@lunora/server:** upgraded to 1.0.0-alpha.67
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18
* **@lunora/do:** upgraded to 1.0.0-alpha.76
* **@lunora/observability:** upgraded to 1.0.0-alpha.17

## @lunora/testing [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.98...%40lunora%2Ftesting%401.0.0-alpha.99) (2026-08-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17
* **@lunora/do:** upgraded to 1.0.0-alpha.75
* **@lunora/observability:** upgraded to 1.0.0-alpha.16

## @lunora/testing [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.97...%40lunora%2Ftesting%401.0.0-alpha.98) (2026-08-08)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.96...%40lunora%2Ftesting%401.0.0-alpha.97) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.46
* **@lunora/server:** upgraded to 1.0.0-alpha.66
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16
* **@lunora/do:** upgraded to 1.0.0-alpha.73
* **@lunora/observability:** upgraded to 1.0.0-alpha.15

## @lunora/testing [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.95...%40lunora%2Ftesting%401.0.0-alpha.96) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.65
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.72
* **@lunora/observability:** upgraded to 1.0.0-alpha.14

## @lunora/testing [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.94...%40lunora%2Ftesting%401.0.0-alpha.95) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/mail:** upgraded to 1.0.0-alpha.43
* **@lunora/server:** upgraded to 1.0.0-alpha.64
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.14
* **@lunora/do:** upgraded to 1.0.0-alpha.71
* **@lunora/observability:** upgraded to 1.0.0-alpha.13

## @lunora/testing [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.93...%40lunora%2Ftesting%401.0.0-alpha.94) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.43
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/mail:** upgraded to 1.0.0-alpha.42
* **@lunora/server:** upgraded to 1.0.0-alpha.63
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.13
* **@lunora/do:** upgraded to 1.0.0-alpha.70
* **@lunora/observability:** upgraded to 1.0.0-alpha.12

## @lunora/testing [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.92...%40lunora%2Ftesting%401.0.0-alpha.93) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.91...%40lunora%2Ftesting%401.0.0-alpha.92) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.12
* **@lunora/do:** upgraded to 1.0.0-alpha.69
* **@lunora/observability:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.90...%40lunora%2Ftesting%401.0.0-alpha.91) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.41
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/mail:** upgraded to 1.0.0-alpha.41
* **@lunora/server:** upgraded to 1.0.0-alpha.62
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.68
* **@lunora/observability:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.89...%40lunora%2Ftesting%401.0.0-alpha.90) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.61

## @lunora/testing [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.88...%40lunora%2Ftesting%401.0.0-alpha.89) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.39
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/mail:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.60
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.67
* **@lunora/observability:** upgraded to 1.0.0-alpha.9

## @lunora/testing [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.87...%40lunora%2Ftesting%401.0.0-alpha.88) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.9
* **@lunora/do:** upgraded to 1.0.0-alpha.66
* **@lunora/observability:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.86...%40lunora%2Ftesting%401.0.0-alpha.87) (2026-08-03)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.8
* **@lunora/do:** upgraded to 1.0.0-alpha.65
* **@lunora/observability:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.85...%40lunora%2Ftesting%401.0.0-alpha.86) (2026-08-03)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.38
* **@lunora/server:** upgraded to 1.0.0-alpha.59

## @lunora/testing [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.84...%40lunora%2Ftesting%401.0.0-alpha.85) (2026-08-02)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.58
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.7
* **@lunora/do:** upgraded to 1.0.0-alpha.64
* **@lunora/observability:** upgraded to 1.0.0-alpha.6

## @lunora/testing [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.83...%40lunora%2Ftesting%401.0.0-alpha.84) (2026-08-02)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.57
* **@lunora/do:** upgraded to 1.0.0-alpha.62
* **@lunora/observability:** upgraded to 1.0.0-alpha.5

## @lunora/testing [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.82...%40lunora%2Ftesting%401.0.0-alpha.83) (2026-07-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.56
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.61
* **@lunora/observability:** upgraded to 1.0.0-alpha.4

## @lunora/testing [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.81...%40lunora%2Ftesting%401.0.0-alpha.82) (2026-07-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/mail:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.55
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.60
* **@lunora/observability:** upgraded to 1.0.0-alpha.3

## @lunora/testing [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.80...%40lunora%2Ftesting%401.0.0-alpha.81) (2026-07-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.54
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.59
* **@lunora/observability:** upgraded to 1.0.0-alpha.2

## @lunora/testing [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.79...%40lunora%2Ftesting%401.0.0-alpha.80) (2026-07-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.53
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.1
* **@lunora/do:** upgraded to 1.0.0-alpha.58
* **@lunora/observability:** upgraded to 1.0.0-alpha.1

## @lunora/testing [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.78...%40lunora%2Ftesting%401.0.0-alpha.79) (2026-07-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.56
* **@lunora/server:** upgraded to 1.0.0-alpha.52

## @lunora/testing [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.77...%40lunora%2Ftesting%401.0.0-alpha.78) (2026-07-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.55

## @lunora/testing [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.76...%40lunora%2Ftesting%401.0.0-alpha.77) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.54

## @lunora/testing [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.75...%40lunora%2Ftesting%401.0.0-alpha.76) (2026-07-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.30
* **@lunora/do:** upgraded to 1.0.0-alpha.53
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/mail:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.51

## @lunora/testing [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.74...%40lunora%2Ftesting%401.0.0-alpha.75) (2026-07-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.29
* **@lunora/mail:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.50

## @lunora/testing [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.73...%40lunora%2Ftesting%401.0.0-alpha.74) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.28
* **@lunora/mail:** upgraded to 1.0.0-alpha.34
* **@lunora/server:** upgraded to 1.0.0-alpha.49

## @lunora/testing [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.72...%40lunora%2Ftesting%401.0.0-alpha.73) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.27
* **@lunora/mail:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.48

## @lunora/testing [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.71...%40lunora%2Ftesting%401.0.0-alpha.72) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.26
* **@lunora/do:** upgraded to 1.0.0-alpha.52
* **@lunora/mail:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.70...%40lunora%2Ftesting%401.0.0-alpha.71) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.25
* **@lunora/mail:** upgraded to 1.0.0-alpha.31
* **@lunora/server:** upgraded to 1.0.0-alpha.46

## @lunora/testing [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.69...%40lunora%2Ftesting%401.0.0-alpha.70) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.51
* **@lunora/mail:** upgraded to 1.0.0-alpha.30
* **@lunora/server:** upgraded to 1.0.0-alpha.45

## @lunora/testing [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.68...%40lunora%2Ftesting%401.0.0-alpha.69) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.50
* **@lunora/mail:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.44

## @lunora/testing [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.67...%40lunora%2Ftesting%401.0.0-alpha.68) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.22
* **@lunora/mail:** upgraded to 1.0.0-alpha.28
* **@lunora/server:** upgraded to 1.0.0-alpha.43

## @lunora/testing [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.66...%40lunora%2Ftesting%401.0.0-alpha.67) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.21
* **@lunora/mail:** upgraded to 1.0.0-alpha.27
* **@lunora/server:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.65...%40lunora%2Ftesting%401.0.0-alpha.66) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.20
* **@lunora/mail:** upgraded to 1.0.0-alpha.26
* **@lunora/server:** upgraded to 1.0.0-alpha.41

## @lunora/testing [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.64...%40lunora%2Ftesting%401.0.0-alpha.65) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.19
* **@lunora/mail:** upgraded to 1.0.0-alpha.25
* **@lunora/server:** upgraded to 1.0.0-alpha.40

## @lunora/testing [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.63...%40lunora%2Ftesting%401.0.0-alpha.64) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.18
* **@lunora/mail:** upgraded to 1.0.0-alpha.24
* **@lunora/server:** upgraded to 1.0.0-alpha.39

## @lunora/testing [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.62...%40lunora%2Ftesting%401.0.0-alpha.63) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.17
* **@lunora/mail:** upgraded to 1.0.0-alpha.23
* **@lunora/server:** upgraded to 1.0.0-alpha.38

## @lunora/testing [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.61...%40lunora%2Ftesting%401.0.0-alpha.62) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.16
* **@lunora/do:** upgraded to 1.0.0-alpha.49
* **@lunora/mail:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.37

## @lunora/testing [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.60...%40lunora%2Ftesting%401.0.0-alpha.61) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.48
* **@lunora/mail:** upgraded to 1.0.0-alpha.21
* **@lunora/server:** upgraded to 1.0.0-alpha.36

## @lunora/testing [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.59...%40lunora%2Ftesting%401.0.0-alpha.60) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.14
* **@lunora/mail:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.35

## @lunora/testing [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.58...%40lunora%2Ftesting%401.0.0-alpha.59) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.13
* **@lunora/mail:** upgraded to 1.0.0-alpha.19
* **@lunora/server:** upgraded to 1.0.0-alpha.34

## @lunora/testing [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.57...%40lunora%2Ftesting%401.0.0-alpha.58) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.56...%40lunora%2Ftesting%401.0.0-alpha.57) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.12
* **@lunora/do:** upgraded to 1.0.0-alpha.46
* **@lunora/server:** upgraded to 1.0.0-alpha.33

## @lunora/testing [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.55...%40lunora%2Ftesting%401.0.0-alpha.56) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.32

## @lunora/testing [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.54...%40lunora%2Ftesting%401.0.0-alpha.55) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/mail:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.31

## @lunora/testing [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.53...%40lunora%2Ftesting%401.0.0-alpha.54) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.43

## @lunora/testing [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.52...%40lunora%2Ftesting%401.0.0-alpha.53) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.51...%40lunora%2Ftesting%401.0.0-alpha.52) (2026-07-23)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.9
* **@lunora/server:** upgraded to 1.0.0-alpha.30

## @lunora/testing [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.50...%40lunora%2Ftesting%401.0.0-alpha.51) (2026-07-22)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.49...%40lunora%2Ftesting%401.0.0-alpha.50) (2026-07-22)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.48...%40lunora%2Ftesting%401.0.0-alpha.49) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.37

## @lunora/testing [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.47...%40lunora%2Ftesting%401.0.0-alpha.48) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.36

## @lunora/testing [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.46...%40lunora%2Ftesting%401.0.0-alpha.47) (2026-07-21)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.6
* **@lunora/do:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.29

## @lunora/testing [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.45...%40lunora%2Ftesting%401.0.0-alpha.46) (2026-07-20)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.5
* **@lunora/do:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/mail:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.28

## @lunora/testing [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.44...%40lunora%2Ftesting%401.0.0-alpha.45) (2026-07-19)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.27

## @lunora/testing [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.43...%40lunora%2Ftesting%401.0.0-alpha.44) (2026-07-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.26

## @lunora/testing [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.42...%40lunora%2Ftesting%401.0.0-alpha.43) (2026-07-17)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.31
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/mail:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.25

## @lunora/testing [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.41...%40lunora%2Ftesting%401.0.0-alpha.42) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.30

## @lunora/testing [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.40...%40lunora%2Ftesting%401.0.0-alpha.41) (2026-07-13)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.1
* **@lunora/do:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.24

## @lunora/testing [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.39...%40lunora%2Ftesting%401.0.0-alpha.40) (2026-07-12)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.28

## @lunora/testing [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.38...%40lunora%2Ftesting%401.0.0-alpha.39) (2026-07-11)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.27
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/mail:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.23

## @lunora/testing [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.37...%40lunora%2Ftesting%401.0.0-alpha.38) (2026-07-10)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.22

## @lunora/testing [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.36...%40lunora%2Ftesting%401.0.0-alpha.37) (2026-07-08)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/mail:** upgraded to 1.0.0-alpha.13
* **@lunora/server:** upgraded to 1.0.0-alpha.21

## @lunora/testing [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.35...%40lunora%2Ftesting%401.0.0-alpha.36) (2026-07-08)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.20

## @lunora/testing [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.34...%40lunora%2Ftesting%401.0.0-alpha.35) (2026-07-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.18

## @lunora/testing [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.33...%40lunora%2Ftesting%401.0.0-alpha.34) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.24
* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/mail:** upgraded to 1.0.0-alpha.12
* **@lunora/server:** upgraded to 1.0.0-alpha.17

## @lunora/testing [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.32...%40lunora%2Ftesting%401.0.0-alpha.33) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.31...%40lunora%2Ftesting%401.0.0-alpha.32) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.30...%40lunora%2Ftesting%401.0.0-alpha.31) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.9

## @lunora/testing [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.29...%40lunora%2Ftesting%401.0.0-alpha.30) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.28...%40lunora%2Ftesting%401.0.0-alpha.29) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.27...%40lunora%2Ftesting%401.0.0-alpha.28) (2026-07-04)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.16

## @lunora/testing [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.26...%40lunora%2Ftesting%401.0.0-alpha.27) (2026-07-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.15

## @lunora/testing [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.25...%40lunora%2Ftesting%401.0.0-alpha.26) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.22
* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/mail:** upgraded to 1.0.0-alpha.6
* **@lunora/server:** upgraded to 1.0.0-alpha.14

## @lunora/testing [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.24...%40lunora%2Ftesting%401.0.0-alpha.25) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.21

## @lunora/testing [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.23...%40lunora%2Ftesting%401.0.0-alpha.24) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.13

## @lunora/testing [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.22...%40lunora%2Ftesting%401.0.0-alpha.23) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.19

## @lunora/testing [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.21...%40lunora%2Ftesting%401.0.0-alpha.22) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.18
* **@lunora/mail:** upgraded to 1.0.0-alpha.5
* **@lunora/server:** upgraded to 1.0.0-alpha.12

## @lunora/testing [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.20...%40lunora%2Ftesting%401.0.0-alpha.21) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.17

## @lunora/testing [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.19...%40lunora%2Ftesting%401.0.0-alpha.20) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.18...%40lunora%2Ftesting%401.0.0-alpha.19) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.17...%40lunora%2Ftesting%401.0.0-alpha.18) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.9

## @lunora/testing [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.16...%40lunora%2Ftesting%401.0.0-alpha.17) (2026-07-01)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.15...%40lunora%2Ftesting%401.0.0-alpha.16) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.13

## @lunora/testing [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.14...%40lunora%2Ftesting%401.0.0-alpha.15) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.12

## @lunora/testing [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.13...%40lunora%2Ftesting%401.0.0-alpha.14) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.12...%40lunora%2Ftesting%401.0.0-alpha.13) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.11...%40lunora%2Ftesting%401.0.0-alpha.12) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.9
* **@lunora/server:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.10...%40lunora%2Ftesting%401.0.0-alpha.11) (2026-06-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.9...%40lunora%2Ftesting%401.0.0-alpha.10) (2026-06-29)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.4
* **@lunora/server:** upgraded to 1.0.0-alpha.6

## @lunora/testing [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.8...@lunora/testing@1.0.0-alpha.9) (2026-06-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.7...@lunora/testing@1.0.0-alpha.8) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.6
* **@lunora/mail:** upgraded to 1.0.0-alpha.3
* **@lunora/server:** upgraded to 1.0.0-alpha.5

## @lunora/testing [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.6...@lunora/testing@1.0.0-alpha.7) (2026-06-27)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.2
* **@lunora/server:** upgraded to 1.0.0-alpha.4

## @lunora/testing [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.5...@lunora/testing@1.0.0-alpha.6) (2026-06-27)

### Features

* extending db  ([#32](https://github.com/anolilab/lunora/issues/32)) ([6b77a16](https://github.com/anolilab/lunora/commit/6b77a16996e6aa59c19c801c3ea18004deccd6dc))

### Documentation

* document ctx.now across server, testing, and the docs site ([04db307](https://github.com/anolilab/lunora/commit/04db30703beee17a322ff5dd6251f8f954232dcb))

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.5
* **@lunora/server:** upgraded to 1.0.0-alpha.3

## @lunora/testing [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.4...@lunora/testing@1.0.0-alpha.5) (2026-06-25)

### Features

* **testing:** expose ctx.now on harness ctx ([1038d55](https://github.com/anolilab/lunora/commit/1038d557a3b007b36657504479098b97003ca68d))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.2

## @lunora/testing [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.3...@lunora/testing@1.0.0-alpha.4) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.4

## @lunora/testing [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.2...@lunora/testing@1.0.0-alpha.3) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.3

## @lunora/testing [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.1...@lunora/testing@1.0.0-alpha.2) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.2

## @lunora/testing 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.1
* **@lunora/mail:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.1
