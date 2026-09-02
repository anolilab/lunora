## @lunora/vite [1.0.0-alpha.183](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.182...@lunora/vite@1.0.0-alpha.183) (2026-09-02)

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

* **@lunora/codegen:** upgraded to 1.0.0-alpha.149
* **@lunora/config:** upgraded to 1.0.0-alpha.183
* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/studio:** upgraded to 1.0.0-alpha.145

## @lunora/vite [1.0.0-alpha.182](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.181...@lunora/vite@1.0.0-alpha.182) (2026-09-01)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.148
* **@lunora/config:** upgraded to 1.0.0-alpha.182
* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/studio:** upgraded to 1.0.0-alpha.144

## @lunora/vite [1.0.0-alpha.181](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.180...@lunora/vite@1.0.0-alpha.181) (2026-09-01)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.147
* **@lunora/config:** upgraded to 1.0.0-alpha.181
* **@lunora/studio:** upgraded to 1.0.0-alpha.143

## @lunora/vite [1.0.0-alpha.180](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.179...@lunora/vite@1.0.0-alpha.180) (2026-09-01)

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

* **@lunora/codegen:** upgraded to 1.0.0-alpha.146
* **@lunora/config:** upgraded to 1.0.0-alpha.180
* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/studio:** upgraded to 1.0.0-alpha.142

## @lunora/vite [1.0.0-alpha.179](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.178...@lunora/vite@1.0.0-alpha.179) (2026-08-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.145
* **@lunora/config:** upgraded to 1.0.0-alpha.179

## @lunora/vite [1.0.0-alpha.178](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.177...@lunora/vite@1.0.0-alpha.178) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.144
* **@lunora/config:** upgraded to 1.0.0-alpha.178
* **@lunora/studio:** upgraded to 1.0.0-alpha.141

## @lunora/vite [1.0.0-alpha.177](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.176...@lunora/vite@1.0.0-alpha.177) (2026-08-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.177
* **@lunora/studio:** upgraded to 1.0.0-alpha.140

## @lunora/vite [1.0.0-alpha.176](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.175...@lunora/vite@1.0.0-alpha.176) (2026-08-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.143
* **@lunora/config:** upgraded to 1.0.0-alpha.176
* **@lunora/studio:** upgraded to 1.0.0-alpha.139

## @lunora/vite [1.0.0-alpha.175](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.174...@lunora/vite@1.0.0-alpha.175) (2026-08-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.142
* **@lunora/config:** upgraded to 1.0.0-alpha.175

## @lunora/vite [1.0.0-alpha.174](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.173...@lunora/vite@1.0.0-alpha.174) (2026-08-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.141
* **@lunora/config:** upgraded to 1.0.0-alpha.174
* **@lunora/studio:** upgraded to 1.0.0-alpha.138

## @lunora/vite [1.0.0-alpha.173](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.172...@lunora/vite@1.0.0-alpha.173) (2026-08-29)

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

### Features

* **cli:** let dev be a participant — readiness signal + binding manifest ([#523](https://github.com/anolilab/lunora/issues/523)) ([5d2c2ab](https://github.com/anolilab/lunora/commit/5d2c2abc56878f9c884115c41731144f6a41fcca))

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.140
* **@lunora/config:** upgraded to 1.0.0-alpha.173
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/studio:** upgraded to 1.0.0-alpha.137

## @lunora/vite [1.0.0-alpha.172](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.171...@lunora/vite@1.0.0-alpha.172) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.139
* **@lunora/config:** upgraded to 1.0.0-alpha.172
* **@lunora/studio:** upgraded to 1.0.0-alpha.136

## @lunora/vite [1.0.0-alpha.171](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.170...@lunora/vite@1.0.0-alpha.171) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.138
* **@lunora/config:** upgraded to 1.0.0-alpha.171
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/studio:** upgraded to 1.0.0-alpha.135

## @lunora/vite [1.0.0-alpha.170](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.169...@lunora/vite@1.0.0-alpha.170) (2026-08-28)

### Bug Fixes

* **cli,docs:** close three gaps in codegen's contract with the build ([#521](https://github.com/anolilab/lunora/issues/521)) ([b38067a](https://github.com/anolilab/lunora/commit/b38067a82f1931a2e1d9fecd399ad091d25a161c))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.170

## @lunora/vite [1.0.0-alpha.169](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.168...@lunora/vite@1.0.0-alpha.169) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.137
* **@lunora/config:** upgraded to 1.0.0-alpha.169
* **@lunora/studio:** upgraded to 1.0.0-alpha.134

## @lunora/vite [1.0.0-alpha.168](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.167...@lunora/vite@1.0.0-alpha.168) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.136
* **@lunora/config:** upgraded to 1.0.0-alpha.168

## @lunora/vite [1.0.0-alpha.167](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.166...@lunora/vite@1.0.0-alpha.167) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.135
* **@lunora/config:** upgraded to 1.0.0-alpha.167

## @lunora/vite [1.0.0-alpha.166](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.165...@lunora/vite@1.0.0-alpha.166) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.134
* **@lunora/config:** upgraded to 1.0.0-alpha.166
* **@lunora/studio:** upgraded to 1.0.0-alpha.133

## @lunora/vite [1.0.0-alpha.165](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.164...@lunora/vite@1.0.0-alpha.165) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.133
* **@lunora/config:** upgraded to 1.0.0-alpha.165
* **@lunora/studio:** upgraded to 1.0.0-alpha.132

## @lunora/vite [1.0.0-alpha.164](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.163...@lunora/vite@1.0.0-alpha.164) (2026-08-27)

### Bug Fixes

* **codegen,cli:** generated output that compiles, refinements that don't abort the run, and a --no-codegen that takes effect ([#500](https://github.com/anolilab/lunora/issues/500)) ([8500289](https://github.com/anolilab/lunora/commit/85002899c3de93d87e0741869115d89199dfca97))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.132
* **@lunora/config:** upgraded to 1.0.0-alpha.164

## @lunora/vite [1.0.0-alpha.163](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.162...@lunora/vite@1.0.0-alpha.163) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.131
* **@lunora/config:** upgraded to 1.0.0-alpha.163
* **@lunora/studio:** upgraded to 1.0.0-alpha.131

## @lunora/vite [1.0.0-alpha.162](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.161...@lunora/vite@1.0.0-alpha.162) (2026-08-26)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.162
* **@lunora/studio:** upgraded to 1.0.0-alpha.130

## @lunora/vite [1.0.0-alpha.161](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.160...@lunora/vite@1.0.0-alpha.161) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.130
* **@lunora/config:** upgraded to 1.0.0-alpha.161
* **@lunora/studio:** upgraded to 1.0.0-alpha.129

## @lunora/vite [1.0.0-alpha.160](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.159...@lunora/vite@1.0.0-alpha.160) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.129
* **@lunora/config:** upgraded to 1.0.0-alpha.160
* **@lunora/studio:** upgraded to 1.0.0-alpha.128

## @lunora/vite [1.0.0-alpha.159](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.158...@lunora/vite@1.0.0-alpha.159) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.128
* **@lunora/config:** upgraded to 1.0.0-alpha.159
* **@lunora/studio:** upgraded to 1.0.0-alpha.127

## @lunora/vite [1.0.0-alpha.158](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.157...@lunora/vite@1.0.0-alpha.158) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.127
* **@lunora/config:** upgraded to 1.0.0-alpha.158
* **@lunora/studio:** upgraded to 1.0.0-alpha.126

## @lunora/vite [1.0.0-alpha.157](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.156...@lunora/vite@1.0.0-alpha.157) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.126
* **@lunora/config:** upgraded to 1.0.0-alpha.157
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/studio:** upgraded to 1.0.0-alpha.125

## @lunora/vite [1.0.0-alpha.156](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.155...@lunora/vite@1.0.0-alpha.156) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.125
* **@lunora/config:** upgraded to 1.0.0-alpha.156
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/studio:** upgraded to 1.0.0-alpha.124

## @lunora/vite [1.0.0-alpha.155](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.154...@lunora/vite@1.0.0-alpha.155) (2026-08-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.124
* **@lunora/config:** upgraded to 1.0.0-alpha.155
* **@lunora/studio:** upgraded to 1.0.0-alpha.123

## @lunora/vite [1.0.0-alpha.154](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.153...@lunora/vite@1.0.0-alpha.154) (2026-08-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.123
* **@lunora/config:** upgraded to 1.0.0-alpha.154

## @lunora/vite [1.0.0-alpha.153](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.152...@lunora/vite@1.0.0-alpha.153) (2026-08-25)

### Bug Fixes

* **config:** parse .dev.vars like wrangler ([#461](https://github.com/anolilab/lunora/issues/461)) ([258fbb7](https://github.com/anolilab/lunora/commit/258fbb70b3c39aec9d33a5254ef384258acc0cfa))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.122
* **@lunora/config:** upgraded to 1.0.0-alpha.153
* **@lunora/studio:** upgraded to 1.0.0-alpha.122

## @lunora/vite [1.0.0-alpha.152](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.151...@lunora/vite@1.0.0-alpha.152) (2026-08-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.121
* **@lunora/config:** upgraded to 1.0.0-alpha.152
* **@lunora/studio:** upgraded to 1.0.0-alpha.120

## @lunora/vite [1.0.0-alpha.151](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.150...@lunora/vite@1.0.0-alpha.151) (2026-08-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.120
* **@lunora/config:** upgraded to 1.0.0-alpha.151

## @lunora/vite [1.0.0-alpha.150](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.149...@lunora/vite@1.0.0-alpha.150) (2026-08-23)

### Bug Fixes

* **cli:** guard sdk vendoring and imports ([#443](https://github.com/anolilab/lunora/issues/443)) ([981a0fa](https://github.com/anolilab/lunora/commit/981a0fabfd9ffd2d6c1d14604694ea8881f15e78))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.119
* **@lunora/config:** upgraded to 1.0.0-alpha.150
* **@lunora/studio:** upgraded to 1.0.0-alpha.119

## @lunora/vite [1.0.0-alpha.149](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.148...@lunora/vite@1.0.0-alpha.149) (2026-08-23)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.118
* **@lunora/config:** upgraded to 1.0.0-alpha.149
* **@lunora/studio:** upgraded to 1.0.0-alpha.118

## @lunora/vite [1.0.0-alpha.148](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.147...@lunora/vite@1.0.0-alpha.148) (2026-08-22)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.148
* **@lunora/studio:** upgraded to 1.0.0-alpha.117

## @lunora/vite [1.0.0-alpha.147](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.146...%40lunora%2Fvite%401.0.0-alpha.147) (2026-08-19)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.117
* **@lunora/config:** upgraded to 1.0.0-alpha.147
* **@lunora/studio:** upgraded to 1.0.0-alpha.116

## @lunora/vite [1.0.0-alpha.146](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.145...%40lunora%2Fvite%401.0.0-alpha.146) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.116
* **@lunora/config:** upgraded to 1.0.0-alpha.146
* **@lunora/studio:** upgraded to 1.0.0-alpha.115

## @lunora/vite [1.0.0-alpha.145](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.144...%40lunora%2Fvite%401.0.0-alpha.145) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.115
* **@lunora/config:** upgraded to 1.0.0-alpha.145
* **@lunora/studio:** upgraded to 1.0.0-alpha.114

## @lunora/vite [1.0.0-alpha.144](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.143...%40lunora%2Fvite%401.0.0-alpha.144) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.114
* **@lunora/config:** upgraded to 1.0.0-alpha.144
* **@lunora/studio:** upgraded to 1.0.0-alpha.113

## @lunora/vite [1.0.0-alpha.143](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.142...%40lunora%2Fvite%401.0.0-alpha.143) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.113
* **@lunora/config:** upgraded to 1.0.0-alpha.143
* **@lunora/studio:** upgraded to 1.0.0-alpha.112

## @lunora/vite [1.0.0-alpha.142](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.141...%40lunora%2Fvite%401.0.0-alpha.142) (2026-08-18)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.142
* **@lunora/studio:** upgraded to 1.0.0-alpha.111

## @lunora/vite [1.0.0-alpha.141](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.140...%40lunora%2Fvite%401.0.0-alpha.141) (2026-08-15)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.112
* **@lunora/config:** upgraded to 1.0.0-alpha.141
* **@lunora/studio:** upgraded to 1.0.0-alpha.110

## @lunora/vite [1.0.0-alpha.140](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.139...%40lunora%2Fvite%401.0.0-alpha.140) (2026-08-14)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.111
* **@lunora/config:** upgraded to 1.0.0-alpha.140

## @lunora/vite [1.0.0-alpha.139](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.138...%40lunora%2Fvite%401.0.0-alpha.139) (2026-08-14)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.110
* **@lunora/config:** upgraded to 1.0.0-alpha.139
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/studio:** upgraded to 1.0.0-alpha.109

## @lunora/vite [1.0.0-alpha.138](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.137...%40lunora%2Fvite%401.0.0-alpha.138) (2026-08-12)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.109
* **@lunora/config:** upgraded to 1.0.0-alpha.138
* **@lunora/studio:** upgraded to 1.0.0-alpha.108

## @lunora/vite [1.0.0-alpha.137](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.136...%40lunora%2Fvite%401.0.0-alpha.137) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.108
* **@lunora/config:** upgraded to 1.0.0-alpha.137
* **@lunora/studio:** upgraded to 1.0.0-alpha.107

## @lunora/vite [1.0.0-alpha.136](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.135...%40lunora%2Fvite%401.0.0-alpha.136) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.107
* **@lunora/config:** upgraded to 1.0.0-alpha.136
* **@lunora/studio:** upgraded to 1.0.0-alpha.106

## @lunora/vite [1.0.0-alpha.135](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.134...%40lunora%2Fvite%401.0.0-alpha.135) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.106
* **@lunora/config:** upgraded to 1.0.0-alpha.135
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/studio:** upgraded to 1.0.0-alpha.105

## @lunora/vite [1.0.0-alpha.134](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.133...%40lunora%2Fvite%401.0.0-alpha.134) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.105
* **@lunora/config:** upgraded to 1.0.0-alpha.134

## @lunora/vite [1.0.0-alpha.133](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.132...%40lunora%2Fvite%401.0.0-alpha.133) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.104
* **@lunora/config:** upgraded to 1.0.0-alpha.133

## @lunora/vite [1.0.0-alpha.132](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.131...%40lunora%2Fvite%401.0.0-alpha.132) (2026-08-10)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.103
* **@lunora/config:** upgraded to 1.0.0-alpha.132
* **@lunora/studio:** upgraded to 1.0.0-alpha.104

## @lunora/vite [1.0.0-alpha.131](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.130...%40lunora%2Fvite%401.0.0-alpha.131) (2026-08-10)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.102
* **@lunora/config:** upgraded to 1.0.0-alpha.131
* **@lunora/studio:** upgraded to 1.0.0-alpha.103

## @lunora/vite [1.0.0-alpha.130](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.129...%40lunora%2Fvite%401.0.0-alpha.130) (2026-08-09)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.101
* **@lunora/config:** upgraded to 1.0.0-alpha.130
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/studio:** upgraded to 1.0.0-alpha.102

## @lunora/vite [1.0.0-alpha.129](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.128...%40lunora%2Fvite%401.0.0-alpha.129) (2026-08-09)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.100
* **@lunora/config:** upgraded to 1.0.0-alpha.129
* **@lunora/studio:** upgraded to 1.0.0-alpha.101

## @lunora/vite [1.0.0-alpha.128](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.127...%40lunora%2Fvite%401.0.0-alpha.128) (2026-08-09)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.99
* **@lunora/config:** upgraded to 1.0.0-alpha.128
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/studio:** upgraded to 1.0.0-alpha.100

## @lunora/vite [1.0.0-alpha.127](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.126...%40lunora%2Fvite%401.0.0-alpha.127) (2026-08-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.98
* **@lunora/config:** upgraded to 1.0.0-alpha.127

## @lunora/vite [1.0.0-alpha.126](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.125...%40lunora%2Fvite%401.0.0-alpha.126) (2026-08-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.97
* **@lunora/config:** upgraded to 1.0.0-alpha.126

## @lunora/vite [1.0.0-alpha.125](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.124...%40lunora%2Fvite%401.0.0-alpha.125) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.96
* **@lunora/config:** upgraded to 1.0.0-alpha.125
* **@lunora/studio:** upgraded to 1.0.0-alpha.99

## @lunora/vite [1.0.0-alpha.124](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.123...%40lunora%2Fvite%401.0.0-alpha.124) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.95
* **@lunora/config:** upgraded to 1.0.0-alpha.124
* **@lunora/studio:** upgraded to 1.0.0-alpha.98

## @lunora/vite [1.0.0-alpha.123](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.122...%40lunora%2Fvite%401.0.0-alpha.123) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.94
* **@lunora/config:** upgraded to 1.0.0-alpha.123
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/studio:** upgraded to 1.0.0-alpha.97

## @lunora/vite [1.0.0-alpha.122](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.121...%40lunora%2Fvite%401.0.0-alpha.122) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.93
* **@lunora/config:** upgraded to 1.0.0-alpha.122
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/studio:** upgraded to 1.0.0-alpha.96

## @lunora/vite [1.0.0-alpha.121](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.120...%40lunora%2Fvite%401.0.0-alpha.121) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.92
* **@lunora/config:** upgraded to 1.0.0-alpha.121

## @lunora/vite [1.0.0-alpha.120](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.119...%40lunora%2Fvite%401.0.0-alpha.120) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.91
* **@lunora/config:** upgraded to 1.0.0-alpha.120

## @lunora/vite [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.118...%40lunora%2Fvite%401.0.0-alpha.119) (2026-08-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.119

## @lunora/vite [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.117...%40lunora%2Fvite%401.0.0-alpha.118) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.90
* **@lunora/config:** upgraded to 1.0.0-alpha.118
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/studio:** upgraded to 1.0.0-alpha.95

## @lunora/vite [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.116...%40lunora%2Fvite%401.0.0-alpha.117) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.89
* **@lunora/config:** upgraded to 1.0.0-alpha.117
* **@lunora/studio:** upgraded to 1.0.0-alpha.94

## @lunora/vite [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.115...%40lunora%2Fvite%401.0.0-alpha.116) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.88
* **@lunora/config:** upgraded to 1.0.0-alpha.116
* **@lunora/studio:** upgraded to 1.0.0-alpha.93

## @lunora/vite [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.114...%40lunora%2Fvite%401.0.0-alpha.115) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.87
* **@lunora/config:** upgraded to 1.0.0-alpha.115
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/studio:** upgraded to 1.0.0-alpha.92

## @lunora/vite [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.113...%40lunora%2Fvite%401.0.0-alpha.114) (2026-08-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.114
* **@lunora/studio:** upgraded to 1.0.0-alpha.91

## @lunora/vite [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.112...%40lunora%2Fvite%401.0.0-alpha.113) (2026-08-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.113
* **@lunora/studio:** upgraded to 1.0.0-alpha.90

## @lunora/vite [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.111...%40lunora%2Fvite%401.0.0-alpha.112) (2026-08-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.86
* **@lunora/config:** upgraded to 1.0.0-alpha.112
* **@lunora/studio:** upgraded to 1.0.0-alpha.89

## @lunora/vite [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.110...%40lunora%2Fvite%401.0.0-alpha.111) (2026-08-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.111
* **@lunora/studio:** upgraded to 1.0.0-alpha.88

## @lunora/vite [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.109...%40lunora%2Fvite%401.0.0-alpha.110) (2026-08-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.85
* **@lunora/config:** upgraded to 1.0.0-alpha.110
* **@lunora/studio:** upgraded to 1.0.0-alpha.87

## @lunora/vite [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.108...%40lunora%2Fvite%401.0.0-alpha.109) (2026-08-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.84
* **@lunora/config:** upgraded to 1.0.0-alpha.109

## @lunora/vite [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.107...%40lunora%2Fvite%401.0.0-alpha.108) (2026-08-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.83
* **@lunora/config:** upgraded to 1.0.0-alpha.108
* **@lunora/studio:** upgraded to 1.0.0-alpha.86

## @lunora/vite [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.106...%40lunora%2Fvite%401.0.0-alpha.107) (2026-07-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.82
* **@lunora/config:** upgraded to 1.0.0-alpha.107
* **@lunora/studio:** upgraded to 1.0.0-alpha.85

## @lunora/vite [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.105...%40lunora%2Fvite%401.0.0-alpha.106) (2026-07-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.81
* **@lunora/config:** upgraded to 1.0.0-alpha.106
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/studio:** upgraded to 1.0.0-alpha.84

## @lunora/vite [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.104...%40lunora%2Fvite%401.0.0-alpha.105) (2026-07-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.80
* **@lunora/config:** upgraded to 1.0.0-alpha.105
* **@lunora/studio:** upgraded to 1.0.0-alpha.83

## @lunora/vite [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.103...%40lunora%2Fvite%401.0.0-alpha.104) (2026-07-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.104
* **@lunora/studio:** upgraded to 1.0.0-alpha.82

## @lunora/vite [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.102...%40lunora%2Fvite%401.0.0-alpha.103) (2026-07-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.77
* **@lunora/config:** upgraded to 1.0.0-alpha.103
* **@lunora/studio:** upgraded to 1.0.0-alpha.81

## @lunora/vite [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.101...%40lunora%2Fvite%401.0.0-alpha.102) (2026-07-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.76
* **@lunora/config:** upgraded to 1.0.0-alpha.102
* **@lunora/studio:** upgraded to 1.0.0-alpha.80

## @lunora/vite [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.100...%40lunora%2Fvite%401.0.0-alpha.101) (2026-07-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.75
* **@lunora/config:** upgraded to 1.0.0-alpha.101
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/studio:** upgraded to 1.0.0-alpha.79

## @lunora/vite [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.99...%40lunora%2Fvite%401.0.0-alpha.100) (2026-07-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.74
* **@lunora/config:** upgraded to 1.0.0-alpha.100
* **@lunora/studio:** upgraded to 1.0.0-alpha.78

## @lunora/vite [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.98...%40lunora%2Fvite%401.0.0-alpha.99) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.73
* **@lunora/config:** upgraded to 1.0.0-alpha.99
* **@lunora/studio:** upgraded to 1.0.0-alpha.77

## @lunora/vite [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.97...%40lunora%2Fvite%401.0.0-alpha.98) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.72
* **@lunora/config:** upgraded to 1.0.0-alpha.98
* **@lunora/studio:** upgraded to 1.0.0-alpha.76

## @lunora/vite [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.96...%40lunora%2Fvite%401.0.0-alpha.97) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.71
* **@lunora/config:** upgraded to 1.0.0-alpha.97
* **@lunora/studio:** upgraded to 1.0.0-alpha.75

## @lunora/vite [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.95...%40lunora%2Fvite%401.0.0-alpha.96) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.70
* **@lunora/config:** upgraded to 1.0.0-alpha.96
* **@lunora/studio:** upgraded to 1.0.0-alpha.74

## @lunora/vite [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.94...%40lunora%2Fvite%401.0.0-alpha.95) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.69
* **@lunora/config:** upgraded to 1.0.0-alpha.95
* **@lunora/studio:** upgraded to 1.0.0-alpha.73

## @lunora/vite [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.93...%40lunora%2Fvite%401.0.0-alpha.94) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.68
* **@lunora/config:** upgraded to 1.0.0-alpha.94
* **@lunora/studio:** upgraded to 1.0.0-alpha.72

## @lunora/vite [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.92...%40lunora%2Fvite%401.0.0-alpha.93) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.67
* **@lunora/config:** upgraded to 1.0.0-alpha.93
* **@lunora/studio:** upgraded to 1.0.0-alpha.71

## @lunora/vite [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.91...%40lunora%2Fvite%401.0.0-alpha.92) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.66
* **@lunora/config:** upgraded to 1.0.0-alpha.92
* **@lunora/studio:** upgraded to 1.0.0-alpha.70

## @lunora/vite [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.90...%40lunora%2Fvite%401.0.0-alpha.91) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.65
* **@lunora/config:** upgraded to 1.0.0-alpha.91
* **@lunora/studio:** upgraded to 1.0.0-alpha.69

## @lunora/vite [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.89...%40lunora%2Fvite%401.0.0-alpha.90) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.64
* **@lunora/config:** upgraded to 1.0.0-alpha.90
* **@lunora/studio:** upgraded to 1.0.0-alpha.68

## @lunora/vite [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.88...%40lunora%2Fvite%401.0.0-alpha.89) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.63
* **@lunora/config:** upgraded to 1.0.0-alpha.89
* **@lunora/studio:** upgraded to 1.0.0-alpha.67

## @lunora/vite [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.87...%40lunora%2Fvite%401.0.0-alpha.88) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.62
* **@lunora/config:** upgraded to 1.0.0-alpha.88
* **@lunora/studio:** upgraded to 1.0.0-alpha.66

## @lunora/vite [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.86...%40lunora%2Fvite%401.0.0-alpha.87) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.61
* **@lunora/config:** upgraded to 1.0.0-alpha.87
* **@lunora/studio:** upgraded to 1.0.0-alpha.65

## @lunora/vite [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.85...%40lunora%2Fvite%401.0.0-alpha.86) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.60
* **@lunora/config:** upgraded to 1.0.0-alpha.86
* **@lunora/studio:** upgraded to 1.0.0-alpha.64

## @lunora/vite [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.84...%40lunora%2Fvite%401.0.0-alpha.85) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.59
* **@lunora/config:** upgraded to 1.0.0-alpha.85
* **@lunora/studio:** upgraded to 1.0.0-alpha.63

## @lunora/vite [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.83...%40lunora%2Fvite%401.0.0-alpha.84) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.58
* **@lunora/config:** upgraded to 1.0.0-alpha.84
* **@lunora/studio:** upgraded to 1.0.0-alpha.62

## @lunora/vite [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.82...%40lunora%2Fvite%401.0.0-alpha.83) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.57
* **@lunora/config:** upgraded to 1.0.0-alpha.83
* **@lunora/studio:** upgraded to 1.0.0-alpha.61

## @lunora/vite [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.81...%40lunora%2Fvite%401.0.0-alpha.82) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.56
* **@lunora/config:** upgraded to 1.0.0-alpha.82
* **@lunora/studio:** upgraded to 1.0.0-alpha.60

## @lunora/vite [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.80...%40lunora%2Fvite%401.0.0-alpha.81) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.55
* **@lunora/config:** upgraded to 1.0.0-alpha.81

## @lunora/vite [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.79...%40lunora%2Fvite%401.0.0-alpha.80) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.54
* **@lunora/config:** upgraded to 1.0.0-alpha.80
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/studio:** upgraded to 1.0.0-alpha.59

## @lunora/vite [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.78...%40lunora%2Fvite%401.0.0-alpha.79) (2026-07-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.53
* **@lunora/config:** upgraded to 1.0.0-alpha.79

## @lunora/vite [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.77...%40lunora%2Fvite%401.0.0-alpha.78) (2026-07-23)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.52
* **@lunora/config:** upgraded to 1.0.0-alpha.78
* **@lunora/studio:** upgraded to 1.0.0-alpha.58

## @lunora/vite [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.76...%40lunora%2Fvite%401.0.0-alpha.77) (2026-07-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.51
* **@lunora/config:** upgraded to 1.0.0-alpha.77

## @lunora/vite [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.75...%40lunora%2Fvite%401.0.0-alpha.76) (2026-07-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.50
* **@lunora/config:** upgraded to 1.0.0-alpha.76

## @lunora/vite [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.74...%40lunora%2Fvite%401.0.0-alpha.75) (2026-07-21)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.49
* **@lunora/config:** upgraded to 1.0.0-alpha.75

## @lunora/vite [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.73...%40lunora%2Fvite%401.0.0-alpha.74) (2026-07-21)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.74
* **@lunora/studio:** upgraded to 1.0.0-alpha.57

## @lunora/vite [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.72...%40lunora%2Fvite%401.0.0-alpha.73) (2026-07-21)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.73
* **@lunora/studio:** upgraded to 1.0.0-alpha.56

## @lunora/vite [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.71...%40lunora%2Fvite%401.0.0-alpha.72) (2026-07-21)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.48
* **@lunora/config:** upgraded to 1.0.0-alpha.72
* **@lunora/studio:** upgraded to 1.0.0-alpha.55

## @lunora/vite [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.70...%40lunora%2Fvite%401.0.0-alpha.71) (2026-07-20)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.47
* **@lunora/config:** upgraded to 1.0.0-alpha.71
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/studio:** upgraded to 1.0.0-alpha.54

## @lunora/vite [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.69...%40lunora%2Fvite%401.0.0-alpha.70) (2026-07-19)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.46
* **@lunora/config:** upgraded to 1.0.0-alpha.70
* **@lunora/studio:** upgraded to 1.0.0-alpha.53

## @lunora/vite [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.68...%40lunora%2Fvite%401.0.0-alpha.69) (2026-07-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.45
* **@lunora/config:** upgraded to 1.0.0-alpha.69
* **@lunora/studio:** upgraded to 1.0.0-alpha.52

## @lunora/vite [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.67...%40lunora%2Fvite%401.0.0-alpha.68) (2026-07-17)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.44
* **@lunora/config:** upgraded to 1.0.0-alpha.68
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/studio:** upgraded to 1.0.0-alpha.51

## @lunora/vite [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.66...%40lunora%2Fvite%401.0.0-alpha.67) (2026-07-13)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.67
* **@lunora/studio:** upgraded to 1.0.0-alpha.50

## @lunora/vite [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.65...%40lunora%2Fvite%401.0.0-alpha.66) (2026-07-13)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.43
* **@lunora/config:** upgraded to 1.0.0-alpha.66
* **@lunora/studio:** upgraded to 1.0.0-alpha.49

## @lunora/vite [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.64...%40lunora%2Fvite%401.0.0-alpha.65) (2026-07-12)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.42
* **@lunora/config:** upgraded to 1.0.0-alpha.65

## @lunora/vite [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.63...%40lunora%2Fvite%401.0.0-alpha.64) (2026-07-12)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.64
* **@lunora/studio:** upgraded to 1.0.0-alpha.48

## @lunora/vite [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.62...%40lunora%2Fvite%401.0.0-alpha.63) (2026-07-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.41
* **@lunora/config:** upgraded to 1.0.0-alpha.63

## @lunora/vite [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.61...%40lunora%2Fvite%401.0.0-alpha.62) (2026-07-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.40
* **@lunora/config:** upgraded to 1.0.0-alpha.62
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/studio:** upgraded to 1.0.0-alpha.47

## @lunora/vite [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.60...%40lunora%2Fvite%401.0.0-alpha.61) (2026-07-10)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.39
* **@lunora/config:** upgraded to 1.0.0-alpha.61
* **@lunora/studio:** upgraded to 1.0.0-alpha.46

## @lunora/vite [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.59...%40lunora%2Fvite%401.0.0-alpha.60) (2026-07-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.38
* **@lunora/config:** upgraded to 1.0.0-alpha.60
* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/studio:** upgraded to 1.0.0-alpha.45

## @lunora/vite [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.58...%40lunora%2Fvite%401.0.0-alpha.59) (2026-07-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.37
* **@lunora/config:** upgraded to 1.0.0-alpha.59
* **@lunora/studio:** upgraded to 1.0.0-alpha.44

## @lunora/vite [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.57...%40lunora%2Fvite%401.0.0-alpha.58) (2026-07-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.36
* **@lunora/config:** upgraded to 1.0.0-alpha.58
* **@lunora/studio:** upgraded to 1.0.0-alpha.43

## @lunora/vite [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.56...%40lunora%2Fvite%401.0.0-alpha.57) (2026-07-06)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.35
* **@lunora/config:** upgraded to 1.0.0-alpha.57
* **@lunora/studio:** upgraded to 1.0.0-alpha.42

## @lunora/vite [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.55...%40lunora%2Fvite%401.0.0-alpha.56) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.34
* **@lunora/config:** upgraded to 1.0.0-alpha.56
* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/studio:** upgraded to 1.0.0-alpha.41

## @lunora/vite [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.54...%40lunora%2Fvite%401.0.0-alpha.55) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.55
* **@lunora/studio:** upgraded to 1.0.0-alpha.40

## @lunora/vite [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.53...%40lunora%2Fvite%401.0.0-alpha.54) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.33
* **@lunora/config:** upgraded to 1.0.0-alpha.54
* **@lunora/studio:** upgraded to 1.0.0-alpha.39

## @lunora/vite [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.52...%40lunora%2Fvite%401.0.0-alpha.53) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.53
* **@lunora/studio:** upgraded to 1.0.0-alpha.38

## @lunora/vite [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.51...%40lunora%2Fvite%401.0.0-alpha.52) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.52
* **@lunora/studio:** upgraded to 1.0.0-alpha.37

## @lunora/vite [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.50...%40lunora%2Fvite%401.0.0-alpha.51) (2026-07-04)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.51
* **@lunora/studio:** upgraded to 1.0.0-alpha.36

## @lunora/vite [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.49...%40lunora%2Fvite%401.0.0-alpha.50) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.32
* **@lunora/config:** upgraded to 1.0.0-alpha.50
* **@lunora/studio:** upgraded to 1.0.0-alpha.35

## @lunora/vite [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.48...%40lunora%2Fvite%401.0.0-alpha.49) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.49
* **@lunora/studio:** upgraded to 1.0.0-alpha.34

## @lunora/vite [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.47...%40lunora%2Fvite%401.0.0-alpha.48) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.30
* **@lunora/config:** upgraded to 1.0.0-alpha.48
* **@lunora/studio:** upgraded to 1.0.0-alpha.33

## @lunora/vite [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.46...%40lunora%2Fvite%401.0.0-alpha.47) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.47

## @lunora/vite [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.45...%40lunora%2Fvite%401.0.0-alpha.46) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.29
* **@lunora/config:** upgraded to 1.0.0-alpha.46
* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/studio:** upgraded to 1.0.0-alpha.32

## @lunora/vite [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.44...%40lunora%2Fvite%401.0.0-alpha.45) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.28
* **@lunora/config:** upgraded to 1.0.0-alpha.45
* **@lunora/studio:** upgraded to 1.0.0-alpha.31

## @lunora/vite [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.43...%40lunora%2Fvite%401.0.0-alpha.44) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.44
* **@lunora/studio:** upgraded to 1.0.0-alpha.30

## @lunora/vite [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.42...%40lunora%2Fvite%401.0.0-alpha.43) (2026-07-03)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.43
* **@lunora/studio:** upgraded to 1.0.0-alpha.29

## @lunora/vite [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.41...%40lunora%2Fvite%401.0.0-alpha.42) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.27
* **@lunora/config:** upgraded to 1.0.0-alpha.42
* **@lunora/studio:** upgraded to 1.0.0-alpha.28

## @lunora/vite [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.40...%40lunora%2Fvite%401.0.0-alpha.41) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.26
* **@lunora/config:** upgraded to 1.0.0-alpha.41
* **@lunora/studio:** upgraded to 1.0.0-alpha.27

## @lunora/vite [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.39...%40lunora%2Fvite%401.0.0-alpha.40) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.25
* **@lunora/config:** upgraded to 1.0.0-alpha.40
* **@lunora/studio:** upgraded to 1.0.0-alpha.26

## @lunora/vite [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.38...%40lunora%2Fvite%401.0.0-alpha.39) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.24
* **@lunora/config:** upgraded to 1.0.0-alpha.39
* **@lunora/studio:** upgraded to 1.0.0-alpha.25

## @lunora/vite [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.37...%40lunora%2Fvite%401.0.0-alpha.38) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.23
* **@lunora/config:** upgraded to 1.0.0-alpha.38
* **@lunora/studio:** upgraded to 1.0.0-alpha.24

## @lunora/vite [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.36...%40lunora%2Fvite%401.0.0-alpha.37) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.22
* **@lunora/config:** upgraded to 1.0.0-alpha.37
* **@lunora/studio:** upgraded to 1.0.0-alpha.23

## @lunora/vite [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.35...%40lunora%2Fvite%401.0.0-alpha.36) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.21
* **@lunora/config:** upgraded to 1.0.0-alpha.36
* **@lunora/studio:** upgraded to 1.0.0-alpha.22

## @lunora/vite [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.34...%40lunora%2Fvite%401.0.0-alpha.35) (2026-07-01)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.35
* **@lunora/studio:** upgraded to 1.0.0-alpha.21

## @lunora/vite [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.33...%40lunora%2Fvite%401.0.0-alpha.34) (2026-07-01)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.20
* **@lunora/config:** upgraded to 1.0.0-alpha.34
* **@lunora/studio:** upgraded to 1.0.0-alpha.20

## @lunora/vite [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.32...%40lunora%2Fvite%401.0.0-alpha.33) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.33
* **@lunora/studio:** upgraded to 1.0.0-alpha.19

## @lunora/vite [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.31...%40lunora%2Fvite%401.0.0-alpha.32) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.32
* **@lunora/studio:** upgraded to 1.0.0-alpha.18

## @lunora/vite [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.30...%40lunora%2Fvite%401.0.0-alpha.31) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.19
* **@lunora/config:** upgraded to 1.0.0-alpha.31
* **@lunora/studio:** upgraded to 1.0.0-alpha.17

## @lunora/vite [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.29...%40lunora%2Fvite%401.0.0-alpha.30) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.18
* **@lunora/config:** upgraded to 1.0.0-alpha.30

## @lunora/vite [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.28...%40lunora%2Fvite%401.0.0-alpha.29) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.29
* **@lunora/studio:** upgraded to 1.0.0-alpha.16

## @lunora/vite [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.27...%40lunora%2Fvite%401.0.0-alpha.28) (2026-06-30)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.28
* **@lunora/studio:** upgraded to 1.0.0-alpha.15

## @lunora/vite [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.26...%40lunora%2Fvite%401.0.0-alpha.27) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.17
* **@lunora/config:** upgraded to 1.0.0-alpha.27
* **@lunora/studio:** upgraded to 1.0.0-alpha.14

## @lunora/vite [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.25...%40lunora%2Fvite%401.0.0-alpha.26) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.16
* **@lunora/config:** upgraded to 1.0.0-alpha.26

## @lunora/vite [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.24...%40lunora%2Fvite%401.0.0-alpha.25) (2026-06-29)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.25
* **@lunora/studio:** upgraded to 1.0.0-alpha.13

## @lunora/vite [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.23...%40lunora%2Fvite%401.0.0-alpha.24) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.15
* **@lunora/config:** upgraded to 1.0.0-alpha.24
* **@lunora/studio:** upgraded to 1.0.0-alpha.12

## @lunora/vite [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.22...%40lunora%2Fvite%401.0.0-alpha.23) (2026-06-29)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.23
* **@lunora/studio:** upgraded to 1.0.0-alpha.11

## @lunora/vite [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fvite%401.0.0-alpha.21...%40lunora%2Fvite%401.0.0-alpha.22) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.14
* **@lunora/config:** upgraded to 1.0.0-alpha.22
* **@lunora/studio:** upgraded to 1.0.0-alpha.10

## @lunora/vite [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.20...@lunora/vite@1.0.0-alpha.21) (2026-06-28)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.21
* **@lunora/studio:** upgraded to 1.0.0-alpha.9

## @lunora/vite [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.19...@lunora/vite@1.0.0-alpha.20) (2026-06-28)

### Features

* **vite:** error-overlay solution finders ([#42](https://github.com/anolilab/lunora/issues/42)) ([33097e2](https://github.com/anolilab/lunora/commit/33097e2d5638b3e924c506eb5e161e9a20ea6f6f))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.13
* **@lunora/config:** upgraded to 1.0.0-alpha.20

## @lunora/vite [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.18...@lunora/vite@1.0.0-alpha.19) (2026-06-28)

### Features

* **config:** stream dev container logs to terminal ([#38](https://github.com/anolilab/lunora/issues/38)) ([c34dbc6](https://github.com/anolilab/lunora/commit/c34dbc6f40f9e31ce291dbd31c6c4d9e596b4127))

### Code Refactoring

* **vite:** drop Vite<6 module-graph fallback ([#39](https://github.com/anolilab/lunora/issues/39)) ([de7ad15](https://github.com/anolilab/lunora/commit/de7ad15c6fcbfc03297cadf21d593bbbfbfa8d4f))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.19

## @lunora/vite [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.17...@lunora/vite@1.0.0-alpha.18) (2026-06-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.12
* **@lunora/config:** upgraded to 1.0.0-alpha.18

## @lunora/vite [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.16...@lunora/vite@1.0.0-alpha.17) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.11
* **@lunora/config:** upgraded to 1.0.0-alpha.17
* **@lunora/studio:** upgraded to 1.0.0-alpha.8

## @lunora/vite [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.15...@lunora/vite@1.0.0-alpha.16) (2026-06-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.10
* **@lunora/config:** upgraded to 1.0.0-alpha.16
* **@lunora/studio:** upgraded to 1.0.0-alpha.7

## @lunora/vite [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.14...@lunora/vite@1.0.0-alpha.15) (2026-06-27)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.9
* **@lunora/config:** upgraded to 1.0.0-alpha.15
* **@lunora/studio:** upgraded to 1.0.0-alpha.6

## @lunora/vite [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.13...@lunora/vite@1.0.0-alpha.14) (2026-06-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.8
* **@lunora/config:** upgraded to 1.0.0-alpha.14

## @lunora/vite [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.12...@lunora/vite@1.0.0-alpha.13) (2026-06-25)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.13

## @lunora/vite [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.11...@lunora/vite@1.0.0-alpha.12) (2026-06-25)

### Features

* **config:** generate empty dev secrets + admin token on dev ([c4f729f](https://github.com/anolilab/lunora/commit/c4f729f51bc0a68a356e2750ce49cc7a1edbf9a2))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.12

## @lunora/vite [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.10...@lunora/vite@1.0.0-alpha.11) (2026-06-25)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.11
* **@lunora/studio:** upgraded to 1.0.0-alpha.5

## @lunora/vite [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.9...@lunora/vite@1.0.0-alpha.10) (2026-06-25)


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.10

## @lunora/vite [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.8...@lunora/vite@1.0.0-alpha.9) (2026-06-25)

### Bug Fixes

* **vite:** forward warn to the error overlay by default ([cf7dda2](https://github.com/anolilab/lunora/commit/cf7dda2d682ebc675dddfec7fc9d8397dbff5ac2))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.7
* **@lunora/config:** upgraded to 1.0.0-alpha.9

## @lunora/vite [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.7...@lunora/vite@1.0.0-alpha.8) (2026-06-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.6
* **@lunora/config:** upgraded to 1.0.0-alpha.8

## @lunora/vite [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.6...@lunora/vite@1.0.0-alpha.7) (2026-06-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.5
* **@lunora/config:** upgraded to 1.0.0-alpha.7

## @lunora/vite [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.5...@lunora/vite@1.0.0-alpha.6) (2026-06-25)

### Bug Fixes

* **vite:** brand schema-advisory log output ([f9ed146](https://github.com/anolilab/lunora/commit/f9ed14629bc2b042d92b3ed53fd2bcf0587aee48))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.4
* **@lunora/config:** upgraded to 1.0.0-alpha.6
* **@lunora/studio:** upgraded to 1.0.0-alpha.4

## @lunora/vite [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.4...@lunora/vite@1.0.0-alpha.5) (2026-06-25)

### Bug Fixes

* **vite:** import runtime via umbrella subpath ([84f8be2](https://github.com/anolilab/lunora/commit/84f8be25aa0eb5f91d2aaa369b5526335fe9c536))

## @lunora/vite [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.3...@lunora/vite@1.0.0-alpha.4) (2026-06-25)

### Features

* **cli:** rebuild init DX in create-astro style ([36638dc](https://github.com/anolilab/lunora/commit/36638dc6b08978509da90861f3b9292205c10300))
* **vite:** unify plugin logging with the shared lunora line style ([4f6890f](https://github.com/anolilab/lunora/commit/4f6890f65adb6755fee8bc8b47d64474706658db))

### Bug Fixes

* **vite:** align the agent-rules hint with the other lunora log lines ([815604f](https://github.com/anolilab/lunora/commit/815604fdfb2615580eda791a5e7172ee3a017fd5))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.5

## @lunora/vite [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.2...@lunora/vite@1.0.0-alpha.3) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.3
* **@lunora/config:** upgraded to 1.0.0-alpha.4
* **@lunora/studio:** upgraded to 1.0.0-alpha.3

## @lunora/vite [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/vite@1.0.0-alpha.1...@lunora/vite@1.0.0-alpha.2) (2026-06-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.2
* **@lunora/config:** upgraded to 1.0.0-alpha.2

## @lunora/vite 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.1
* **@lunora/config:** upgraded to 1.0.0-alpha.1
* **@lunora/studio:** upgraded to 1.0.0-alpha.1
