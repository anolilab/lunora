## @lunora/queue [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.47...@lunora/queue@1.0.0-alpha.48) (2026-09-06)

### ⚠ BREAKING CHANGES

* **observability,agent:** `SpanHandle.spanContext()` returns `SpanContextIds`
(`sampled` alongside the ids); `ctx.trace` accepts an optional fourth
`SpanIdentity` argument; `WorkerOptions.queue` receives a fourth `TriggerTrace`
argument, and codegen emits it.

The gates that hid all of this are rewritten to go through the real path: the
bridge suite drives the real span factory instead of a fake that echoed back
whatever id it was handed, and the agent suites drive `generateText`/`streamText`
against a mock model instead of invoking the telemetry hooks by hand.

Not fixed, deliberately: a `ctx.fetch` span still parents to the dispatch rather
than an enclosing `ctx.trace` (no ambient span stack in the DO profile) — the
docblock now says so instead of implying otherwise. The Sentry and Braintrust
model-call spans still end at time-to-first-byte on a streamed turn, because
their host span must wrap `execute()` to establish the parent context; both
docblocks now state it and point at the OTLP bridge.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(api): accept the span-identity and trigger-trace surface

The bridge now records under the id it publishes (SpanIdentity), SpanHandle
reports the propagated sampled bit (SpanContextIds), and a queue consumer accepts
the trigger's trace (TriggerTrace).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent): close every telemetry bridge at the real end of a call

The Sentry and Braintrust bridges wrapped `execute()`, which on a streamed turn
resolves the instant `doStream` hands the stream back. Both reported every
streamed generation as a ~1 ms, zero-token, always-OK call, and a stream that
died mid-way never reached a span at all.

Both now open the host span around `execute()` — still what parents the
provider's own work — but keep it open past it. Sentry uses `startSpanManual`
(present on every SDK built on `@sentry/core`, verified against 10.55.0) and ends
the span from the terminal event; Braintrust parks its `traced` callback on a
gate the terminal event releases, so the caller still gets `execute()`'s value
immediately while the span covers the whole generation. Usage is read off the
SDK's normalized end event, where a LanguageModelV4 provider's nested
`{ inputTokens: { total } }` has already been flattened.

The lifecycle all three share moves to `telemetry/in-flight-calls.ts`, and with
it two fixes:

- Aborts and errors now close the call they NAME. Every ai@7 terminal event
  carries the model call's `callId`, `onAbort` and `onError` included, but the
  close was indiscriminate — and a bridge built at module scope, which is the
  documented `defineAgent({ telemetry: { integrations: [...] } })` shape, shares
  one map across every concurrent run in the isolate. One run's barge-in
  reported a sibling's live generation as aborted and swallowed its real span.
- A stream that rejects outright dispatches no telemetry callback at all, so
  its entry was never removed and pinned the call's prompt for the life of the
  integration. Entries older than ten minutes are now swept on the next open.
  The contradictory claim that the map "cannot grow" is gone.

A throwing integration also no longer fails the user's tool. `traceToolExecution`
runs inside the tool's durable `step.do`, so a host SDK throwing in `executeTool`
made the step retry a tool that had already run, or report a successful one as
failed — against that function's own promise that telemetry is never flow
control. The tool's real outcome is recorded as it happens and always wins.

`SpanIdentity`'s two ids become required: the sole caller always passes both, and
`identity?:` already expresses "no adapter involved", so a partial object
type-checked and meant nothing.

The `version_metadata` object unwrap in `readerFromRecord` is keyed to
`CF_VERSION_METADATA` alone. Applied to any object-valued binding it would export
the internal `.id` of whatever a future probed key named as a resource attribute.

Every model-call test now drives the real SDK through `generateText`/`streamText`
rather than invoking the hooks by hand, which is what hid the streaming defect:
called directly, `execute()` resolves with a finished result and the span looks
perfect. Each new assertion was confirmed to fail against the pre-fix behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent): release swept calls and stop the wrapper deciding tool outcomes

Two findings from review, both real.

**The abandoned-call sweep dropped the record but stranded the resource.** A
swept entry was deleted without `onClose`, which is right — a span ending at
"whenever the next call started" is worse than none. But two bridges carry
something live in the host SDK: Sentry's `startSpanManual` span ends only when
someone ends it, and Braintrust's `traced` callback is parked on a gate the
terminal event releases. Dropping those entries left the span open and the
callback parked for the life of the isolate — the same leak the sweep exists to
prevent, one level down.

`createInFlightCalls` takes an `onEvict`, and each bridge releases its own
resource there without emitting anything. Both new tests fail without it
("expected undefined to be defined"). Writing the Braintrust one showed the
abandonment has to be modelled precisely: with an `execute()` that never
settles, the callback parks on `execute()` rather than on the gate, and nothing
can release it. The real shape is a stream handed back at first byte that then
dies — `execute()` resolves, the callback parks on the gate.

**A telemetry wrapper could decide a durable tool outcome.** The ai@7 contract
hands `executeTool` the tool's `execute` and trusts what it returns. This file
guarded a wrapper THROW, but not a wrapper that skips `execute` entirely or
returns a value of its own — so an integration could record a tool that never
ran, or replace its result, inside the durable `step.do`. That contradicts the
function's own promise that telemetry is never flow control.

The wrapper's return value and its rejection are now both discarded, and the
outcome is read from one memoized promise. Memoized rather than re-run: a
wrapper that starts `execute` without awaiting it leaves no trace by the time it
returns, and re-running would execute the tool twice. This also deletes the
`ran`/`failed` bookkeeping — the promise already carries both.

Five new cases; three fail against the previous flow (skip, replace, and the
un-awaited start), while reject-after-success and the tool's own failure already
behaved correctly.

Also suppress the secret scanner on a fixture `Bearer admin-token` in
`trigger-trace.test.ts`, matching how the e2e fixtures do it — `vis secrets`
reports clean.

464 agent tests, repo `lint:types`, `api:check` (54 snapshots) and `vis secrets`
all green.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(agent): floor the streamed-span assertions on the stream, not wall clock

CI failed with `expected 94 to be greater than 96` on the Sentry streamed-span
test. The assertion was `spanDuration > wallMs / 2`, but `wallMs` starts before
the span does — so a runner slow enough to spend ~98ms getting from the timer to
the first `doStream` call inflates the divisor past the span and the test fails
on scheduling alone, with nothing wrong.

All three bridge suites carried the same shape. Each now floors on the stream's
OWN delay budget, which the fixture makes knowable: `streamingModel` waits
`gapMs` per chunk, so `{ chunks: 3, gapMs: 30 }` is ~90ms regardless of how slow
the runner is getting there.

The floor still separates what it exists to separate. The defect being guarded is
a span closed when `execute()` resolves — the instant `doStream` hands the stream
back — which measured ~1ms. Verified by re-introducing exactly that close: the
streamed test fails again, along with three others.

464 agent tests pass; `eslint --max-warnings=0` clean (the constant sits above the
expect group rather than splitting it, which `vitest/padding-around-expect-groups`
flags).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* **observability,agent:** make the trace say what actually happened ([#618](https://github.com/anolilab/lunora/issues/618)) ([c07f788](https://github.com/anolilab/lunora/commit/c07f788836fb5724002a80a2031b88a033e304d0))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33

## @lunora/queue [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.46...@lunora/queue@1.0.0-alpha.47) (2026-09-05)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.27

## @lunora/queue [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.45...@lunora/queue@1.0.0-alpha.46) (2026-09-05)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32

## @lunora/queue [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.44...@lunora/queue@1.0.0-alpha.45) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/platform:** upgraded to 1.0.0-alpha.26

## @lunora/queue [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.43...@lunora/queue@1.0.0-alpha.44) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))

## @lunora/queue [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.42...@lunora/queue@1.0.0-alpha.43) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/platform:** upgraded to 1.0.0-alpha.25

## @lunora/queue [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.41...@lunora/queue@1.0.0-alpha.42) (2026-09-02)

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

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/platform:** upgraded to 1.0.0-alpha.24

## @lunora/queue [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.40...@lunora/queue@1.0.0-alpha.41) (2026-09-01)

### ⚠ BREAKING CHANGES

* `AuthLike.roles`, `TestIdentity.roles` and
`ShapeReadWhereRequest.roles` are removed. Roles come from the identity's
`roles` claim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(codegen): compare validator interiors in the schema drift gate

`FieldSnapshot` recorded only `kind` and `optional`, so the drift gate was
blind inside a validator. Repointing a foreign key from `v.id("users")` to
`v.id("orgs")`, swapping a union member, changing an array's element type,
adding `.unique()` or removing `.nullable()` all produced a byte-identical
snapshot: zero drift, same hash, and a deploy that proceeded onto data the
new schema rejects.

The snapshot now records `ref`, `literal`, `of`, `key`, `fields`, `members`,
`unique`, `nullable` and `refined`, and the classifier walks them recursively.
Changes are graded rather than blanket-breaking: `changedFieldShape` and
`addedFieldConstraint` are breaking and want a backfill, while widening a
type or relaxing a constraint is safe.

Union members are ordered canonically, so `v.union(a, b)` and `v.union(b, a)`
stay the same snapshot. Top-level `fields`, `indexes` and `relations` keys are
sorted too: declaration order was load-bearing on a hashed, ledger-recorded
file, so moving a field up a line reported drift and burned a schema history
slot for an edit that changed nothing.

Deepening the snapshot changes every existing schema's hash. Each shard
appends one history row on its next cold start, whose diff against its
predecessor is empty. `SCHEMA_SNAPSHOT_VERSION` is deliberately NOT bumped —
every new field is optional, so old baselines still parse, where a bump would
hard-reject every stored snapshot with no upgrade path. To stop an upgrade
drift-storm, each new dimension is only compared when the BASELINE recorded
it, so a pre-deepening baseline reports exactly the drift it did before and
one successful deploy re-blesses it.

The studio's schema-diff view had the same shallow comparison and rendered all
of the above as unchanged while the gate blocked them. It now routes each
field through the shared differ rather than holding a second opinion, and
renders column types via `describeShape`, so a repointed key no longer shows
`id` on both sides of a row flagged as changed. Its `CHANGE_SHAPE` map was
also missing the new change types — already a `tsc` failure, and at runtime a
throw that blanked the entire change list, so a migration containing one of
these showed the operator nothing at all.

`emit.ts` and the golden fixtures move together here: the emitted `resolveShape`
drops the `roles` field that the RLS change removed, and the fixtures capture
both that and the deeper snapshot, so splitting them would leave a commit whose
fixture tests fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* perf(shard-engine): index the default sort and bound keyset seeks

Every declared index was created over its fields alone, and no index existed
for the default `_creationTime` order at all. So the common reads sorted their
whole match set into a temp B-tree to return one page: an unfiltered page cost
a full table sort (3593.8us -> 15.9us with a `(_creationTime, id)` index, 226x
at 50k rows), and a filtered-and-ordered read over a declared index cost the
same over every row sharing the key. Declared indexes now carry
`(<fields>, _creationTime, id)`; unique indexes deliberately do not, since the
sort keys would change what the constraint constrains.

The ORDER BY omitted `_creationTime` between the declared fields and the `id`
tiebreak, which skips the index's middle column and defeats the index that now
exists. Fixed in `normalizeOrderKeys` rather than in the two ORDER BY builders,
because that is the single place both builders AND `buildSeek` read their key
list from — fixing only the builders would give the seek a different total
order than the sort it pages, which skips or repeats rows across a page
boundary.

SQLite will not drop an equality-pinned EXPRESSION from an ORDER BY, so an
index-aligned sort still built a temp B-tree even though the index is built in
exactly that order. Reads now drop the leading run of index fields their range
pins with `.eq()` — only the leading run, since a two-field index with one
field pinned still has to order by the second (32622.9us -> 57.4us, 568x).

The keyset seek's lexicographic OR gave the planner no range on any single
column, so it walked the index testing every row. A redundant leading-column
bound, ANDed on, hands the range back and the walk becomes a seek. It is gated
on a non-nullable leading key with a non-null pivot — exactly when the seek
emits a bare comparator — because the `OR col IS NULL` arm turns the conjunct
into a second disjunction and the planner drops the range again. Row-value
comparison is no help: SQLite does not apply its range optimisation to an
expression index, and every shard index is on `json_extract(...)`.

`buildSeek` is now nested rather than flattened. The flat expansion repeats the
prefix equalities in every disjunct and binds `k(k+1)/2` parameters; a bounded
page ANDs two seeks, so ten columns bound 110 against Workerd's per-statement
cap of 100 and the statement failed to prepare. Factoring the shared prefix out
is the same predicate at `2k-1`: 40 instead of 112. The `where` compiler's list
budget also now subtracts what the rest of the tree already spent, instead of
assuming a list is the only thing binding parameters.

`with: { rel: { limit: n } }` bounded the result but not the fetch: a page of
100 parents asking for 5 children each read every child of all 100 and threw
the rest away. A capped relation now fans out one bounded read per parent
(50,000 rows -> 600). That costs one read per parent, and on a D1-backed
fetcher each is a Workers subrequest against a hard per-request cap, so past 32
parents it falls back to the single batched read and slices. Both branches
return the same rows.

sql-store gets the sort keys too, except on MySQL: `id` is `VARCHAR(768)` there,
which is 3072 bytes — InnoDB's entire index key limit — so appending it to any
other column fails `CREATE INDEX` and takes the migration down. A prefix would
create but buy nothing, since MySQL cannot satisfy an ORDER BY from a prefixed
column. An existing SQLite database is re-provisioned when an index's shape
changes, since `CREATE INDEX IF NOT EXISTS` would otherwise no-op and leave the
fix inert on every deployment that already ran.
* the pagination cursor prefix moves from `~2` to `~3` and
in-flight cursors are rejected with a 400. Dropping `.eq()`-pinned fields
changes a `.withIndex(q => q.eq(f, v)).paginate()` cursor from `[v, id]` to
`[creationTime, id]` — the same length, so the seek's arity check cannot catch
it and the old payload would page against a `_creationTime` pivot holding a
channel id, silently and shaped like a correct page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): stop search answering from a half-built index

Two ways a search index served a confident, correctly-shaped, wrong answer.

An analyzer-profile change made `backfillSearchIndexPage` DELETE the whole FTS
companion before re-walking it, so the index was EMPTY for the entire duration
of the rebuild and every search over that table returned nothing. The re-walk
is DELETE-then-INSERT per row, so it converges in place instead: stale analysis
on a shrinking suffix beats no rows at all.

The sibling case is a NEWLY declared index over a table that already holds
rows. It covers a growing prefix (`id ASC`) while its backfill walks, and the
read queried the companion regardless — so a matching document past the cursor
was simply missing from a result set that looked complete. Reads now consult
`isSearchIndexComplete` and refuse.

Refusing rather than falling back to the LIKE scan is deliberate. That path has
no relevance index: it takes the newest `MAX_SEARCH_SCAN` candidate rows and
scores those, dropping older matches with no signal, and its own comment
justifies the approximation on the grounds that it never runs in a Durable
Object. The two partial answers are complementary — the backfill covers the
oldest prefix, the scan window the newest 1024 — so falling back would swap one
silent wrong answer for another on exactly the large tables the backfill is
paged for.

The refusal carries a new `SEARCH_INDEX_BUILDING` code rather than
`SERVICE_UNAVAILABLE`, whose catalog entry documents it as an upstream
dependency failing to respond. Nothing is down: one index on one table is
warming, and the backfill advances on every read, so a caller that retries
makes progress where a generic outage code invites it to back off.

One `__lunora_search_state` primary-key read per search call, placed after the
backfill page so it observes the progress that read just made, and never asked
per row or per hit. A table small enough to index in one page is complete from
its first migration and never reaches the branch.

Three existing tests asserted the partial behaviour, all on a `staged` index.
`staged` is an opt-in to ENTER the partial state; it does not make a partial
answer correct, and a staged index stopped mid-`maxPages` is the identical hole.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): keep data migrations and export round-trips truthful

A mid-batch failure re-applied the transform. The runner persisted the
page-start cursor, so a resume re-walked every row of the failed batch and ran
a non-idempotent transform (the `version + 1` shape) again over rows it had
already rewritten. The cursor now advances per row, and the counters increment
only once a row is fully handled, so the persisted state names the last
completed row rather than the last page.

The rewrite also lost concurrent writes. It ran off the page document, read up
to a whole batch of `await`s earlier, while `replace` compare-and-swaps only on
the snapshot it reads inside its own call — so a user mutation landing in that
gap was overwritten with the pre-mutation value, with no conflict and no error.
Each row is now re-read between the transform and the write, and the transform
re-applied against the fresh row up to three attempts before giving up. Failing
immediately would let one hot row abort a shard's run; skipping would leave
rows silently unmigrated.

A paused run could also never resume across the cursor prefix bump. The runner
mints its own cursor from a fixed key list that did not change, so the stored
payload is still valid and only its prefix is stale — but there is no reset
path, so every retry decoded the same dead cursor and failed again, with the
only escape being a full run in the opposite direction. The stale prefix is
restamped on the resume read alone, justified there by that key list being a
constant; the decoder itself stays strict, since a same-length page cursor is
exactly what it cannot afford to accept.

Export/import did not round-trip. `_commitSeq` rode into the import and was
rejected as an unexpected field; it is a per-shard counter, so replaying one
shard's numbering would break the monotonicity readers page on, and it is now
stripped so `insert` re-allocates it. An unset optional column also came back
as `null` instead of absent, contradicting its own declared type — fixed where
the row is decoded rather than at the import site, so every reader agrees, with
the import additionally normalising `null` so snapshots taken before this
restore.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(do): tear down socket state on error and bound what grows per shard

A Durable Object dispatches exactly ONE termination event per socket. On a
terminating exception it dispatches an error event, not a close one — so a
protocol error, an event timeout, or a `webSocketMessage` handler that threw
got `webSocketError` and never got `webSocketClose`. That handler rethrew and
tore nothing down, so the socket's shape-poke cursor row survived at its last
value and pinned op-log retention for the whole shard, permanently. It now
delegates to the close path with the 1006 shape the runtime synthesizes for
the disconnect half of the same branch, and logs rather than throws.

Relayed shape registrations were never released. A relay only detaches when it
loses its LAST socket, so every retired connection on a busy relay left a row
behind that kept the retention floor pinned at its cursor. Unsubscribing and
closing now release per socket, which covers the common case the detach never
reached. Cohort rows are deliberately untouched: they are keyed per shape, not
per socket, so no single connection may retire one.

`functionStats` grew without limit — one entry per distinct function path, on a
map that never evicted, so a shard accumulated them for its whole lifetime.
New paths are refused past a cap rather than evicting incumbents, matching the
argument the durable side already makes; the doc comment claiming a bound is
now true. The dedup GC's throttle stamp was written after the sweep it guards,
so a sweep that threw re-ran on every subsequent mutation instead of backing
off. Durable-stream runs now sweep expired state in a `finally`, so every
branch sweeps after its own work — sweeping first eats the transcript an
expired-but-replayable resume is about to read.

Sixteen unguarded `ws.send` calls under `webSocketMessage` threw on a socket
that had gone away mid-handler, and a throw there is fatal to the channel; they
now go through the guarded send. The stream loop's own sends are left alone,
since their throw is the loop-abort signal the enclosing catch consumes.

A queue message dropped for exceeding its retries vanished silently unless a
capture hook was configured, which is not the production shape; it is now
always logged with its id, queue and error. `restampIdentity` reported a
failure under the wrong operation and could lose the record entirely — it now
reports the operation that actually failed and re-appends under the original
stamp, making the docblock's claim true rather than aspirational.

The log and span ring buffers dropped entries with no signal, so a shard under
load showed a plausible-looking window with no indication anything was missing;
both now count drops and surface it on the admin reads. The OTLP batcher's
drop-oldest loop was audited for the same defect and is unreachable — it drains
at exactly its cap and reassigns synchronously before its first await — so it
keeps a comment saying it is a backstop and a test pinning that nothing is
dropped, rather than a counter that can only ever read zero.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* ci: cover shared/ in the generated-files filter

The `generated-files` job only runs when `files-changed` reports a match, and
the filter listed `packages/codegen/**` but nothing under `shared/`. Those files
are not a package — they are inlined into each consumer's bundle — so a change
confined to `shared/schema-snapshot.ts` reaches the `LUNORA_SCHEMA_SNAPSHOT`
literal in all 13 examples' generated output while the job is skipped and its
required check stays green. That is the same failure mode the filter's own
comment already describes one level up.

Also ignore `.netlify` for Prettier: it is a gitignored build output, so it only
exists in a checkout where the docs have been built, and then `lint:prettier`
fails on a bundle nobody wrote.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(codegen): regenerate example generated files

Deepening `FieldSnapshot` changes every schema's hash, so all 13 committed
`lunora/_generated/shard.ts` trees carry a stale `LUNORA_SCHEMA_SNAPSHOT`.
One line each, from `pnpm run lint:generated`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(server): restore middleware-contributed roles and read the singular claim

Deriving `auth.roles` from the identity claim alone silently disabled
`@lunora/cloudflare-access`. The Access envelope carries `groups`, never
`roles`, and `accessRoles()` exists precisely to map verified groups onto role
labels by setting `ctx.auth.roles` — which the claim-only path ignored. There
was no compile-time signal either, because that middleware declares its own
context type. A role-gated ALLOW branch stopped firing and Access users lost
rows they should see; a role-gated DENY branch stopped firing and rows LEAKED,
which is the defect the roles work set out to fix.

`AuthLike.roles` is back and the effective list is the union of the two
sources. What stays removed is the same field on the TEST harness: a middleware
setting `ctx.auth.roles` is a real request-path producer, while a test setting
it directly is a world with no producer at all, and that difference is the
whole point.

The claim reader also missed the shape the framework's own stack produces.
`@lunora/auth` mirrors better-auth's `admin()` plugin, which stores a multi-role
value comma-joined in a SINGULAR `role` column, so an app forwarding its user
record verbatim had a `role` claim and no `roles` claim. Both names are read
now. The emitted `resolveIdentity` returned `{ userId }` and nothing else, so
`.auth()` plus `rls(policies, { roles })` resolved to an empty list for every
app and all 13 examples while the docs said otherwise; it forwards `role` too.

The shape-read path is documented rather than changed. It has no middleware to
union with by construction, so an app deriving roles in middleware has them on
queries and not on live shapes. Closing that means moving the mapping onto the
identity, not adding a field the shape request has no producer for — and the
comment there claimed "same single source as the request path", which the union
makes false.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(server): guard every table's facade, not only the masked and policy ones

The mask where-scope guard and the RLS relation filter were both installed on
the wrapped writer, but each middleware re-bound only the tables it had a
policy for. The idiomatic per-table form therefore skipped both.

For masking: `mask({ users: { ssn } })` with a read on the UNMASKED `posts`
left `ctx.db.posts` on its raw binding, so `ctx.db.posts.findMany({ with: {
author: { where: { ssn } } } })` was served — the value oracle the guard was
written to close — and `relationMask` was absent too, so the masked column came
back in the clear. Every one of the guard's own tests used the flat
`ctx.db.findMany("posts", …)` form, which was guarded, so none of them could see
it.

For RLS the same narrow loop leaks rows rather than values: every wrapped read
threads `relationBaseWhere`, which is what applies a policy to `with`-hydrated
children, so `ctx.db.<nonPolicyTable>.findMany({ with: { <policyTable>: true }
})` reached the unwrapped writer with no relation filter and returned child
rows the policy exists to hide.

Both loops justified the exemption on the grounds that a `.global()` table's
facade entry is bound to the D1 writer and re-binding it would query the wrong
backend. That premise is false: codegen binds every table's entry through the
one shard ctx-db, `.global()` included, and says why — `createShardCtxDb` routes
global ops to D1 internally and stamps the subscription hooks, so binding a
global facade straight to `globalDb` would skip both. The exemption bought
nothing and cost a guard.

The two tests that pinned the old binding behaviour are rewritten, not deleted,
with the reason the previous expectation was wrong.

Also collapses the read guard, which was copy-pasted at three call sites, into
one helper — and states there why `count`/`aggregate`/`groupBy` deliberately get
less (none accepts an `orderBy` or a `with`, so there is no sort oracle and no
hop to walk), so the narrower scalar guard reads as a choice rather than an
omission.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* refactor: give the shared invariants one home each

Four places had grown a local copy of something that already had a canonical
owner, and the copies were not equivalent in consequence.

The relation-operator name set had four encodings, the newest of them inside a
security guard. That guard uses it to decide whether to DESCEND into a `where`
node, so an operator it does not know is a node it walks straight past — which
reopens the value oracle it exists to close, silently, on the new operator only,
with every existing test still green. The names now live in
`shared/relation-operators.ts`, which both `@lunora/server` guards and the
engine read; the engine's per-operator metadata is keyed by that union, so a
sixth name added on one side fails to compile rather than diverging.

The relay proxy key was built by hand at three sites — the write and two
reclamation paths, in two modules — with nothing enforcing that they agree. A
registration that is never reclaimed is exactly what pins op-log retention
forever, so a changed separator would reintroduce the leak the release path was
added to fix. One `relayProxyKey` now, beside the `shapeRoutingKey` whose
docblock already makes this argument.

`shapeForm` enumerated the interior keys it compares, so a dimension added to
`FieldSnapshot` and to the builder but forgotten there would be recorded and
never compared — a byte-identical diff over a changed shape, the exact bug the
snapshot deepening exists to catch, reintroduced one key at a time. It now
destructures the flags and compares the rest, which fails safe: a new interior
key is compared automatically, and a new flag over-reports until it is named.

The studio synthesised a one-field snapshot and ran the whole schema differ over
it, per field, to answer a boolean. `diffExistingField` is exported instead.

Also documents the invariant the relay release actually depends on — `subId`
unique per connection — rather than versioning the registration: clients mint
these monotonically and the key is scoped by connection, so a reused id is a
protocol violation whose blast radius is the offending client's own
subscription, and an incarnation field would have to reach every SDK's wire
format to buy a conforming client nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): make the fan-out budget a total, not a per-level cap

The capped-relation fan-out was bounded at 32 parents per level, with a comment
claiming that also contained the nesting — that a level-2 fan-out would see
`MAX_FANOUT_READS * cap` parents and so fall back to one batched read.

It does not. Each level-1 read resolves its own nested `with` inside its own
`fetcher` call, seeing only its own `cap` parents, comfortably under any
per-level threshold. So the levels multiply instead of falling back:
`with: { a: { limit: 5, with: { b: { limit: 5 } } } }` over 32 parents costs
32 + 160 reads, and a third level another 800 — against a Workers subrequest cap
of 1000 paid and 50 free, where exceeding it is a hard request failure rather
than a slow page. A per-level bound is exactly the shape that looks safe and
multiplies anyway.

The allowance is now carried in a `FanOutBudget` shared by every level of one
read, threaded the way `relationBaseWhere` already is and for the same stated
reason. Measured with the old bound in place, the two-level case above spends 60
reads where the budget holds it to 32.

`buildOrderClause` also stopped restating the tiebreak rule and reads it from
`normalizeOrderKeys` instead. That was the one place the "single source" claim
was untrue, and the two had already drifted: the hand-rolled version took the
tiebreak direction from the stage while `normalizeOrderKeys` derives it from
`tiebreakDirectionFor`, which agree only because a staged read happens to have a
uniform direction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): serve a rebuilding search index instead of refusing it

The search refusal conflated two states that deserve opposite answers, and in
doing so cancelled out the fix it shipped alongside.

Not wiping the companion on an analyzer-profile change was justified as "stale
analysis on a shrinking suffix beats no rows at all" — but completeness was
`planSearchBackfillPass(...).finished`, which is false for the WHOLE rebuild, so
the preserved rows were unreadable and every search 503'd until the re-walk
finished. On a large table that is thousands of reads' worth of refusals, and an
`ANALYZER_VERSION` bump became a fleet-wide search outage.

A NEW index covers a growing prefix, so a search over it returns a confidently
wrong subset and refusing is right. A REBUILDING index holds every row, just
some under the old analysis, and serving it is strictly better than a 503.

The two are only distinguishable at the instant of the profile flip: from the
rebuild's second page the state row is byte-identical to a new index mid-walk,
and keeping `done` set would make the plan report finished and stop the re-walk
half-analysed. So coverage is latched in the row that already exists — a
`covered` column written as `MAX(existing, done)`, seeded once from the rows
already completed, which is the upgrade path for indexes built before this
change. `planSearchBackfillPass` is untouched: sql-store DOES wipe on a profile
change, so an encoding that made a rebuild resumable cross-engine would make it
re-walk forever or serve an emptied index.

`staged` also refused forever on a table that had no rows to walk — the write
path had covered it from row one, so the operator backfill it directed you to
had nothing to do. Staged now skips only when there is something to skip.

The docs said a staged index makes a table "searchable progressively" and "only
finds documents written after the deploy". Both were false; they now state the
real contract and how an operator makes the index usable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(client): stop a throwing handler, a raw error and a close from losing state

Four separate ways a failure path made things worse than the failure.

`reportPersistenceError` called the app-supplied handler unguarded, and every
one of its call sites is either a `.catch()` on a floating promise or a
compensating cleanup whose remaining steps get skipped. In `rewriteStamp` that
costs data outright: the remove has already succeeded, so a handler that throws
skips the re-append and a reload before the next flush loses the mutation — the
exact window that function was added to close. Guarded at the definition, since
all eight callers share the exposure, falling through to the same warning so the
failure it was reporting stays visible.

The queue's drop log wrote the raw handler error to the Workers log. The reach
is narrower than it looks — the error is always branded — but `toDispatchError`
turns a non-envelope 4xx into an `INTERNAL` carrying the upstream's raw response
text, which is how a token in an upstream body reaches stdout. Routed through
the same redaction every other error-to-output path uses. Its wording was also
checked against the code rather than against the commit that described it: only
a deterministic 4xx reaches that line, retry exhaustion never does, so the
message now says so instead of sending an operator to a dead-letter queue the
message never entered.

`webSocketClose` rethrew a failed relay post. That post is documented
fire-and-forget, recoverable by the coarser detach and full-drain reclamation,
while a rejection out of a Durable Object close handler breaks the actor and
takes every other live socket on the shard with it — and there is nobody to hand
it to, since the socket is already gone and nothing retries a close. Both relay
posts log and swallow now, matching the `webSocketMessage` sibling and the
branch that already downgraded a relay failure to a log when a dispatch error
won.

The log and span ring buffers accepted any capacity above zero, so a fractional
one truncated to a ring of zero that evicted everything handed to it, and
`Infinity` removed the memory bound on a buffer that lives as long as the DO.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): never drop a unique index it cannot re-create

Re-declaring a UNIQUE index over different columns dropped the old one so the
new one could be created. If the table already held rows that are duplicates
under the NEW column list, the create then failed — after the drop — leaving the
table with no unique constraint at all. The failed migration re-runs on every
wake and fails the same way, so nothing closes the gap on its own.

Both engines now probe for those duplicates first and refuse, naming what has to
be de-duplicated, with the previous index left in force. There is a TOCTOU
window between the probe and the create; it is acceptable, because this runs at
provisioning time only when an index's declared fields actually changed, and
losing the race costs a failed migration rather than a silently unprotected
table.

Applied to both twins deliberately. They already carry the same catalog-parsing
logic, and a guard on one destructive DDL path but not the other is worse than
the duplication it avoids.

Also removes a docblock that was committed twice in `schema-drift.ts`, the first
copy orphaned above the second.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(shard-engine): keep the fan-out budget internal and unspent by empty reads

Three follow-ups on the budget and the search-coverage migration.

The budget was a field on `QueryArgs`, which is the caller's own query surface.
It is internal accounting that happens to need to cross the injected `fetcher`
boundary — as a public argument it reads as a knob, and its obvious value
(`{ remaining: Infinity }`) disables the subrequest bound and turns a slow read
into a failed one. It travels under a `Symbol.for` key now: unnameable in the
public type, absent from the API surface, and still able to ride the args object
to the next level. `Symbol.for` rather than `Symbol()` because a package can
appear twice in a dependency graph and `shared/` is inlined per bundle, so a
module-local symbol could be written by one copy and read by another.

A `limit: 0` relation charged the budget for reads it never issued: it is
answered without touching the database, but still subtracted one unit per parent
key, so a zero-limit relation could exhaust the allowance and push a LATER
capped relation onto the unbounded batched path — the over-fetch the budget
exists to bound. It now short-circuits before the accounting.

The `covered` backfill ran inside the same `try` as the `ALTER TABLE` that adds
the column, so it executed only on the single call that added it. If the process
stopped in between, or the update itself failed, every later call took the
ALTER's catch and skipped the backfill forever — leaving an index completed
before this build permanently marked uncovered, refusing every search for the
length of its next rebuild. The two are separate statements now, with the update
scoped `AND covered = 0` so it is a matchless no-op after the first pass rather
than a write on every migration call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* round 4 — RLS roles, mask oracle, schema drift depth, pagination indexes ([#542](https://github.com/anolilab/lunora/issues/542)) ([61c28eb](https://github.com/anolilab/lunora/commit/61c28eb650d97cdd9d427690fd275f5b0f011df7))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/queue [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.39...@lunora/queue@1.0.0-alpha.40) (2026-09-01)

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

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/platform:** upgraded to 1.0.0-alpha.23

## @lunora/queue [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.38...@lunora/queue@1.0.0-alpha.39) (2026-08-31)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.22

## @lunora/queue [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.37...@lunora/queue@1.0.0-alpha.38) (2026-08-29)

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

## @lunora/queue [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.36...@lunora/queue@1.0.0-alpha.37) (2026-08-28)

### Bug Fixes

* close nine copied-helper divergences across eight packages ([#522](https://github.com/anolilab/lunora/issues/522)) ([a2455bb](https://github.com/anolilab/lunora/commit/a2455bb0f58b9873633504c3f1e9bfeb44a5870e))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/platform:** upgraded to 1.0.0-alpha.20

## @lunora/queue [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.35...@lunora/queue@1.0.0-alpha.36) (2026-08-27)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.19

## @lunora/queue [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.34...@lunora/queue@1.0.0-alpha.35) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/platform:** upgraded to 1.0.0-alpha.18

## @lunora/queue [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.33...@lunora/queue@1.0.0-alpha.34) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/queue [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.32...@lunora/queue@1.0.0-alpha.33) (2026-08-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.17

## @lunora/queue [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.31...@lunora/queue@1.0.0-alpha.32) (2026-08-24)

### Bug Fixes

* **dispatch:** idempotent retries, real deadlines ([#455](https://github.com/anolilab/lunora/issues/455)) ([c92909a](https://github.com/anolilab/lunora/commit/c92909af851553f9b63cf5d1ad0844550fbc3cc0))

## @lunora/queue [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/queue@1.0.0-alpha.30...@lunora/queue@1.0.0-alpha.31) (2026-08-23)

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.15

## @lunora/queue [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.29...%40lunora%2Fqueue%401.0.0-alpha.30) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.14

## @lunora/queue [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.28...%40lunora%2Fqueue%401.0.0-alpha.29) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.13

## @lunora/queue [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.27...%40lunora%2Fqueue%401.0.0-alpha.28) (2026-08-15)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.12

## @lunora/queue [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.26...%40lunora%2Fqueue%401.0.0-alpha.27) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11

## @lunora/queue [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.25...%40lunora%2Fqueue%401.0.0-alpha.26) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10

## @lunora/queue [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.24...%40lunora%2Fqueue%401.0.0-alpha.25) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/queue [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.23...%40lunora%2Fqueue%401.0.0-alpha.24) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19
* **@lunora/platform:** upgraded to 1.0.0-alpha.9

## @lunora/queue [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.22...%40lunora%2Fqueue%401.0.0-alpha.23) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/queue [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.21...%40lunora%2Fqueue%401.0.0-alpha.22) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8

## @lunora/queue [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.20...%40lunora%2Fqueue%401.0.0-alpha.21) (2026-08-07)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.7

## @lunora/queue [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.19...%40lunora%2Fqueue%401.0.0-alpha.20) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/queue [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.18...%40lunora%2Fqueue%401.0.0-alpha.19) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/queue [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.17...%40lunora%2Fqueue%401.0.0-alpha.18) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6

## @lunora/queue [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.16...%40lunora%2Fqueue%401.0.0-alpha.17) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5

## @lunora/queue [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.15...%40lunora%2Fqueue%401.0.0-alpha.16) (2026-08-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.4

## @lunora/queue [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.14...%40lunora%2Fqueue%401.0.0-alpha.15) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/platform:** upgraded to 1.0.0-alpha.3

## @lunora/queue [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.13...%40lunora%2Fqueue%401.0.0-alpha.14) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11
* **@lunora/platform:** upgraded to 1.0.0-alpha.2

## @lunora/queue [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.12...%40lunora%2Fqueue%401.0.0-alpha.13) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/queue [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.11...%40lunora%2Fqueue%401.0.0-alpha.12) (2026-07-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.1

## @lunora/queue [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.10...%40lunora%2Fqueue%401.0.0-alpha.11) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/queue [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.9...%40lunora%2Fqueue%401.0.0-alpha.10) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/queue [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.8...%40lunora%2Fqueue%401.0.0-alpha.9) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/queue [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.7...%40lunora%2Fqueue%401.0.0-alpha.8) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/queue [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.6...%40lunora%2Fqueue%401.0.0-alpha.7) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/queue [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.5...%40lunora%2Fqueue%401.0.0-alpha.6) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/queue [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.4...%40lunora%2Fqueue%401.0.0-alpha.5) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/queue [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.3...%40lunora%2Fqueue%401.0.0-alpha.4) (2026-07-04)

## @lunora/queue [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.2...%40lunora%2Fqueue%401.0.0-alpha.3) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/queue [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fqueue%401.0.0-alpha.1...%40lunora%2Fqueue%401.0.0-alpha.2) (2026-07-02)

## @lunora/queue 1.0.0-alpha.1 (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)
