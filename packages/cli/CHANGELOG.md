## @lunora/cli [1.0.0-alpha.222](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.221...@lunora/cli@1.0.0-alpha.222) (2026-09-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.156
* **@lunora/config:** upgraded to 1.0.0-alpha.189
* **@lunora/seed:** upgraded to 1.0.0-alpha.106
* **@lunora/testing:** upgraded to 1.0.0-alpha.145

## @lunora/cli [1.0.0-alpha.221](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.220...@lunora/cli@1.0.0-alpha.221) (2026-09-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.154
* **@lunora/config:** upgraded to 1.0.0-alpha.188
* **@lunora/container:** upgraded to 1.0.0-alpha.42
* **@lunora/mcp:** upgraded to 1.0.0-alpha.109

## @lunora/cli [1.0.0-alpha.220](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.219...@lunora/cli@1.0.0-alpha.220) (2026-09-03)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.108
* **@lunora/codegen:** upgraded to 1.0.0-alpha.153
* **@lunora/config:** upgraded to 1.0.0-alpha.187
* **@lunora/mcp:** upgraded to 1.0.0-alpha.108
* **@lunora/seed:** upgraded to 1.0.0-alpha.104

## @lunora/cli [1.0.0-alpha.219](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.218...@lunora/cli@1.0.0-alpha.219) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.107
* **@lunora/codegen:** upgraded to 1.0.0-alpha.152
* **@lunora/config:** upgraded to 1.0.0-alpha.186
* **@lunora/d1:** upgraded to 1.0.0-alpha.105
* **@lunora/mcp:** upgraded to 1.0.0-alpha.107
* **@lunora/runtime:** upgraded to 1.0.0-alpha.90
* **@lunora/seed:** upgraded to 1.0.0-alpha.103
* **@lunora/testing:** upgraded to 1.0.0-alpha.143

## @lunora/cli [1.0.0-alpha.218](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.217...@lunora/cli@1.0.0-alpha.218) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.106
* **@lunora/bindings:** upgraded to 1.0.0-alpha.47
* **@lunora/codegen:** upgraded to 1.0.0-alpha.151
* **@lunora/config:** upgraded to 1.0.0-alpha.185
* **@lunora/container:** upgraded to 1.0.0-alpha.41
* **@lunora/d1:** upgraded to 1.0.0-alpha.104
* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/mcp:** upgraded to 1.0.0-alpha.106
* **@lunora/runtime:** upgraded to 1.0.0-alpha.89
* **@lunora/seed:** upgraded to 1.0.0-alpha.102
* **@lunora/testing:** upgraded to 1.0.0-alpha.142

## @lunora/cli [1.0.0-alpha.217](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.216...@lunora/cli@1.0.0-alpha.217) (2026-09-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.150
* **@lunora/config:** upgraded to 1.0.0-alpha.184
* **@lunora/seed:** upgraded to 1.0.0-alpha.101
* **@lunora/testing:** upgraded to 1.0.0-alpha.141

## @lunora/cli [1.0.0-alpha.216](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.215...@lunora/cli@1.0.0-alpha.216) (2026-09-02)

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

* **@lunora/advisor:** upgraded to 1.0.0-alpha.105
* **@lunora/bindings:** upgraded to 1.0.0-alpha.46
* **@lunora/codegen:** upgraded to 1.0.0-alpha.149
* **@lunora/config:** upgraded to 1.0.0-alpha.183
* **@lunora/container:** upgraded to 1.0.0-alpha.40
* **@lunora/d1:** upgraded to 1.0.0-alpha.103
* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/mcp:** upgraded to 1.0.0-alpha.105
* **@lunora/runtime:** upgraded to 1.0.0-alpha.88
* **@lunora/seed:** upgraded to 1.0.0-alpha.100
* **@lunora/testing:** upgraded to 1.0.0-alpha.140

## @lunora/cli [1.0.0-alpha.215](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.214...@lunora/cli@1.0.0-alpha.215) (2026-09-01)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.104
* **@lunora/bindings:** upgraded to 1.0.0-alpha.45
* **@lunora/codegen:** upgraded to 1.0.0-alpha.148
* **@lunora/config:** upgraded to 1.0.0-alpha.182
* **@lunora/container:** upgraded to 1.0.0-alpha.39
* **@lunora/d1:** upgraded to 1.0.0-alpha.102
* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/mcp:** upgraded to 1.0.0-alpha.104
* **@lunora/runtime:** upgraded to 1.0.0-alpha.87
* **@lunora/seed:** upgraded to 1.0.0-alpha.99
* **@lunora/testing:** upgraded to 1.0.0-alpha.139

## @lunora/cli [1.0.0-alpha.214](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.213...@lunora/cli@1.0.0-alpha.214) (2026-09-01)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.103
* **@lunora/codegen:** upgraded to 1.0.0-alpha.147
* **@lunora/config:** upgraded to 1.0.0-alpha.181
* **@lunora/d1:** upgraded to 1.0.0-alpha.101
* **@lunora/mcp:** upgraded to 1.0.0-alpha.103
* **@lunora/runtime:** upgraded to 1.0.0-alpha.86
* **@lunora/seed:** upgraded to 1.0.0-alpha.98
* **@lunora/testing:** upgraded to 1.0.0-alpha.138

## @lunora/cli [1.0.0-alpha.213](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.212...@lunora/cli@1.0.0-alpha.213) (2026-09-01)

### ⚠ BREAKING CHANGES

* `ctx.scheduler.runAfter` and `runAt` resolve the bare job id
instead of `{ id, scheduledFor }`. Four gates — the type, the docs, the
platform contract and the generated surface — already said `Promise<string>`;
only `@lunora/scheduler` resolved an object, and the install is a cast, so
nothing caught the disagreement. `scheduler-host.ts` assembles the platform
contract's `ScheduledJob` from the instant it already computed, so no
information is lost. The one in-repo call site is updated.

`@lunora/ai`'s default model and embedding model were settable only through
options codegen does not thread, so an app could not change either. Both now
read `LUNORA_AI_DEFAULT_MODEL` / `LUNORA_AI_DEFAULT_EMBEDDING_MODEL` from
`env`, the seam codegen does thread, mirroring the existing
`LUNORA_AI_GATEWAY_*` convention; explicit options still win.

`SocketHost.idFor` is kept but its doc no longer claims the engine uses it to
reassociate a rehydrated socket — per-socket state is keyed on the handle
object and durable identity is the engine's own `connectionId`. It is the
conformance suite's identity oracle in 8 legs, which is a real consumer.

* fix(codegen): scan the worker entry so the security lints can fire

Five ERROR-level advisor lints could never fire. `listLunoraSourceFiles`
recurses only `lunora/`, but `createBrowser`, `createPayment` and
`createInboundEmailHandler` are called from the worker entry under `src/`,
so `discoverConfigCalls` found nothing and every lint keyed on it returned
clean regardless of the code. `mail_inbound_dispatch_without_verify`,
`payment_create_without_authorize`, `browser_allow_private_targets`,
`export_sink_misconfigured` and `browser_user_url_without_allowlist`'s
suppression arm are now live.

The fix is a second, explicitly-scoped walk rather than widening the
existing one: `listLunoraSourceFiles` also feeds `refreshCodegenProject`'s
add/remove reconciliation, which drops Project files under `lunoraDirectory`
that vanished from disk, so widening it globally would have changed that set
too. Only `config-calls.ts` and `export-sinks.ts` are switched over.

`apps/playground`'s inbound email handler declares no `verify`, so it now
produces a real ERROR advisory — which is the point, but it will surprise a
gate until it is fixed.

Also inert: the umbrella's `lunorash/flags/flagship` specifier was not in the
flagship provider set, so an app importing through the umbrella got no
binding inference; and `fsTool` never registered the sandbox dispatcher, so
declaring it produced an app whose tool had nothing to dispatch to.

`constraint_validator` is kept — `runAdvisor`, the lint and
`AdvisorTableSample` are all public API and the README's example is a caller
passing its own samples. What was false was the claim that the studio feeds
it: `LintContext.tableSamples` said the studio "reads up to the configured
row cap from each table via readTablePage", which nothing does. Building a
feeder needs a bounded-sample admin read that does not exist, so the docs now
state there is no shipped feeder rather than implying one.

The generated Drizzle schemas were documented nowhere despite
`@lunora/server/drizzle` existing as a published subpath whose own docs point
at them; they now have a section explaining the global/shard split.

* fix(templates): stop scaffolding insecure cookies and a shared rate-limit bucket

`templates/expo` set `AUTH_URL: "http://localhost:8787"` in wrangler's
`vars`, which is baked into the deployed Worker. better-auth derives
`useSecureCookies` from that URL, so every project scaffolded from this
template shipped session cookies without `Secure` in production. The value
moved to `.dev.vars.example`; unset, better-auth resolves per request and the
weak-secret guard throws. The README was actively instructing users to put it
in `vars`.

All 12 non-expo templates keyed their rate limiter
`(ctx) => ctx.auth.userId ?? "anon"`, so every unauthenticated caller shared
one bucket — one client could exhaust it for all of them. Now
`ctx.auth.userId ?? ctx.ip ?? "anon"`, verbatim from the advisor lint that
prescribes it. The hand-rolled inline limiter is replaced by the copy-in
`lunora/ratelimit/schema.ts`, whose `limits` map was previously dead config:
its only key was never read, so tuning it did nothing.

`templates/expo` had no `imports` map, so `lunora registry add` produced
files importing `#lunora/_generated/server.js` that could not resolve.

In examples: `auth-playground`'s document list claimed membership isolation
in a comment while reading every row for an organization the caller merely
named; the index now pins the equality prefix to the session's own ownerId.
A procedure context deliberately carries no raw Headers, so `getActiveMember`
is unreachable from a query — the doc says so and points at the httpAction
recipe rather than implying a check that cannot happen.

`blog`'s cron was documented but never wired: no `crons.ts`, no trigger, and
`scheduled()` was never exported, so it would have fired into nothing even
once declared. Its `drafts.save` patched any id the client sent, which is an
IDOR; it now re-reads and checks the author, returning an indistinguishable
NOT_FOUND. Its bare `Error` throws were becoming redacted 500s rather than
the 401s they read as. The unused `users` table carrying a `passwordHash`
column is gone — shipping a second, empty credential store teaches worse
than losing the `.global()` demo, and the README now points at `team-chat`
for that.

* fix(playground): take the message author from the verified identity

`lunora/mutators.ts` accepted `userId` as an argument and wrote it verbatim
as the author, so any caller could post as any user. It is publicly
dispatchable — codegen registers `mutators:sendMessage` and exposes it on the
`api` proxy — so this was not a local-only path. Fixed with the framework's
existing control, `owner: "userId"` on `defineMutator`, which requires a
verified identity, rejects a mismatched argument, and overwrites the column
before the authoritative impl runs.

The same path also bypassed `messages.send`'s rate limit and its 4096-char
cap by pushing an identical row through a second entry point; both now match.

`apps/studio` read `VITE_LUNORA_ADMIN_TOKEN` unconditionally, so a production
build inlined an admin bearer token into a shipped bundle. The neighbouring
`baseUrl` was already gated on `import.meta.env.PROD`; the token now sits
behind `import.meta.env.DEV`, which is statically false in a production
build, so the variable is never read and cannot be inlined.

The signed-upload content-type check ran only when the URL had pinned one,
so an unpinned URL accepted any content type — the guard is unconditional
now, and the e2e helper forwards `contentType` so it can still mint a usable
pinned PUT.

`seedKv` stays a public action deliberately. Making it internal was
considered and would have stranded it with no caller at all: the internal
gate reads `x-lunora-system`, set only by scheduler/cron/queue dispatch,
while the Studio runner and `lunora run --as` both re-enter through the
ordinary RPC path. It takes no caller input — fixed values at six fixed keys
— so the exposure is resetting demo data. The docstring records why, and
warns that a seeder writing caller-supplied keys must not copy the shape.

Deletes a 443-line throwaway spike the file itself labelled as such.

* docs: make the non-callable examples callable and correct the wrong claims

Nineteen snippets across the concept docs used the object form
`query({ args, handler })`, which is not callable — the same page set's
migration guide says so explicitly. Every one is now the chainable builder
form the code actually exposes.

The Hyperdrive recipes assigned `ctx.sql = …`, which does not work: the
facade is wired by codegen from the app's config, not assigned in a handler.
The caching page hand-rolled 110 lines of cache bookkeeping that
`defineActionCache` does in three.

Corrections where the prose was simply false: the payment integration
claimed 12 tables where it creates 5; the read-replica page described
fallback behaviour the implementation does not have; and the offline-first
page contradicted the `.meta()` documentation this round introduced.

`packages/hyperdrive`'s README documented "Tagged-template queries" and
"Unsafe / raw queries" sections for APIs that do not exist —
`fromPostgresJs()` returns a `SqlClient` whose only member is `query(text,
params)`; `.unsafe()` belongs to the raw postgres.js client it wraps.

`sdks/python`'s `stable_stringify` docstring was the last copy of the
"code-point order" claim; the sort is UTF-16 code-unit order, which its own
`_utf16_sort_key` already implemented correctly.

* fix(examples): sort the expo manifest after adding the imports map

The `imports` map that lets `lunora registry add` resolve
`#lunora/_generated/server.js` was inserted in the wrong position.
Key order is enforced by one CI job that nothing else covers.

* style(client): satisfy the lint rules the new code tripped

Mostly mechanical, but two are real changes rather than suppressions.

The deferred-close WebSocket double added for the teardown regression test
duplicated the shared one except for a single method, which sonarjs
correctly flagged twice. The shared double now takes a `deferClose` flag and
the copy is gone. Verified the test still fails with the teardown fix
reverted, so the consolidation kept its diagnostic power.

The offline-flush barrier chained off `.then()` without returning a value.
It is a sequencing barrier with nothing to pass along, so it is an async
IIFE now — no rule to satisfy, and it reads as what it is.

The stream drain discarded its chunks into an unused binding; it collects
them and asserts the torn-down stream yielded none, which is the property
the test is actually about.

The remaining jsdoc/no-secrets disables follow the convention already used
in `@lunora/advisor` and `@lunora/codegen`: intentional bullet lists, and
back-ticked identifiers in prose that the entropy heuristic reads as
credentials.

* docs(scheduler): correct the three places still destructuring the old return

`runAfter`/`runAt` resolve the bare job id now, so `const { id } = await
ctx.scheduler.runAfter(...)` binds `undefined`. The package README and the
`lunora-setup-scheduler` CLI skill both taught exactly that, and the skill
also stated the old `{ id, scheduledFor }` shape in prose.

These are the siblings of the call site that was already fixed —
`docs/index.mdx` was updated with the signature change and its neighbours
were not.

* style(server): drop the now-redundant casts on the middleware context

`validateArgs` already returns `Record<string, unknown>`, so the two
`parsed as Record<string, unknown>` assertions at the `withCallContext`
call sites became unnecessary once it took `parsed` directly.

* fix(client): model the browser's asynchronous close in the shared socket double

The double dispatched `close` synchronously inside `close()`, which no browser
does. That hid a whole class of teardown-ordering bug from all 148 tests using
it: `teardownConnection` clears `conn.socket` AFTER calling `close()`, so a
same-tick event still found the identity guard satisfied and reached
`handleDisconnect`. The teardown regression test added earlier in this branch
had to opt into deferred close to see its own bug — which left the unfaithful
behaviour as the default for everything else.

Deferred close is now the only behaviour. Flipping it turned four tests red,
and all four were the double's fault rather than the code's: `readyState` must
flip synchronously (a browser sets it before returning from `close()`) while
only the EVENT is deferred. Fixed there; 783 pass.

Verified the teardown regression test still fails with its fix reverted, so
consolidating on one double did not cost it its teeth.

Also from review:

- `resolveRunnableTargetOrThrow` was written twice — once in the CLI, once in
  the Vite plugin — with two hand-written messages that would drift. The
  predicate is a property of the driver registry, not of either tool, so
  `isRunnableTarget`/`runnableTargetIds` now live in `@lunora/config` beside
  `resolveTargetOrThrow`, whose own docblock already argued the Vite plugin
  needs the same guard. Both callers keep their own wording; neither keeps its
  own logic.

- `check-project-json-targets.js` floored only its TOTAL count, so a declared
  workspace group that exists but holds no members passed vacuously while its
  two sibling checks failed. Floored per group, on member directories rather
  than on `project.json` files — not every member has one, by design.

- `WORKER_ENTRY_ROOTS` claimed to mirror `@lunora/config`'s
  `WORKER_ENTRY_FALLBACKS` and does not. Kept separate deliberately — one picks
  THE entry file, the other decides what a security lint may see, and equal
  lists would be wrong for one of the two jobs — but the comment now says that
  instead of inviting the reader to assume equality.

- Two `{@link}` targets are qualified, which removes the need for the
  `jsdoc/no-undefined-types` half of a suppression.

* fix(client): restore follower subscribe, and reset backoff on a frame-less socket

Two regressions this branch introduced, both found by review.

**`crossTabSync` was broken for every follower tab.** `subscribe()` was added
to the leader-only guard on the reasoning that a follower's subscribe "reached
the server only when the leader happened to hold the same
`(fn, args, shardKey)`". That is not an accident — it is the mechanism. The
follower's registration is what puts a `SubscriptionState` in
`this.subscriptions`, and `onSubscriptionData` drops any broadcast whose key it
cannot find there. Guarding it did not make a silent failure loud; it made the
leader's entire broadcast path dead code and threw `NOT_IMPLEMENTED`
synchronously out of every `useQuery`, `useInfiniteQuery`, `@lunora/db`
collection and svelte `query` in every non-leader tab.

`subscribeShape`, `whisper*`, `setConnectionContext` and
`acquireConnectionContext` genuinely have no relay path and keep their throws.

The existing follower tests could not catch this: each calls `subscribe()`
without any other tab announcing leadership, so the client is still inside its
startup claim window and the guard never fires. The new test establishes the
leader FIRST, then subscribes, then asserts the broadcast is delivered —
re-adding the guard turns it red.

**A socket that receives no JSON frame never reset its reconnect backoff.**
Moving the reset off `onOpen` was right (an upgrade is accepted before the
credential is read, so resetting there turns a lapsed token into a storm), but
"first non-error frame" is unreachable for some clients: the server sends no ack
for the `connect` envelope, and the keepalive pong is a plain string answered by
the runtime without waking the DO, so `JSON.parse` rejects it before the reset.
A whisper sender, a presence-only client, or any `ensureSocket` warm-up with no
active subscription therefore doubled its delay on every blip with nothing ever
resetting it, parking a healthy connection at the 30s cap.

Surviving a 5s window is now the second proof of acceptance — a rejected
credential closes 4001 well inside it, and that path clears the timer. The test
covers both directions: a socket held open past the window reconnects at the
initial delay again, and one closed at 100ms does not.

**`apps/playground` could not build.** The worker-entry scan added earlier in
this branch makes `mail_inbound_dispatch_without_verify` fire on an inbound
handler that really does dispatch spoofable mail into a function running with
the admin bearer and RLS off. `vite build` fails unconditionally on an
ERROR-level advisory, and `lint:types` fails under CI only — which is why the
pre-flight gate run reported green. Added the `verify` gate the lint asks for:
DMARC pass, or SPF and DKIM both passing. Fails closed, since a `null` verdict
means the receiving MX stamped no `Authentication-Results` header at all.

* fix(codegen): type the emitted scheduler config so the compiler guards the install

The scheduler return type had drifted from `Promise<string>` across four gates
with nothing failing, and the fix earlier in this branch corrected the type
while leaving the mechanism intact: the emitted config field was
`(env) => unknown`, which forced `as SchedulerLike` at all four use sites and
made the compiler blind to exactly this class of drift. The field now carries
`SchedulerLike`, the casts are gone, and the next disagreement is a build
error. Golden fixtures and all 13 example `_generated` trees regenerated.

Also from review:

- The registry's new auth and target guards threw bare `Error`, which the
  templates commit in this same branch identified as becoming a redacted 500.
  An unauthenticated caller was told the server had faulted. They are coded
  now: `UNAUTHORIZED` for the auth gate, `BAD_REQUEST` for a malformed or
  non-`https:` URL, `FORBIDDEN` for a host outside the allowlist. The
  missing-binding throws stay bare — a misconfigured deployment IS a 500.

- `@lunora/container` telemetry is batched now, so nothing leaves the process
  until a timer elapses or `flush()` drains it. Every emit used to be its own
  POST, so an existing job that exits promptly without flushing went from
  reporting everything to reporting nothing. `flush()` is documented as
  required rather than as an optimisation, including the oldest-first drop at
  the item cap.

- `examples/auth-playground` memoised the init PROMISE, so one failed
  cold-start migration was replayed to every later request for the isolate's
  life with no path back. Cleared on failure so the next request retries.

- The SDK port-discovery gates treated every directory under `sdks/` except
  `smoke` as a port, so a stray `node_modules` or `.venv` would have failed
  both permanently on a difference that is not a missing port. Anchored on the
  README every real port ships. Demonstrated both ways: a stray directory no
  longer trips it, a genuine new port still does.

- `discoverSandboxUsage` drove its scan from `TOOL_FLAGS` but kept a
  hand-written conjunction for the early break; that is the third flag waiting
  to be forgotten, so it reads the table too.

- `registry/tsconfig.json`'s exclusion rationale had grown to a ~1,100-character
  JSON string — unwrappable, unreadable in review, unlintable. Moved to
  `registry/TYPECHECK.md` with a pointer left behind.

- Noted in `withCallContext`'s JSDoc that every builder procedure now receives a
  cloned context, not only those declaring `.meta()`.

* revert(codegen): keep the scheduler config field untyped, and record why

Typing the emitted `scheduler?: (env) => …` field as `SchedulerLike` — so the
compiler would guard the seam the `Promise<string>` drift slipped through —
does not compile. `@lunora/scheduler`'s public `Scheduler.runAfter`/`runAt` are
generic with a REQUIRED `args`, while `SchedulerLike` takes it optional, so a
function needing three parameters is not assignable to one callable with two.
Every app that calls `createScheduler` directly fails, `apps/playground` and
`examples/blog` among them.

So the `as SchedulerLike` cast was not a loose annotation over two agreeing
shapes; it was hiding a real incompatibility between the scheduler package's
public type and what the DO accepts. Reconciling those two signatures is the
fix, and it is an API change to `@lunora/scheduler` rather than a cast removal.

Reverted to `unknown`, with the exact cause written at the field so the next
reader learns why the cast is there instead of rediscovering it. The
`Promise<string>` correction itself stands — that was the actual defect.

Adds `isRunnableTarget` / `runnableTargetIds` to the `@lunora/config` snapshot.

* fix(client): keep the framework-called follower surfaces inert instead of throwing

A second review pass over the fixes the first one prompted. Its highest finding
is the same shape the branch keeps producing: the earlier commit un-guarded
`subscribe` because a follower's registration is what the leader's broadcast is
matched against, and stopped there. `acquireConnectionContext` and
`subscribeShape` are not app-level calls — all five `usePresence` adapters
(react, vue, svelte, solid, angular) call the first from a component effect, and
`@lunora/db`'s shape-backed `createCollection` calls the second from its sync
path. Neither is something an app can opt out of, so the guard threw
`NOT_IMPLEMENTED` out of an effect and unwound the entire tab to an error
boundary. Before this branch presence merely failed to update.

Both are inert on a follower now. The loud throw is kept for `whisper`,
`whisperSubscribe` and `setConnectionContext`, which no first-party package
calls — those are app code, which can handle a failure.

`@lunora/agent`'s inbound handler had the same call-site-vs-layer problem with
a security edge: it built `createInboundEmailHandler` with no `verify` and
`AgentEmailTarget` gave apps no way to add one, while its own header instructs
mappers not to trust `email.from`. A claimed message starts a durable run whose
tools execute RLS-bypassed, so the gate now runs before any mapper — the same
fail-closed DKIM/SPF/DMARC check the playground got. The advisor lint could
never have caught this: it scans user projects, not this repo's sources.

Also from the pass:

- `runnableTargetIds` repeated the predicate `isRunnableTarget` defines, five
  lines below it, in the commit whose purpose was removing that duplication.
  Both moved to `driver-registry.ts`, beside the registry they query rather than
  in the module that reads `lunora.json`, and `isRunnableTarget` answers `false`
  for an unregistered id instead of throwing.
- Three registry JSON files had every em dash rewritten to `—` and their
  arrays exploded by a serializer that was not the repo's Prettier, mangling
  user-facing `description` copy. Restored.
- The emitted `scheduler?:` docblock carried a ~600-character maintainer
  post-mortem into every user's `_generated/shard.ts`. One sentence there now;
  the explanation lives in `emit.ts` where maintainers read it.
- The SDK README marker added last round NARROWED the gate it was meant to
  protect: a new port shipping without a README was invisible to discovery AND
  absent from the list, so no drift fired. Replaced with an explicit ignore
  list — a non-port directory costs one deliberate line, anything else fails.
- `examples/auth-playground` still memoised a rejected promise if `buildAuth`
  threw, one line above the fix for exactly that.
- The browser item echoed the rejected hostname back to the caller, letting an
  authenticated caller enumerate `ALLOWED_RENDER_HOSTS` by probing. Logged
  server-side, generic to the client.
- `clearConnectionTimers` replaces three copies of the same clear block across
  two teardown paths, so a fourth timer cannot be half-remembered.
- Comment trimming where the prior review's "rationale as changelog" note
  applied again, and a `jsdoc/check-indentation` suppression deleted by removing
  the list that needed it.

* perf(server): skip the per-call context clone when no middleware can read it

CodSpeed flagged 15 regressed benchmarks on this branch, all in
`packages/server`, with `N=0: no .use (dispatch floor)` down 21.5% — a
procedure with no middleware at all. That is the tell: `withCallContext`
was cloning the dispatch context on every call, where the previous
`withMeta` cloned only when `.meta()` was declared.

`ctx.args` and `ctx.meta` exist for `.use()` steps to read; a handler already
receives `args` as its own parameter. So a procedure with no middleware and no
meta is handed the dispatch context unchanged.

Measured locally rather than inferred from the instruction-count delta:

  N=0 dispatch floor   3.06M -> 4.37M ops/s   (1.43x)
  empty args           3.06M -> 4.43M ops/s   (1.44x)
  single id arg        2.71M -> 4.04M ops/s   (1.49x)

Procedures that DO declare middleware still pay the clone, and that cost is
real — it is what makes `ctx.args` reach a `.use()` step, which is what fixed
`emailGateMiddleware` and `verifyTurnstileMiddleware` throwing FORBIDDEN on
every call. Prototype delegation would avoid the property copy, but
`@lunora/auth`'s own docs teach `next({ ctx: { ...ctx, … } })`, and a spread
drops inherited properties — so the full clone is required for correctness.

* test(vite): cover the runnable-target guard

Codecov put `packages/vite/src/index.ts` at 66% patch coverage: the guard
that stops `vite build --target node` running the Cloudflare pipeline had no
test at all. Verified the two positive cases fail with the guard reverted.

* ci: keep CodeRabbit under its file cap so it reviews the code at all

CodeRabbit skipped this PR entirely — "116 files, 16 over the limit of 100" —
so a change touching every package got no automated review. The cap counts
files that survive `path_filters`, and 44 of those were markdown.

Excluded two kinds that cost review budget without earning it:

- `**/CHANGELOG.md` — semantic-release writes them; reviewing generated
  release notes is noise.
- `**/docs/**` — the long-form prose docs under `packages/*/docs/` and
  `apps/docs/src/content/`.

That brings the reviewable set to 92. READMEs stay in deliberately: they are
what a user reads first, and a wrong snippet there costs the most — this
branch fixed several.

The trade is explicit. Prose review is worth less than code review, and the
previous setting bought neither: over the cap, CodeRabbit reviews nothing.
* `useFlag`, `useFlags`, `createFlag`, `createFlags` and `flag`/
`flags` no longer take a targeting `context`, and `FlagContext` is no longer
exported. Any call passing one was passing a value the server discarded.

`react-native.api.md` drifts too: it re-exports `@lunora/react` wholesale, so it
carried a `FlagContext` row nothing would think to look for.

* refactor(runtime): stop exporting four symbols nothing outside them uses

Audited as "dead exports". Only one was dead code; the other three have live
in-file callers, so it was the EXPORT that was unused, not the function — and
deleting them would have broken working paths. `readShardKey` is the only thing
that reads `?shardKey=` / `x-lunora-shard-key` for REST dispatch;
`exportShardTable` is what `exportShardRows` delegates to per table;
`hydrateDocsById` is the `IN (...)` hydration that keeps `computeRankPage` off
an N+1. All three are now module-private.

`DEFAULT_LOG_LIMIT` was genuinely dead: a public alias of the module-private
`DEFAULT_LIMIT = 500` that nothing read except one `{@link}`. Deleted, and the
`PipelineLogQuery.limit` doc states the default literally instead of linking a
symbol that no longer exists.

Also removes an unreachable diagnostic in the advisor command. It printed
"advisor evidence unavailable — codegen ran with linting disabled" when
`advisorContext` was undefined, which requires `CodegenOptions.lint` to be set —
and that option is set at 47 call sites, every one of them inside codegen's own
tests. No production caller passes it, so the branch could not run. Deleted
rather than given a `--no-lint` flag to justify it: a user running `lunora
advisor` wants the advisor evidence by definition. The option stays for library
callers.

* fix(codegen): gate `.commitOrdered()` against the target's capability matrix

`commitOrderedTables` was rated in every platform capability matrix and read by
nothing. A host rating it `unsupported` emitted the full `.commitOrdered()`
surface with no diagnostic and silently dropped the ordering guarantee — which
is the only thing that feature is.

Promoted to a real `PlatformSignals` entry, read off the same IR that already
feeds `globalTables`, so an unsupported rating now emits
`platform_unsupported_feature` at codegen time. The test fails without the
signal key wired in.

`@lunora/platform`'s docblock called this "the outstanding case"; it now records
that it was promoted, and that `memoryTables`, `objectStorageBackups` and
`objectStorageCdcArchive` remain unpromoted instances of the same shape — rated
in every matrix, consulted by nothing.

* fix(examples): re-bless the five schema baselines that reported deploy drift

`feedback-board`, `team-chat`, `kanban-board`, `chess` and `tanstack-start` all
call `.extend(ratelimit.extension)` but their committed
`lunora/.lunora-schema.json` had no `ratelimit_buckets`, so `lunora deploy`
reported drift on each. Refreshed through the documented path.

Two of them carried more than the ratelimit drift, and re-blessing accepts it:
`kanban-board` had a required `tasks.status`, `chess` had `games.drawOfferedBy`
and `lobbies.guestId` widening `string -> union`. Both were pre-existing and
breaking; naming them here beats letting them ride in silently.

`--update-schema-baseline` was reported as crashing with "Cannot read properties
of undefined (reading 'filter')". It does not, under any condition that could be
constructed — a refactor wrapped every reconcile step in try/catch, so a
TypeError there now surfaces as a warning rather than killing the command, and
the likely original home (`DeployDriver.provision`) is dead code no CLI path
calls. No speculative fix. What the path did lack was any coverage at all, so it
now has an end-to-end test: capture a baseline, age it into breaking drift,
assert `prepare` blocks, assert the flag re-blesses it. Neutering the flag turns
it red.

The rate-limit copy-in paths taught two names for one thing: `registry/ratelimit`
called its only bucket `default` while all 13 templates and all 9 example
schemas use operation-shaped names. Reconciled on `send`. `lunora init`'s overlay
was a third copy — and was internally inconsistent, emitting `default` while the
`LUNORA_MESSAGES` it writes alongside declared `send`.

`.lunora-schema.json` is now Prettier-ignored. `serializeSchemaSnapshot` writes
2-space and Prettier rewrites it to 4, so every re-bless produced a file that
failed `lint:prettier` until someone ran `--write`. The serializer owns that
format and cannot change: its exact output is the input to `hashSchemaSnapshot`,
which is a schema version's identity in the DO's `__lunora_schema_history`
ledger. Ignoring is safe because that hash is taken from the re-serialized
object, never from the file's bytes.

Docs: `plans/README.md` described a deleted playground prototype as a live spike
deliverable, and `protocol/README.md` documented the wire grammar without the
two fixture-schema additions that now drive all eight SDK suites — `reencoded`
(for shapes that are legitimately not fixed points of `encode(decode(x)) == x`)
and `rejected[]`. Two claims those additions falsified are corrected with them.

### Bug Fixes

* close the round-2 package audit findings across registry, protocol, client and CI ([#539](https://github.com/anolilab/lunora/issues/539)) ([e3dd702](https://github.com/anolilab/lunora/commit/e3dd70282af1aff606fe03a4ebd29c33d0029ce5)), closes [#540](https://github.com/anolilab/lunora/issues/540)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.102
* **@lunora/bindings:** upgraded to 1.0.0-alpha.44
* **@lunora/codegen:** upgraded to 1.0.0-alpha.146
* **@lunora/config:** upgraded to 1.0.0-alpha.180
* **@lunora/container:** upgraded to 1.0.0-alpha.38
* **@lunora/d1:** upgraded to 1.0.0-alpha.100
* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/mcp:** upgraded to 1.0.0-alpha.102
* **@lunora/runtime:** upgraded to 1.0.0-alpha.85
* **@lunora/seed:** upgraded to 1.0.0-alpha.97
* **@lunora/testing:** upgraded to 1.0.0-alpha.137

## @lunora/cli [1.0.0-alpha.212](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.211...@lunora/cli@1.0.0-alpha.212) (2026-08-31)

### Bug Fixes

* **codegen:** carry each drift change's remediation on the change union ([#535](https://github.com/anolilab/lunora/issues/535)) ([07b4db6](https://github.com/anolilab/lunora/commit/07b4db603b96ed5c8c675f6c39867da6f7ef8a88))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.145
* **@lunora/config:** upgraded to 1.0.0-alpha.179

## @lunora/cli [1.0.0-alpha.211](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.210...@lunora/cli@1.0.0-alpha.211) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.101
* **@lunora/bindings:** upgraded to 1.0.0-alpha.43
* **@lunora/codegen:** upgraded to 1.0.0-alpha.144
* **@lunora/config:** upgraded to 1.0.0-alpha.178
* **@lunora/d1:** upgraded to 1.0.0-alpha.99
* **@lunora/mcp:** upgraded to 1.0.0-alpha.101
* **@lunora/runtime:** upgraded to 1.0.0-alpha.84
* **@lunora/seed:** upgraded to 1.0.0-alpha.96
* **@lunora/testing:** upgraded to 1.0.0-alpha.136

## @lunora/cli [1.0.0-alpha.210](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.209...@lunora/cli@1.0.0-alpha.210) (2026-08-30)

### Bug Fixes

* **cli:** teach the linter about generated output from codegen, not just init ([#534](https://github.com/anolilab/lunora/issues/534)) ([79781e7](https://github.com/anolilab/lunora/commit/79781e7c86a583ee5bfe8f399cc071f486f7d208)), closes [#516](https://github.com/anolilab/lunora/issues/516)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.177
* **@lunora/mcp:** upgraded to 1.0.0-alpha.100
* **@lunora/runtime:** upgraded to 1.0.0-alpha.83

## @lunora/cli [1.0.0-alpha.209](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.208...@lunora/cli@1.0.0-alpha.209) (2026-08-30)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.100
* **@lunora/codegen:** upgraded to 1.0.0-alpha.143
* **@lunora/config:** upgraded to 1.0.0-alpha.176
* **@lunora/mcp:** upgraded to 1.0.0-alpha.99
* **@lunora/runtime:** upgraded to 1.0.0-alpha.82
* **@lunora/seed:** upgraded to 1.0.0-alpha.95
* **@lunora/testing:** upgraded to 1.0.0-alpha.135

## @lunora/cli [1.0.0-alpha.208](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.207...@lunora/cli@1.0.0-alpha.208) (2026-08-30)

### Code Refactoring

* **cli:** one pre-deploy pipeline, shared by prepare and deploy ([#529](https://github.com/anolilab/lunora/issues/529)) ([9242050](https://github.com/anolilab/lunora/commit/9242050be98fd9f7317af35e622cf16cb5ecfa09))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.142
* **@lunora/config:** upgraded to 1.0.0-alpha.175
* **@lunora/seed:** upgraded to 1.0.0-alpha.94
* **@lunora/testing:** upgraded to 1.0.0-alpha.134

## @lunora/cli [1.0.0-alpha.207](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.206...@lunora/cli@1.0.0-alpha.207) (2026-08-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.141
* **@lunora/config:** upgraded to 1.0.0-alpha.174
* **@lunora/mcp:** upgraded to 1.0.0-alpha.98
* **@lunora/runtime:** upgraded to 1.0.0-alpha.81

## @lunora/cli [1.0.0-alpha.206](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.205...@lunora/cli@1.0.0-alpha.206) (2026-08-29)

### Features

* **cli:** let dev be a participant — readiness signal + binding manifest ([#523](https://github.com/anolilab/lunora/issues/523)) ([5d2c2ab](https://github.com/anolilab/lunora/commit/5d2c2abc56878f9c884115c41731144f6a41fcca))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.99
* **@lunora/bindings:** upgraded to 1.0.0-alpha.42
* **@lunora/codegen:** upgraded to 1.0.0-alpha.140
* **@lunora/config:** upgraded to 1.0.0-alpha.173
* **@lunora/container:** upgraded to 1.0.0-alpha.37
* **@lunora/d1:** upgraded to 1.0.0-alpha.98
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/mcp:** upgraded to 1.0.0-alpha.97
* **@lunora/runtime:** upgraded to 1.0.0-alpha.80
* **@lunora/seed:** upgraded to 1.0.0-alpha.93
* **@lunora/testing:** upgraded to 1.0.0-alpha.133

## @lunora/cli [1.0.0-alpha.205](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.204...@lunora/cli@1.0.0-alpha.205) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.139
* **@lunora/config:** upgraded to 1.0.0-alpha.172
* **@lunora/d1:** upgraded to 1.0.0-alpha.97
* **@lunora/mcp:** upgraded to 1.0.0-alpha.96

## @lunora/cli [1.0.0-alpha.204](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.203...@lunora/cli@1.0.0-alpha.204) (2026-08-28)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.98
* **@lunora/bindings:** upgraded to 1.0.0-alpha.41
* **@lunora/codegen:** upgraded to 1.0.0-alpha.138
* **@lunora/config:** upgraded to 1.0.0-alpha.171
* **@lunora/container:** upgraded to 1.0.0-alpha.36
* **@lunora/d1:** upgraded to 1.0.0-alpha.96
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/mcp:** upgraded to 1.0.0-alpha.95
* **@lunora/runtime:** upgraded to 1.0.0-alpha.79
* **@lunora/seed:** upgraded to 1.0.0-alpha.92
* **@lunora/testing:** upgraded to 1.0.0-alpha.132

## @lunora/cli [1.0.0-alpha.203](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.202...@lunora/cli@1.0.0-alpha.203) (2026-08-28)

### Bug Fixes

* **cli,docs:** close three gaps in codegen's contract with the build ([#521](https://github.com/anolilab/lunora/issues/521)) ([b38067a](https://github.com/anolilab/lunora/commit/b38067a82f1931a2e1d9fecd399ad091d25a161c))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.170

## @lunora/cli [1.0.0-alpha.202](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.201...@lunora/cli@1.0.0-alpha.202) (2026-08-28)

### Bug Fixes

* **codegen:** close eight silent-drop gaps in procedure discovery ([#513](https://github.com/anolilab/lunora/issues/513)) ([e393e49](https://github.com/anolilab/lunora/commit/e393e494c0145ad78e0f2b1e27798ed96e7039a3))


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.97
* **@lunora/codegen:** upgraded to 1.0.0-alpha.137
* **@lunora/config:** upgraded to 1.0.0-alpha.169
* **@lunora/d1:** upgraded to 1.0.0-alpha.95
* **@lunora/mcp:** upgraded to 1.0.0-alpha.94
* **@lunora/seed:** upgraded to 1.0.0-alpha.91
* **@lunora/testing:** upgraded to 1.0.0-alpha.131

## @lunora/cli [1.0.0-alpha.201](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.200...@lunora/cli@1.0.0-alpha.201) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.136
* **@lunora/config:** upgraded to 1.0.0-alpha.168

## @lunora/cli [1.0.0-alpha.200](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.199...@lunora/cli@1.0.0-alpha.200) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.135
* **@lunora/config:** upgraded to 1.0.0-alpha.167

## @lunora/cli [1.0.0-alpha.199](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.198...@lunora/cli@1.0.0-alpha.199) (2026-08-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.96
* **@lunora/bindings:** upgraded to 1.0.0-alpha.40
* **@lunora/codegen:** upgraded to 1.0.0-alpha.134
* **@lunora/config:** upgraded to 1.0.0-alpha.166
* **@lunora/d1:** upgraded to 1.0.0-alpha.94
* **@lunora/mcp:** upgraded to 1.0.0-alpha.93
* **@lunora/runtime:** upgraded to 1.0.0-alpha.78
* **@lunora/seed:** upgraded to 1.0.0-alpha.90
* **@lunora/testing:** upgraded to 1.0.0-alpha.130

## @lunora/cli [1.0.0-alpha.198](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.197...@lunora/cli@1.0.0-alpha.198) (2026-08-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.95
* **@lunora/codegen:** upgraded to 1.0.0-alpha.133
* **@lunora/config:** upgraded to 1.0.0-alpha.165
* **@lunora/seed:** upgraded to 1.0.0-alpha.89
* **@lunora/testing:** upgraded to 1.0.0-alpha.129

## @lunora/cli [1.0.0-alpha.197](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.196...@lunora/cli@1.0.0-alpha.197) (2026-08-27)

### Bug Fixes

* **codegen,cli:** generated output that compiles, refinements that don't abort the run, and a --no-codegen that takes effect ([#500](https://github.com/anolilab/lunora/issues/500)) ([8500289](https://github.com/anolilab/lunora/commit/85002899c3de93d87e0741869115d89199dfca97))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.132
* **@lunora/config:** upgraded to 1.0.0-alpha.164

## @lunora/cli [1.0.0-alpha.196](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.195...@lunora/cli@1.0.0-alpha.196) (2026-08-27)


### Dependencies

* **@lunora/advisor:** upgraded to 1.0.0-alpha.94
* **@lunora/codegen:** upgraded to 1.0.0-alpha.131
* **@lunora/config:** upgraded to 1.0.0-alpha.163
* **@lunora/d1:** upgraded to 1.0.0-alpha.93
* **@lunora/mcp:** upgraded to 1.0.0-alpha.92
* **@lunora/runtime:** upgraded to 1.0.0-alpha.77
* **@lunora/seed:** upgraded to 1.0.0-alpha.88
* **@lunora/testing:** upgraded to 1.0.0-alpha.128

## @lunora/cli [1.0.0-alpha.195](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.194...@lunora/cli@1.0.0-alpha.195) (2026-08-27)


### Dependencies

* **@lunora/d1:** upgraded to 1.0.0-alpha.92
* **@lunora/mcp:** upgraded to 1.0.0-alpha.91
* **@lunora/testing:** upgraded to 1.0.0-alpha.127

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
