# Plan 234 — `@lunora/platform-node` construction findings

- **Category**: architecture / platform portability spike
- **Status**: DONE (spike) — `packages/platform-node/` builds, typechecks, and passes both conformance TCKs
- **Base**: `advisor/229-platform-honesty` (platform contract honesty: `idFor` stability, the fail-closed capability gate, the tagged-fan-out identity fix)
- **Deliverable**: this log — every place building a second `@lunora/platform` host needed something the contracts didn't promise, classified, with a proposed fix location. Per the plan, engine-changing fixes are **not** made here; each is filed as its own follow-up.

## Summary

`packages/platform-node/` is a Node implementation of all four `@lunora/platform`
contracts — `ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`,
`SchedulerHost` — over `better-sqlite3` (real, file-backable SQLite; not the
`node:sqlite` reference host's `:memory:`-only surface) and an in-process
socket/directory/scheduler registry. It runs **both** existing conformance
suites:

| Suite                                                            | Contract                                              | Legs | Result         |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ---- | -------------- |
| `@lunora/platform/conformance` (`defineHostContractSuite`)       | host primitives                                       | 28   | **28/28 pass** |
| `@lunora/shard-engine/conformance` (`defineEngineContractSuite`) | OCC / RLS / reactive fan-out on top of the primitives | 10   | **10/10 pass** |

Zero test failures. That is itself the headline finding — see [Finding 9](#finding-9-zero-new-engine-coupling-gaps-229-generalizes).
The construction gaps this spike found were not TCK red; they were places the
contracts, the reference host, or an adjacent registry made a claim that a
second, structurally different host exposed as incomplete, dead, or
ambiguous. Nine numbered below, plus one deliberate non-finding recorded so it
isn't silently re-investigated later.

**Gap count by classification** (the plan's three buckets, plus two that
didn't fit any of them cleanly — recorded rather than forced into the wrong
bucket):

- **host-bug** (in the existing `node:sqlite` reference host, found by
  contrast while building a second host): **2** — [#5](#finding-5-host-bug-the-reference-hosts-durableattachments-map-is-dead-code), [#6](#finding-6-host-bug-class-the-reference-hosts-readwrite-heuristic-is-weaker-than-necessary)
- **contract-under-specification**: **3** — [#2](#finding-2-contract-under-specification-shard-directoryjurisdiction-has-zero-real-callers), [#3](#finding-3-contract-under-specification-durable-does-not-say-durable-against-what), [#4](#finding-4-contract-under-specification-structured-clonable-does-not-pin-a-wire-format)
- **engine-coupling**: **0 new** — [#9](#finding-9-zero-new-engine-coupling-gaps-229-generalizes) records the absence explicitly, since that's the question this spike exists to answer
- **TCK gap** (a contract clause with zero conformance coverage on any host — not a bug in any host, a gap in the test kit itself): **1** — [#8](#finding-8-tck-gap-databasesize-has-zero-conformance-coverage-on-any-host)
- **registry/tooling gap** (a construction-discovered inconsistency between two non-`@lunora/platform` registries, adjacent to but not part of the host contracts): **1** — [#1](#finding-1-registry-gap-platformmatrixids-and-deploytargetids-conflated-two-different-questions) (fixed in this spike; see why that was in-scope)

---

## Finding 1 (registry gap): `platformMatrixIds()` and `deployTargetIds()` conflated two different questions

**Where:** `packages/codegen/src/platform-target.ts` (`PLATFORM_MATRICES`), `packages/config/src/driver-registry.ts` (`DEPLOY_DRIVERS`), asserted equal by `packages/config/__tests__/project-config.test.ts`.

Registering `node` in codegen's `PLATFORM_MATRICES` (Step 3 of this plan) is
exactly the "second target" event `packages/codegen/src/platform-target.ts`
had been narrating for a while — its own comment on `platformMatrixIds()`
used to read: _"Today both hold exactly `cloudflare`, which is why nothing has
noticed."_ Registering `node` is what makes something notice: it immediately
broke `packages/config/__tests__/project-config.test.ts`'s `"keeps the driver
registry and codegen's capability matrices in agreement"` test, which asserted
`deployTargetIds()` (the CLI's deploy-driver registry — currently `["cloudflare"]`)
**strictly equals** `platformMatrixIds()` (codegen's capability-matrix
registry — now `["cloudflare", "node"]`).

The strict-equality invariant conflated two different questions: "can codegen
gate `ctx.*` capabilities for this target" (a `PlatformCapabilities` matrix)
and "can the CLI deploy an app to this target" (a `DeployDriver`). `node` is
the first target to answer those two questions differently — a spike host
that exists to run the conformance TCK, deliberately out of scope for `lunora
dev`/deploy wiring — and the invariant had never been tested against a case
where they diverge, only asserted on the coincidence that both registries held
exactly `cloudflare`.

**Fix applied (in this spike, not deferred):** `packages/config/__tests__/project-config.test.ts`'s
test now asserts the one direction that is actually dangerous — every deploy
driver must have a capability matrix (`deployTargetIds().every((id) => matrixIds.has(id))`)
— and drops the reverse direction (a matrix with no driver is now a legitimate
shape, not a bug). `packages/codegen/src/platform-target.ts`'s docstrings on
`PLATFORM_MATRICES` and `platformMatrixIds()` were updated to say why.

This is a test-assertion change in a package that is neither `@lunora/platform`
nor `@lunora/shard-engine` (the engine), and it narrows the invariant to what
the original comment's own reasoning already singled out as the dangerous
direction — not a shortcut to force a pass. It is called out here explicitly
so a reviewer can independently judge whether it belongs in this spike or
should have been its own follow-up.

## Finding 2 (contract-under-specification): `ShardDirectory.jurisdiction` has zero real callers

**Where:** `packages/platform/src/shard-directory.ts` (`ShardDirectory.jurisdiction`); contrast with `packages/runtime/src/resolve-shard.ts`, `packages/container/src/jurisdiction.ts`, `packages/scheduler/src/jurisdiction.ts`, `packages/mail/src/inbound/shard.ts`, `packages/queue/src/capture.ts`.

`ShardDirectory.jurisdiction`'s docstring is the contract's canonical
statement of the fail-closed guarantee: _"callers must fail closed when a
jurisdiction is requested but the method is absent."_ `packages/platform-node/src/node-shard-directory.ts`
deliberately **omits** `jurisdiction` (a bare Node process has no
data-residency placement to restrict), which is exactly the case that clause
exists for.

Grepping for every real caller of jurisdiction pinning in the repo
(`grep -rn "\.jurisdiction("`) turned up **five** independent implementations
— `@lunora/runtime`'s `applyJurisdiction`, `@lunora/container`'s
`applyJurisdiction`, `@lunora/scheduler`'s, `@lunora/mail`'s inbound shard
resolution, and `@lunora/queue`'s capture path — and every one of them
operates directly on the **raw Cloudflare `DurableObjectNamespace`-shaped
type** (`ShardNamespaceLike` / `ContainerNamespaceLike` / equivalents), not on
`@lunora/platform`'s `ShardDirectory`. `packages/runtime/src/resolve-shard.ts`'s
`toDirectory()` even wraps `namespace.jurisdiction` into the resulting
`ShardDirectory.jurisdiction` — but `grep -rn "directory\.jurisdiction("`
across every package's `src/` returns **zero matches**. Nothing ever calls
it. `applyJurisdiction` in `resolve-shard.ts` runs BEFORE `toDirectory()`, on
the still-raw namespace, so the jurisdiction is already pinned by the time a
`ShardDirectory` object exists at all.

**What this means:** the contract's one clean, portable mechanism for
data-residency placement is not what the codebase actually uses for
data-residency placement. Five packages each independently reimplement the
identical "fail closed if `.jurisdiction()` is absent" pattern against a
Cloudflare-specific type — exactly the duplication `@lunora/platform`'s
contracts exist to collapse into one place, except for jurisdiction it never
happened. Practically, a second host cannot get jurisdiction-restriction
behavior through the platform layer at all today: every one of those five
consumers would need its own port, not a `ShardDirectory.jurisdiction`
implementation.

**Classification:** contract-under-specification / architecture gap — the
contract promises a portability seam that no real caller goes through.

**Proposed fix location (not done here — too large for this spike):** either
(a) route `@lunora/runtime`, `@lunora/container`, `@lunora/scheduler`,
`@lunora/mail`, and `@lunora/queue` through `ShardDirectory.jurisdiction`
instead of hand-rolling the raw-namespace check five times, or (b) if
jurisdiction is inherently Cloudflare-specific and not meant to generalize,
retire `ShardDirectory.jurisdiction` from the contract and document
data-residency as a per-host concern outside `@lunora/platform`. Either is a
real design decision, not a one-line fix — filed as its own follow-up.

## Finding 3 (contract-under-specification): "durable" does not say durable against what

**Where:** `packages/platform/src/shard-host.ts` (`ShardHost` module docstring, item 4: "Alarms / scheduled wakeup"), `packages/platform/src/scheduler-host.ts` (module docstring, guarantee 2: "Durable persistence — scheduled jobs survive host recycling").

Both docstrings promise durability across "host recycling" without defining
what recycling means for a host that isn't Cloudflare. On Cloudflare,
"recycling" is DO eviction-and-rehydration: the **platform** owns re-delivery,
so an alarm set before eviction fires after rehydration even though the
process that set it is gone. A bare Node process has no such platform layer —
nothing re-arms a `setTimeout` after `node` itself restarts, and there is no
daemon to hand that responsibility to.

`packages/platform-node/src/node-shard-host.ts`'s `createAlarms` persists the
alarm timestamp to SQLite (so it CAN be read back after a restart) but does
**not** re-arm the timer on construction — deliberately, because doing so
half-way would be worse than not persisting at all: a caller reading `get()`
after a restart would see a "pending" alarm with no timer behind it, which
will never fire and never says so. `packages/platform-node/src/node-scheduler-host.ts`
has the identical gap for `SchedulerHost.schedule` and doesn't even persist —
it is honestly rated `"emulated"` in `NODE_CAPABILITIES` for exactly this
reason (see the Matrix section below).

**Classification:** contract-under-specification. The guarantee as written is
satisfiable to the letter by a host that (like Node here) provides zero
cross-restart durability, as long as it never claims otherwise — but the
prose reads as an unconditional promise, and a caller cannot currently tell
from the contract alone which of "survives in-process recycle" and "survives
a process restart" a given host actually offers.

**Proposed fix location:** `packages/platform/src/shard-host.ts` and
`scheduler-host.ts` docstrings — name the two tiers explicitly (in-process
recycle vs. process-level restart) and let `NODE_CAPABILITIES`'s `"emulated"`
rating on `shardAlarms`/`scheduler` be the honest signal for which tier a
given host clears, the way it already is now that a second host exists to
rate honestly.

## Finding 4 (contract-under-specification): "structured-clonable" does not pin a wire format

**Where:** `packages/platform/src/kv-store.ts` (`ShardKvStore.put`'s docstring: "the value must be structured-clonable; hosts serialize it durably").

Three hosts, three different serializers, and the contract is silent on which
one is correct:

- **Cloudflare** — the platform's own structured-clone implementation over DO
  storage: full fidelity (`Date`, `Map`, `Set`, `RegExp`, typed arrays, …).
- **The `node:sqlite` reference host** — an in-memory `Map`, calling Node's
  built-in `structuredClone()` on write. Same fidelity as Cloudflare, but only
  because it never has to leave memory.
- **`@lunora/platform-node`** — a real `better-sqlite3` `BLOB` column, which
  cannot store a live JS object at all. `packages/platform-node/src/node-kv-store.ts`
  uses `node:v8`'s `serialize`/`deserialize` (the same structured-clone
  algorithm V8 uses internally, round-tripping `Date`/`Map`/`Set`/`RegExp`/
  typed arrays) rather than `JSON.stringify` — genuinely closer to
  Cloudflare's fidelity than JSON would be. But `node:v8`'s own docs say this
  format is **not** a stable, cross-version wire format: a value written by
  one Node/V8 version is not guaranteed to `deserialize` on another. That is a
  real, disclosed limitation the contract's docstring gives no vocabulary to
  express.

**Classification:** contract-under-specification. "Structured-clonable" pins
the INPUT shape (what a caller may pass) but not the DURABILITY guarantee of
the chosen wire format, and the three hosts' actual guarantees genuinely
differ — Cloudflare and the reference host are stronger (any value that is
structured-clonable survives, full stop) than a disk-backed host has to be
(a value survives, but maybe not across a Node upgrade).

**Proposed fix location:** `packages/platform/src/kv-store.ts` — either commit
the contract to a specific format (which would make `ShardKvStore` no longer
storage-engine-agnostic) or explicitly document that wire-format stability is
host-defined and out of the contract's scope, so a caller storing a `Date`
across a Node version bump knows to check the host's own guarantee rather
than assuming the contract already covers it.

## Finding 5 (host-bug): the reference host's `durableAttachments` map is dead code

**Where:** `packages/platform/src/conformance/reference-host.ts` (`durableAttachments`, written in `accept` and `serializeAttachment`, never read).

Writing `packages/platform-node/src/node-socket-host.ts`'s first draft copied
the reference host's `restoreSocket(id, attachment)` shape — the durable
attachment tracked in a `durableAttachments` map on `accept`/
`serializeAttachment`, but `restoreSocket` trusting its caller-supplied
`attachment` argument instead of consulting that map. ESLint's
`sonarjs/no-unused-collection` flagged it immediately in `platform-node`
because that rule is a real error there — and checking the reference host
confirmed the identical map has been write-only since it was written: nothing
in `packages/platform/src/conformance/reference-host.ts` ever calls
`durableAttachments.get(...)`. This went unnoticed there because
`packages/platform/eslint.config.js` scopes `sonarjs/no-unused-collection:
"off"` to `src/conformance/**` as a blanket test-infrastructure exemption —
a reasonable exemption for genuinely test-shaped code, but one that also hid
a real latent bug in a shipped `/conformance` subpath export.

**Fixed in `platform-node`** (not just suppressed): `node-socket-host.ts`'s
`restoreSocket` now prefers `durableAttachments.get(id)` over the caller's
argument, falling back to the argument only for an id this host never
durably tracked. This is also more realistic than the original shape — a real
host restores from what it persisted, not from a copy the caller happens to
still be holding.

**Classification:** host-bug, found by contrast during construction — not a
`platform-node` bug (already fixed there) but a pre-existing one in the
sibling reference host it was built from.

**Proposed fix location (not done here — different package):**
`packages/platform/src/conformance/reference-host.ts` — either wire
`restoreSocket` to read `durableAttachments`/ignore its `attachment`
parameter, or remove the now-provably-dead map and its writes if the
parameter-trusting shape is intentional test-harness convenience. Either is a
small, contained fix; filed as its own tiny follow-up rather than made here to
keep this spike's diff to `platform-node` + the registrations it required.

## Finding 6 (host-bug-class): the reference host's read/write heuristic is weaker than necessary

**Where:** `packages/platform/src/conformance/reference-host.ts` (`sql.exec`: `trimmed.startsWith("select")`).

The reference host decides whether a SQL statement is a read (buffer rows) or
a write (no rows) by lower-casing and trimming the query text and checking
for a leading `"select"`. That heuristic misclassifies any writing statement
that does not start with `select` — a `WITH … INSERT …` CTE, or an
`INSERT … RETURNING …` — as a write with zero rows, silently discarding rows a
caller expected back.

`packages/platform-node/src/node-shard-host.ts` avoids the whole class of bug
by asking `better-sqlite3` itself: `Statement.reader` is the driver's own,
authoritative classification of whether a prepared statement produces rows,
computed from the statement's actual bytecode rather than its source text.

**Classification:** host-bug-class (latent, not currently triggered): neither
the platform TCK nor the engine TCK currently exercises a CTE-with-INSERT or
`RETURNING` statement against any host, so this has not caused a visible
failure — it is a correctness gap discovered by contrast (a better mechanism
existed and this spike used it), not by a red test.

**Proposed fix location:** `packages/platform/src/conformance/reference-host.ts`
— whether `node:sqlite`'s `DatabaseSync`/`StatementSync` exposes an
equivalent to `better-sqlite3`'s `Statement.reader` was not verified as part
of this spike (out of scope: fixing the reference host). If it does not, the
text-sniffing heuristic may be the best available option for that specific
engine, in which case the fix is a `RETURNING`/CTE regression test that pins
the known limitation rather than silently claiming full generality.

## Finding 7 (non-finding, recorded to prevent a re-investigation): mutable socket tags are not new

Initial assumption while designing `packages/platform-node/src/node-socket-host.ts`:
since a Node in-process registry can freely mutate a live socket's tags
(unlike Cloudflare, whose tags freeze at `acceptWebSocket`), `platform-node`
would be the first host in the repo to actually exercise `SocketHost`'s
optional mutable-tag tier (`setTag`/`removeTag`) and the TCK's "retags a live
socket when the host declares mutable tags" leg.

That assumption was wrong: `packages/platform/src/conformance/reference-host.ts`
already implements both `setTag` and `removeTag`, so that TCK leg has been
exercised since the reference host was written. `platform-node`'s
implementation is the same shape, and confirms — rather than newly exposes —
that the mutable-tag tier works. Recorded here explicitly so this isn't
re-"discovered" as a finding in a later pass over this doc.

## Finding 8 (TCK gap): `databaseSize` has zero conformance coverage on any host

**Where:** `packages/platform/src/shard-host.ts` (`ShardSqlExec.databaseSize`); `packages/platform/src/conformance/suite.ts` (no assertion references it).

`databaseSize` is documented as "a live getter... read as a live getter,
where the host provides one — do not cache it," but `defineHostContractSuite`
never asserts anything about it — not its presence, not its liveness (that it
changes after a write), not its absence-is-fine shape for a host that omits
it (the reference host omits it entirely; `platform-cloudflare` and, now,
`platform-node` both implement it). The "do not cache" requirement in
particular has no test that could ever catch a host that cached it by
mistake.

**Classification:** TCK gap — not a bug in any host (both real
implementations return a live, uncached number), and not exactly a contract
under-specification (the docstring is reasonably precise) — it's that the
conformance suite itself never grew a leg for this member, plausibly because
until this spike only one real host (`platform-cloudflare`) implemented it at
all and nothing forced the comparison.

**Proposed fix location:** `packages/platform/src/conformance/suite.ts` — add
a `ShardHost` leg, in the same optional-and-reports-the-gap style as
`bufferedAmount`'s: assert a plausible non-negative number where
`databaseSize` is defined, and (the actually load-bearing check) that it
changes after writing enough rows to move it, proving the host is not
returning a cached snapshot. Skipped, with a `toBeUndefined()`-style
assertion, for a host that omits it.

## Finding 9: zero new engine-coupling gaps — 229 generalizes

**Where:** the full run of `@lunora/shard-engine/conformance`'s
`defineEngineContractSuite` (OCC, RLS, reactive fan-out — the layer the
Convex-parity engine actually runs, not just the raw `ShardHost`/`SocketHost`
primitives) against `packages/platform-node/src/node-shard-host.ts` +
`node-socket-host.ts`.

This is the one this plan's WHY section was written to test: "every
under-specification this wave found ... was found by AUDIT, not
construction." `platform-node`'s host adapters were written from
`@lunora/platform`'s type definitions and doc comments alone — without
reading `@lunora/shard-engine`'s source — and then run, unmodified, against
both TCKs. Result: **38/38 pass** (28 host-contract legs + 10 engine-contract
legs), first run, no engine changes, no adapter patches needed after the
initial pass to make a test go from red to green.

That is a genuinely different outcome from the prior wave, which surfaced
`idFor` stability, the fail-open capability gate, and the unused tagged
fan-out — all real engine-coupling gaps the contracts had promised but not
delivered, all fixed on `advisor/229-platform-honesty` before this spike
started. This construction run is evidence those fixes **generalize**: they
were not Cloudflare-specific patches that happened to make the ONE existing
host pass, they were genuine contract corrections that a structurally
different host (synchronous embedded SQL + in-process socket registry,
vs. Cloudflare's DO storage + hibernation API) satisfies for free.

**Classification:** engine-coupling — **0 new gaps found**. Recorded as its
own finding rather than silently omitted, because "the contracts were
sufficient" is exactly the kind of result this spike was designed to either
confirm or refute, and a spike that found nothing here should say so plainly
rather than let the other, real findings crowd it out.

---

## Matrix (Step 3)

`NODE_CAPABILITIES` was added to `packages/platform/src/capabilities.ts`,
rating every feature `CLOUDFLARE_CAPABILITIES` rates (enforced by a test in
`packages/platform/__tests__/contracts.test.ts` that the two matrices' feature
key sets match). Honest ratings for a bare Node process with no
Cloudflare-product bindings:

| Feature                                                                                                                                                                             | Level       | Why                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `localSql`                                                                                                                                                                          | native      | Real `better-sqlite3`, synchronous, embedded                                                                                  |
| `shardedState`                                                                                                                                                                      | emulated    | One database per shard key, one process — no distributed placement/failover                                                   |
| `websocketHibernation`                                                                                                                                                              | emulated    | In-process registry proves attachment/tag durability across a simulated recycle; nothing is ever actually evicted from memory |
| `shardAlarms`                                                                                                                                                                       | emulated    | In-process `setTimeout`; see [Finding 3](#finding-3-contract-under-specification-durable-does-not-say-durable-against-what)   |
| `scheduler`                                                                                                                                                                         | emulated    | Same as `shardAlarms`, plus no dynamic cron                                                                                   |
| `keyValueStore`                                                                                                                                                                     | emulated    | A SQL table behind the `ShardKvStore` API, not a dedicated KV product                                                         |
| `globalTables`, `crossShardFanout`, `queues`, `workflows`, `objectStorage`, `vectorStore`, `ai`, `browser`, `containers`, `analytics`, `pipelines`, `mail`, `secrets`, `hyperdrive` | unsupported | No binding implemented for any Cloudflare-specific product                                                                    |

`PLATFORM_MATRICES` in `packages/codegen/src/platform-target.ts` now includes
`node: NODE_CAPABILITIES`. Verified end-to-end:

- `packages/codegen/__tests__/platform-target.test.ts` — `gatePlatformFeatures(usage, "node")`
  flips `browser`/`container` off (unsupported) and reports
  `platform_unsupported_feature` diagnostics for both, while leaving
  `kv`/`scheduler` on (emulated is still a working surface) with no
  diagnostic.
- The same file's `runCodegen`-level test confirms a project declaring
  `{ "target": "node" }` in `lunora.json` resolves through the real registry
  (no `platform_unknown_target`), the same shape the existing "aws" test
  proves for an unregistered target.

This is what actually exercises 229's fail-closed gate for the first time
against a matrix that is mostly `unsupported`/`emulated` rather than the
all-`native`-or-`emulated` Cloudflare matrix, which never took the
`platform_unsupported_feature` branch in practice.

## Explicitly out of scope (per plan)

- Wiring `@lunora/platform-node` into `lunora dev` — the payoff, a follow-up.
- A `@lunora/config` deploy driver for `node` — see [Finding 1](#finding-1-registry-gap-platformmatrixids-and-deploytargetids-conflated-two-different-questions); a spike host is not a deploy target.
- Fixing any of the engine-coupling gaps this discovery surfaced — there were
  none ([Finding 9](#finding-9-zero-new-engine-coupling-gaps-229-generalizes)), so there is nothing to file there. The two host-bugs found in
  the _reference host_ ([#5](#finding-5-host-bug-the-reference-hosts-durableattachments-map-is-dead-code), [#6](#finding-6-host-bug-class-the-reference-hosts-readwrite-heuristic-is-weaker-than-necessary)) and the `ShardDirectory.jurisdiction` architecture gap
  ([#2](#finding-2-contract-under-specification-shard-directoryjurisdiction-has-zero-real-callers)) are real but sized for their own follow-up plans, not this one.

---

# Update — durability hardening (commit `ae75f844`)

The spike's ratings above are superseded for four features. Everything the
spike _discovered_ stands; what changed is that three of the gaps it recorded
as inherent turned out to be missing code rather than missing platform.

## What closed, and why the original reasoning was wrong

[Finding 3](#finding-3-contract-under-specification-durable-does-not-say-durable-against-what) argued that persisting an alarm timestamp without a
host-level daemon to re-deliver it would be _worse_ than not persisting —
because a caller reading `get()` after a restart would see a pending alarm that
never fires. That is true of persistence alone, and it quietly assumed the
re-arm had to come from outside the process. It doesn't: the next construction
of a host over the same database file is itself the wake, and reading the row
back there is the whole fix. The same argument had been copied into the
scheduler, which is why that contract was implemented entirely in memory.

| Feature                | Was                                                     | Now      | What changed                                                                                                 |
| ---------------------- | ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `shardAlarms`          | emulated, "nothing re-arms it on restart"               | emulated | Re-armed on construction; an elapsed alarm fires late rather than never; delivery via a new `onAlarm` option |
| `scheduler`            | emulated, "not durable, no dynamic cron"                | emulated | SQLite job table re-armed on construction, retry backoff, dead-letter, and runtime `cron`                    |
| `websocketHibernation` | emulated, "survives a simulated recycle, not a restart" | emulated | Attachments and tags in `_lunora_sockets`; survives a real restart                                           |
| `globalTables`         | unsupported                                             | emulated | The `@lunora/sql-store` core on its own SQLite file via the reference `sqliteDialect`                        |

The levels mostly did not move, and that is the matrix's definition working as
intended: `native` means the _platform_ provides the feature, and Node provides
none of these. The notes carry the real information, and three of them had
become false.

`crossShardFanout` and the deploy driver remain as recorded.

## Finding 10 (layering): the reference SQLite dialect lives in `@lunora/d1`

`sqliteDialect` is the reference `SqlDialect` the store core was written
against, and every SQLite-backed target needs it — but it lives in
`packages/d1/src/sqlite-dialect.ts`, so `@lunora/platform-node` now depends on
a package called `d1` to get it. Nothing about it is Cloudflare-bound
(`@lunora/d1`'s dependencies are `errors`, `platform`, `shard-engine`,
`sql-store`, `drizzle-orm`; the `@cloudflare/workers-types` reference is
type-only), so this is a naming smell rather than a layering violation — but it
is the second consumer, and `@lunora/sql-store`'s own tests already keep a
third, hand-rolled copy specifically to avoid depending on a downstream
package.

**Proposed fix**: move `sqliteDialect` into `@lunora/sql-store` beside the
`SqlDialect` contract, re-exporting from `@lunora/d1` for its existing callers.
Not done here because it also requires moving `sqlAffinityForKind` out of
`@lunora/d1`'s `dialect.ts`, which the CLI migration emitter imports — a
three-package refactor unrelated to this target.

## Finding 11 (host-bug-class): TypeScript narrows `database.open` across an `await`

The scheduler's delivery path guards every statement on `database.open`,
because a timer can outlive a `close()` and a statement on a closed
better-sqlite3 connection throws synchronously inside the timer callback, where
no caller's `try`/`catch` can reach it.

After an early `if (!database.open) { return; }`, TypeScript narrows the
property to `true` for the rest of the function — and then
`@typescript-eslint/no-unnecessary-condition` reports every later check as
redundant. It is exactly wrong: an `await` sits in between, and the caller may
have closed the connection during it. Taking the lint at face value would have
deleted the guards that make the timer safe.

The fix is a one-line `const isOpen = (): boolean => database.open;` so each
check stays a real runtime read. Worth knowing generally: any `readonly boolean`
liveness flag re-checked after an `await` will attract the same false positive,
and `@lunora/platform-cloudflare` has the same shape in `execSql`'s call-time
probing.
