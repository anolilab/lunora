## @lunora/agent [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.93...@lunora/agent@1.0.0-alpha.94) (2026-09-06)

### Tests

* **dispatch,queue,workflow,agent,do:** pin both halves of the ctx.run wire bracket ([#645](https://github.com/anolilab/lunora/issues/645)) ([9fd8827](https://github.com/anolilab/lunora/commit/9fd882739609734a3db51b45b27c380062e4b9ff))


### Dependencies

* **@lunora/workflow:** upgraded to 1.0.0-alpha.48

## @lunora/agent [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.92...@lunora/agent@1.0.0-alpha.93) (2026-09-06)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.107

## @lunora/agent [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.91...@lunora/agent@1.0.0-alpha.92) (2026-09-06)

### Bug Fixes

* **agent,ai,ratelimit,x402:** point prettier at the repo ignore file ([#638](https://github.com/anolilab/lunora/issues/638)) ([bf2a8e7](https://github.com/anolilab/lunora/commit/bf2a8e7e50019149ddf3a50f38adbb91f6e0351b))


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.76
* **@lunora/server:** upgraded to 1.0.0-alpha.106

## @lunora/agent [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.90...@lunora/agent@1.0.0-alpha.91) (2026-09-06)

### ⚠ BREAKING CHANGES

* **dispatch,scheduler:** `ctx.run(...)` now resolves the function's return value instead of the raw
`{ result }` envelope. A caller that compensated by reading `.result` must drop that unwrap.

The existing mocks all answered a bare `{ ok: 1 }`, which is exactly why this shipped green; they
now answer a realistic `{ result: encodeWire(value) }` envelope, plus a bigint/bytes/Date/NaN
round-trip in both directions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(runtime): decode a scheduled workflow's args before create({ params })

Review of the wire-bracketing change caught a regression the change itself
introduced. `ctx.scheduler.runAt` now stores `encodeWire(args)` in one envelope
that both dispatch targets share, but only one of them decoded it: a function
target's args are decoded by the shard, while a workflow target never reaches the
shard — `handleSchedulerDispatch` hands them straight to `create({ params })`.

So `runAt(when, workflows.foo, { total: 5n })` started an instance whose
`event.payload.total` was `["$lunora.wire$", "bigint", "5"]`. Before the encode
landed it threw on `JSON.stringify` instead, which is wrong but loud; this turned
it into a silent corruption, which is worse.

The workflow branch now decodes, so the two targets are symmetric. The docblock on
the encode named only the shard's decode and now names both, because a reader
checking whether the round trip closes would have concluded from it that it did.

The regression test drives the workflow branch with a `Date` and a bigint past
float range and asserts what `create()` receives; it fails against the un-decoded
version and passes with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(runtime): bracket the httpAction scheduler on the same wire as the shard

`ctx.scheduler` on an httpAction context and `@lunora/scheduler`'s
`createScheduler` write to and read from the SAME SchedulerDO records, but only
the shard-side one encoded on write and decoded on `list()`/`get()`. So
`ctx.scheduler.runAt(t, internal.billing.settle, { amount: 1234n })` from a
webhook threw outright (`JSON.stringify` refuses a bigint), and a record
scheduled from a shard read back through the httpAction's `get()` as the tagged
`["$lunora.wire$","bigint","1234"]` tuple while `ctx.db.system.query
("_scheduled_functions")` on the same record answered `1234n`. Both surfaces now
encode on write and decode on read.

`get()` also returned the DO's `{ record }` envelope rather than the record, and
`{}` rather than `null` for an id that matched nothing — both breaking its
declared `Record<string, unknown> | null` and diverging from
`createScheduler.get()`. It unwraps now.

The admin proxy behind the studio's scheduled-jobs and dead-letter panels keeps
forwarding records verbatim, deliberately: it re-serializes with
`JSON.stringify`, which throws on the very bigint the encode exists to carry, so
decoding on the way through would turn any such job into a 500. `@lunora/client`
decodes at the consumer instead (`listScheduledJobs`, `listDeadJobs`, and the
`subscribeScheduledJobs` live push, which the proxy could never have covered).

Reject a dispatch response body that is not a `{ result }` envelope. `typeof []
=== "object"`, so a 200 body of `[1,2,3]` — or one with no `result` key — slipped
the object guard and resolved `decodeWire(undefined)`, i.e. `undefined`, as "the
function returned nothing". A genuine `undefined` return is emitted as
`{"result":["$lunora.wire$","undefined"]}` with the key always present, so
requiring it costs nothing.

Route all four call-envelope producers through one
`encodeArgsOrThrow(label, path, args)` in `shared/wire-codec.ts`. `encodeWire`
throws on any non-plain object; three of the four sites dropped the labelled
error the fourth had, so a bad argument left a bare unattributable `TypeError`
from `ctx.run` / `ctx.scheduler.runAt` / `pool.enqueue` — useless on a scheduled
job debugged from a log line.
* **dispatch,scheduler:** `encodeWire` rejects any non-plain object INCLUDING one with a
working `toJSON()`, which `JSON.stringify` honoured. So
`ctx.scheduler.runAfter(60_000, internal.billing.charge, { amount: new
Decimal("9.99") })` — which serialised before — now throws at schedule time.
Loud rather than silently wrong; pass a plain value instead.

The same wire-bracketing rationale had been restated five times across three
files (~25 comment lines against ~15 of code), which is how the scheduler
docblock came to be wrong without anyone noticing. One canonical note now lives
at the dispatch runner's encode; the rest point at it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(workflow): decode a scheduled workflow's params where the handler reads them

Review caught that the earlier fix put the decode on the wrong side of the seam.
Workflow `params` are JSON-serialised by Cloudflare into durable storage, so
decoding before `create({ params })` fails creation outright on a `bigint` and
silently flattens a `Date` back to a string — the wire form was the only shape
that could survive that hop intact.

The dispatch branch now passes the encoded args through untouched, and
`createRunContext` decodes at `params`, which is the first point that can hand a
handler real `bigint`/`Date`/bytes values. `decodeWire` is identity on pure JSON,
so a directly created or spawned instance is unaffected.

Both sides are pinned. The runtime test asserts the boundary still carries the
wire form — decoding there is what breaks creation — and the workflow test
asserts the handler receives the decoded values; it fails against the raw payload.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ
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

* **dispatch,scheduler:** wire-bracket ctx.run so it returns the value, not the envelope ([#615](https://github.com/anolilab/lunora/issues/615)) ([404264a](https://github.com/anolilab/lunora/commit/404264a805812b080a8298ff33e10c70e224ca2f))
* **observability,agent:** make the trace say what actually happened ([#618](https://github.com/anolilab/lunora/issues/618)) ([c07f788](https://github.com/anolilab/lunora/commit/c07f788836fb5724002a80a2031b88a033e304d0))


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.74
* **@lunora/errors:** upgraded to 1.0.0-alpha.33
* **@lunora/mail:** upgraded to 1.0.0-alpha.65
* **@lunora/server:** upgraded to 1.0.0-alpha.105
* **@lunora/values:** upgraded to 1.0.0-alpha.41
* **@lunora/workflow:** upgraded to 1.0.0-alpha.47
* **@lunora/container:** upgraded to 1.0.0-alpha.46

## @lunora/agent [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.89...@lunora/agent@1.0.0-alpha.90) (2026-09-05)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.104

## @lunora/agent [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.88...@lunora/agent@1.0.0-alpha.89) (2026-09-05)

### Bug Fixes

* **client,react:** encode SSR payloads and stop three surfaces silently blanking ([#607](https://github.com/anolilab/lunora/issues/607)) ([a17366a](https://github.com/anolilab/lunora/commit/a17366a43ca0ea2a69f05912d68a678a0450c270))


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.73
* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/mail:** upgraded to 1.0.0-alpha.64
* **@lunora/server:** upgraded to 1.0.0-alpha.103
* **@lunora/values:** upgraded to 1.0.0-alpha.40
* **@lunora/workflow:** upgraded to 1.0.0-alpha.46
* **@lunora/container:** upgraded to 1.0.0-alpha.45

## @lunora/agent [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.87...@lunora/agent@1.0.0-alpha.88) (2026-09-04)

### ⚠ BREAKING CHANGES

* `@lunora/config/cloudflare` exports `mergeWranglerEnvironment`,
and `WranglerConfig["placement"]` gains `region` / `host` / `hostname`.

Declined: D6 — `triggers` and `compatibility_date` are both `inheritable` in
wrangler, so the top-level write is correct for every environment that does not
override them, and the bindings reconciler already prints the top-level-only
advisory on the same run. D7 is inert until a second toolchain driver exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent,mcp): close the traversal, retry-storm and prototype-lookup gaps

The MCP documentation corpus is exposed twice — as tools and as resources — and only the tool
path applied the URL guard. `lunora_get_doc` normalises the model-supplied `url` and rejects `..`,
`%2e%2e`, `%252e` and backslashes; `resources/read` stripped the `lunora-docs:` prefix and handed
the remainder straight to the index, which appends it to `/llms.mdx` and fetches. Both
`lunora-docs:/../../admin/secrets` and its percent-encoded form resolved to
`https://<docs-origin>/admin/secrets` and returned that page as documentation. The hosted docs
site is unaffected (its index is a slug map); the local server pointed at a self-hosted
`--docs-url` — the internal-host case the guard's own docblock names — is not. `read` now routes
through the tool's `normalizeDocUrl` rather than repeating its checks, so the two callers cannot
drift apart again.

The loop's "invalid input, let the model recover" branch never fired for a batteries-included
tool. A bare `jsonSchema()` carries no validator, and the AI SDK's `safeValidateTypes` returns
success unchanged when `validate == null`, so a wrong-typed model argument was never marked
`invalid`: it reached `execute`, the dispatched function answered 400, and that threw inside the
loop's native `step.do`, which knows nothing of `isDeterministicDispatchFailure` and retried the
same deterministic 400 until the run failed. The tool step now converts a branded deterministic
dispatch failure into a tool-result row the next turn can read, the way `@lunora/workflow`'s
`createRunStep` does; transient failures keep the host's retry. The `codeTool` documentation
claimed each step's input "is validated against that tool's own `inputSchema`" — it now says what
the check actually depends on.

A voice control frame was cast to the closed `VoiceClientFrame` union straight off `JSON.parse`,
and everything the tail did not recognise was treated as a text turn. So `{type:"x",text:…}`
skipped the 4 000-character bound (keyed on `type === "text"`) and reached the model measured only
against the 17 024-character raw-frame limit, while `{"type":"text"}` read `.length` off
`undefined`. Frames are now narrowed by a real predicate and an unknown one is refused before the
thread round-trip and the session-turn counter.

`codeTool` resolved model-supplied names with `in` and bare indexing, both of which walk the
prototype chain: a step naming `constructor`/`toString`/`__proto__` found a truthy non-tool and
died on `tool.execute is not a function` — a TypeError the host retries — instead of the
documented BAD_REQUEST, and `$from: "constructor"` handed a composed tool the `Object`
constructor as an argument. Both now use `Object.hasOwn`, matching `getPath` in the same file.

`approvalTimeout: 0` was accepted and clamped only from above, so `step.waitForEvent` elapsed
immediately and every human-in-the-loop tool was recorded as "approval timed out" and reported to
the model as a user rejection before a client could render the marker. Validated at declaration
time on the resolved milliseconds, so the string form and `NaN` are covered too.
* `defineAgent` now throws on an `approvalTimeout` that resolves to zero or less.
A tool call that fails with a deterministic dispatch error is persisted as a tool-result row and
the run continues, where it previously failed the run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(templates): make every scaffold deployable, and gate on it

Three templates could not be deployed at all from a fresh scaffold. None of it was visible to
any gate, because the template smoke matrix builds and typechecks but never tried to deploy.

analog: `main` pointed at Nitro's `cloudflare-module` output, which is a single
`export default createHandler(...)` — it re-exports nothing, and nitropack 2.13.4 has no hook that
appends named exports to it (`exports.cloudflare.ts` was fiction; zero hits across its `dist/`).
`wrangler deploy` rejected every scaffold with "Durable Objects … not exported in your entrypoint
file: ShardDO". Replaced with a root `worker.ts` wrapper re-exporting Nitro's handler plus
`ShardDO`, the shape the Nuxt template already uses, and deleted `exports.cloudflare.ts`.

astro: the composed entry was `src/worker.ts`, which `lunora deploy` treats as a SvelteKit-shaped
entry and passes to wrangler POSITIONALLY. The @astrojs/cloudflare adapter writes a deploy redirect
carrying `no_bundle: true`, so that positional was uploaded as the worker verbatim — 1.4 KiB of
untranspiled TypeScript, exit 0, binding table printed. Renamed to `src/server.ts` (matching
solid-v2), so the positional never fires and wrangler ships the adapter-built
`dist/server/entry.mjs` (17 modules) it was always meant to.

nuxt + analog: no `assets` binding. Nitro's Cloudflare runtime serves client assets only via
`env.ASSETS`, so SSR HTML rendered and every `/_nuxt/*` and `/assets/*` request 404'd. Bound each
preset's own `output.publicDir`.

next: `lunora verify|deploy|dev` probe the root `wrangler.jsonc` and require the SHARD binding, but
the root config was the OpenNext SSR worker, so a fresh scaffold failed `lunora verify`. Swapped the
two: the Lunora worker takes `wrangler.jsonc`, the SSR worker becomes `wrangler.opennext.jsonc`,
and every OpenNext command is passed `--config` (build, preview and deploy all accept it).

@lunora/astro only recognised `withLunora(` as the composition seam, so the scaffold's
`.buildFrameworkWorker(host)` — what every class-B template uses — warned "subscriptions will
silently 404" on every build of a correctly composed worker.
* the astro template's composed entry is `src/server.ts`, and `@lunora/astro`'s
default `serverEntry` follows it. The next template's `wrangler.lunora.jsonc` is now the root
`wrangler.jsonc` and its OpenNext config is `wrangler.opennext.jsonc`.

The gate: `scripts/template-build-smoke.sh` now runs each template's own deploy path as a
credential-free dry run and checks four things, because each defect above needs a different one —
the exit code catches analog, the emitted bundle catches astro (a `.ts` file in a worker bundle
means the entry was never transpiled), and the printed binding table catches the missing assets.
Templates that pass `validateWrangler: false` to the Vite plugin keep it; they are gated here at the
deploy boundary instead. Also fixes stale template docs: the nuxt and astro READMEs documented
loader files that do not exist, and the init picker called both single-worker templates "a
standalone Lunora worker".

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sdks): pin the codec behaviours the fixtures never asserted

The case list was not known to be complete, and where it was silent the ports
drifted silently. Enumerating the reference codec branch by branch — every tag,
every payload guard, every re-encode — against the fixtures turned up 58 behaviours
with no case that would fail if a port got them wrong, four of which were already
wrong in every port.

`sdks/README.md` now carries the derived coverage matrix: one row per reference
behaviour, the case that pins it, and for the five that stay unpinned the
measurement that says why.

Found by adding the cases first and recording which ports went red:

- A `set` never de-duplicated. The reference decodes into a real `Set`, so its
  items collapse under SameValueZero like map keys do; all eight carried both
  copies and re-encoded a set the reference cannot emit. Same identity helper,
  now applied to both.
- A duplicate map key replaced the stored KEY as well as its value.
  `Map.prototype.set` keeps the key it holds, so `[[0,"a"],[-0,"b"]]` re-encodes
  with the `0` it first held. Invisible until a signed zero collapsed onto an
  unsigned one; wrong in all eight.
- SameValueZero holds -0 equal to 0, and every port's number formatting kept the
  sign, so a signed zero was its own map key and its own set item.
- A `bigint` digit string was carried verbatim in rust and swift, where the
  reference canonicalises through `BigInt().toString()` — `"007"` re-encoded as
  `"007"`, and the two ends keyed one subscription two ways.
- rust narrowed a negative zero to i64 while building the encoded tree, so the
  stable key spelled it `0`. `stableStringify` reads that tree and has its own
  `-0` branch, so the narrowing handed `{ "a": -0.0 }` the cache key of
  `{ "a": 0 }`. It now stays f64, which spells `-0.0` on the wire where the
  reference spells `0` — the same number to every JSON reader, and the lesser of
  the two divergences the value model forces.

New cases that every port already satisfied are kept as regression pins and named
as such in the matrix: the eight untested typed-array constructors (their tables
were complete, which the paired misalignment rejections prove), the unknown-tag
re-escape, and twenty-one payload-slot rejections.

Deliberately not pinned, each measured: a lone surrogate in a stable key (ruby's
JSON parser rejects the fixture file outright, go's substitutes U+FFFD — neither
can carry the input, and neither can reach the value on a real wire); an `Error`
`name`/`message` that is not a string, where the reference is JS-accidentally
lenient; and `Error` own props carrying `__proto__`, which the reference's encode
side drops through the prototype setter its decode side guards against — a defect
to fix there rather than freeze into eight languages.

Two capability rows added for gaps the manifest may not hold, since it can only
require behaviour every port has: no port merges a row `delta` into a cached list
(all eight replace the value with the row-change envelope), and none handles the
`chunk` or `whisper` frames.

Executed cases, before -> after: python 98 -> 98, go 168 -> 226, ruby 77 -> 77,
rust 9 -> 9, swift 11 -> 11, java 331 -> 389, kotlin 336 -> 394, dart 82 -> 82.
The counters that did not move report suites, not fixture rows; the fixtures grew
from 62 to 108 wire cases and from 12 to 24 stable-key cases in every leg.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(protocol): guard __proto__ in the error branch of encodeWire

`encodeWire`'s `Error` branch built its props object with a plain
`properties[key] = …`, while its own plain-object branch and both decode
branches route `"__proto__"` through `Object.defineProperty`. For that one key
the assignment fires the prototype SETTER instead of creating an own property,
so `["$lunora.wire$","error","E","m",{"__proto__":{"p":1}}]` — which `decodeWire`
correctly reconstructs with `__proto__` as an own data property — re-encoded as
`{}`. The field was silently dropped on every re-encode, and the props object
itself came back wearing a wire-supplied prototype, which `JSON.stringify` hides.

The branch now uses the same `UNSAFE_KEY` guard as its three siblings, so the
one spelling is consistent across all four sites that rebuild a wire object. It
was the only unguarded write left in the file.

`protocol/fixtures/wire-codec.json` gains `error-proto-key`, the `error`-tag twin
of the existing `proto-key` case. All eight non-JS ports already passed it
unchanged — `__proto__` is an ordinary map key everywhere but JS — so this was a
reference-only defect, and the fixture now pins correct behaviour rather than the
bug. `packages/client/__tests__/wire-codec.test.ts` adds the pollution axis the
JSON round trip cannot see: the encoded props object must still have
`Object.prototype`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(cli,config,astro,d1): close nine scaffold, dev and parsing defects

`lunora init` followed a symlinked target. `cwd/<name>` was probed with `existsSync`, which
resolves the link, so a link pointing at an empty directory passed the emptiness check and
became the scaffold target: writes landed outside `cwd`, and the reset path — which empties a
pre-existing target back out — would delete files there the run never wrote. The target is now
probed with `lstat` and a symlink is refused. Every scaffold path routes through that one gate.

A scaffold that threw mid-copy left its partial writes behind. `copyTemplate` writes
sequentially, so an fs failure lands after earlier files are already on disk, and
`runInitCommand` rethrew with the target still there — the retry, with the cause fixed, was then
refused with "target directory not empty". The throw path now resets, and the copy marks the
target complete the moment it finishes, so a failure in the reporting that follows cannot delete
a project that was fully written.

The interactive checklist announced "Project initialized!" as soon as the copy task finished,
which is before the empty-template check can fail the run — an empty remote template printed
success and then exited 1. The header is now a neutral statement of what the tasks did; the one
success line still comes after the check.

`lunora dev --remote` snapshotted `wrangler.jsonc` into the temp config wrangler is spawned with
BEFORE provisioning the bindings the project's code implies, so the worker ran with a config one
binding short. Provisioning — and the target resolve — now happen ahead of the plan, which also
closes the window that could orphan the temp config.

`tuiTasks` waited unconditionally for the task chain to settle on its error path. The Ctrl-C
listener attaches in a layout effect while the chain starts in a passive one, so an interrupt in
between ended the app with nothing left to settle and the CLI hung forever. The wait is now
armed by the chain actually starting, and still covers an in-flight task.

The deploy preflight dereferenced `d1_databases` entries after only an `Array.isArray` check, so
`"d1_databases": [null]` threw a TypeError out of a gate instead of letting the validator report
the malformed config. Nullish entries are dropped at the one normalisation boundary the gates
read through.

`reconcileDurableObjects` replayed the `migrations` list without normalising it, so a stray
`null` record, rename entry or class name threw out of a step that runs on every dev-server
start. It now reuses the validator's own `objectBindingEntries` / `stringEntries`, which already
fold the identical hand-edited list.

`@lunora/astro`'s composition check scanned raw source, so a commented-out or quoted
`withLunora(...)` suppressed the "`/_lunora/*` will be unrouted" warning for an entry that
composed nothing. Comments and string literals are blanked before the probe runs; a template
literal's interpolations are kept, because those are real code.

The `CREATE TRIGGER` probe in `@lunora/d1` allowed only whitespace between the keywords, so
`CREATE /* comment */ TRIGGER` — which SQLite accepts — stopped reading as a trigger and its
body's first `;` was rejected as a second statement.

Reviewed and declined: `containers` stays in `NON_INHERITABLE_KEYS`. wrangler's own config
resolver registers it through `notInheritable(...)` with a `void 0` default, and warns that the
key "is not inherited by environments" — so resolving it to `undefined` for an environment that
omits it is exactly what wrangler does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix: stop replays, transports and gates from dropping work silently

Six defects that all share a shape: something that looked handled was quietly discarded.

`step.do` memoizes BY NAME, and the tool step's name (`tool:<name>:<id>`) did not change when
its memoized value became an outcome envelope. A run parked across that deploy — approval
hibernation, a long multi-turn — resumes and is handed the OLD raw output back, which the new
code read as an envelope: the tool row persisted as `"undefined"` (poisoning every later turn
AND every later run on the thread) or, for a string/number/null memo, threw `Cannot use 'in'
operator`. The outcome now travels behind a wrapper key, and anything arriving without it is
read as the raw output it was. A distinct wrapper rather than probing the value: `{ ok: true }`
is an ordinary tool result, and a bare probe unwraps it to `true`.

The same tool path persisted a deterministic failure's text raw while the success path capped
it. `outcome.failed` is a server-supplied, unbounded message on a row re-rendered into every
later turn, so it is capped identically now.

The Python client synthesized an `INTERNAL` error envelope for an unreadable error body. That
routes through `parse_rpc_response` as a coded VERDICT, and `INTERNAL` is in neither
`TRANSIENT_ERROR_CODES` nor `RATE_LIMIT_ERROR_CODES` — so the offline queue settled the write
terminally. A 302 from a load balancer or a WAF's HTML page on a 4xx dropped a queued durable
write. Returning the status with no envelope restores the transport branch (`transient=True`)
that the other seven ports take. The redirect refusal itself is unchanged.

`mergeWranglerEnvironment` was exported without its return type, so a consumer could call it
but not name its result. `WranglerEnvironmentMerge` is exported now, and the CLI's composed
worker entry imports `COMPOSED_WORKER_ENTRY` instead of repeating the literal a docblock asked
it to keep in sync by hand.

`.gitignore` appends land BELOW what the file already had and git takes the last match, so
adding `.dev.vars.*` under an existing `!.dev.vars.example` re-ignored a file the templates
ship. Both writers — `lunora deploy`'s secret guard and the `lunora init` overlay — now
re-state their negations after the additions.

The template smoke matrix's TypeScript-in-bundle gate ran `find` on a directory it never
checked existed. `find` exits 1 there, `pipefail` carries it through `head`, and because both
call sites are `if ! run_deploy_dryrun …` — which suppresses errexit — the gate passed
VACUOUSLY on the one run where no bundle was emitted. It now fails with a reason.
* `@lunora/astro`'s `lunora()` integration defaults `serverEntry` to
`src/server.ts`, not `src/worker.ts`. A project on the old name and no explicit `serverEntry`
warned "not found" on every build; it now gets a warning naming the rename, why the old path
is unsafe for Astro (`lunora deploy` passes it to wrangler positionally, and the adapter
redirect's `no_bundle` then uploads it untranspiled), and the option that keeps the old name.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* make every template deployable, and close the SDK, deploy and adapter gaps ([#591](https://github.com/anolilab/lunora/issues/591)) ([2630283](https://github.com/anolilab/lunora/commit/26302835bdd4b02dccbed5e8e6e7b8705ff4f155))

## @lunora/agent [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.86...@lunora/agent@1.0.0-alpha.87) (2026-09-04)

### ⚠ BREAKING CHANGES

* the KV mutual-exclusion error is raised with code `BAD_REQUEST`
instead of `INTERNAL`, and it now fires from the admin `putValue` path as well as
`createKv`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(vite): materialize the remote wrangler config after bindings are provisioned

`planViteRemoteBindings` ran at plugin-factory time, before any Vite hook. The temp
config it writes is a copy of `wrangler.jsonc` with `"remote": true` injected on each
eligible binding, and Lunora provisions the bindings the project's code implies from
`wranglerValidatorPlugin`'s `config` hook — so the copy was always taken one write too
early. Under `LUNORA_REMOTE` the cloudflare plugin was then pointed at a snapshot that
predated the provisioning, and the dev worker booted without the binding that had just
been written. This is the remote twin of the local defect that moving the reconcile into
`config` closed; that move did not reach this path.

Observed live against a real account on an example app: `vite dev` logged
"inferred bindings -> AI (Workers AI) (written to .../wrangler.jsonc)", the file on disk
gained `"ai": { "binding": "AI" }`, the materialized temp config did not, and a probe
route reported `["DB","LUNORA_ADMIN_TOKEN","SHARD","WORKER_ENV"]`. After the change the
same probe reports `["AI","DB","LUNORA_ADMIN_TOKEN","SHARD","WORKER_ENV"]` and the temp
config carries `"ai": { "binding": "AI", "remote": true }`.

Materialization now happens in the `config` hook, which is registered after the
validator's and therefore runs after it (both are `enforce: "pre"`). The build gate moves
with it, so `vite build` no longer writes a temp config it never uses. Cleanup folds into
the same plugin because the disposer cannot be captured before the plan exists; a
re-entered `config` hook disposes the previous generation rather than orphaning its file.
* `remoteBindingsConfigPlugin` and `remoteBindingsCleanupPlugin` are
replaced by a single `remoteBindingsPlugin(options, planOptions)`, which takes the plan
inputs rather than an already-materialized plan.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(notify): close the register-side takeover and the dead-device blackout

`ctx.push.register()` upserted a subscription with `user_id = ?` in the `DO UPDATE SET` list, so
registering an endpoint already stored for someone else re-owned it. The id is derived from the
endpoint, i.e. a caller-controlled key — the same precondition `unregister` was given an atomic
`deleteOwned` for. Registering a victim's endpoint with garbage keys under your own id took their
device dark (an encryption failure is not a gone signal, so it was never pruned either) and handed
you `unregister` over it. Both stores now refuse a put that would move a row to a different owner —
D1 in the `ON CONFLICT … DO UPDATE`'s own `WHERE`, memory with no await between check and write —
and the legacy-prefix eviction inside `put`, a DELETE on a different primary key the guarded upsert
never sees, is scoped the same way (with the CLAIM predicate, so an anonymous device that signs in
still loses its old row).

FCM dead tokens were never detected as gone. The provider forwards `body.error.message` only, and
FCM HTTP v1 keeps `UNREGISTERED` in `error.details[].errorCode`, which it drops — so the codes
`isGoneError` matched could not arrive and every uninstalled device stayed registered forever, was
re-POSTed on every broadcast, and counted `failed`. Match the `NOT_FOUND` prose the transport
actually emits, still scoped to FCM.

A gone subscription also cost four POSTs and ~2.2 s of backoff before being deleted, because
`retryMiddleware` had no `shouldRetry`; those attempts then fed a circuit breaker whose counter is
closure state shared by every channel, so two dead devices blacked out `chat`/`webhook`/`inApp` for
30 s — and the second device's result became `Circuit open`, which is not a gone signal, so it
survived to repeat it. Permanent failures are no longer retried, and the breaker is per provider and
ignores them; it still opens for five consecutive transient failures.

On the retry path a gone receipt was reported `failed`, so the pruned id went back into `failedIds`
and the narrower retry could only throw `no registered subscription` until the queue dead-lettered
an unsubscribe. It settles as `expired` now, kinded by the id's own prefix, as does an id whose row
is already gone.

Seeded `email` columns used faker's `free_email` default, so generated rows carried deliverable
gmail/hotmail/yahoo addresses; seed a staging database, run any user-driven mail flow, and the app
mails real strangers from its own verified domain. They are built on the RFC 2606 reserved
`example.com` now — goldens regenerated, since an explicit provider also shifts faker's draw.

Also: the mail capture sink logs when it has nowhere to record instead of returning a success-shaped
`uncaptured` in silence; the inbound `verify` gate proceeds only on `true`/`undefined` rather than
on anything but `false`; the queue recipe and `idempotencyKey` docs say that consumer-side dedupe is
the only mechanism, since no transport can reach Resend's `Idempotency-Key` request header; the
studio seed host answers `409 fk-parents-empty` (a code its client already decoded and nothing ever
sent) instead of returning children whose fabricated parents it drops; and `flagshipProvider`
refuses a literal empty `authToken` as the thunk path already did.
* `SubscriptionStore.put` must refuse a put that would move a row to a different
owner, and `ctx.push.register()` now rejects with `FORBIDDEN` for an endpoint registered to another
user. `@lunora/seed` generates `@example.com` addresses, changing every seeded email value.
`handleSeedRequest` returns 409 instead of 200 for a table whose foreign-key parents were not
supplied in `existingIds`.

Test doubles were the reason two of these went unnoticed and are tightened here: the notify mock
engine now wires the real resilience middleware through the same `attachResilience` production
uses (a bare `createNotification` exercised none of it), the mock push provider answers each
provider's real gone phrasing per kind, and `fakeD1` models the `ON CONFLICT … DO UPDATE … WHERE`
refusal and each of the three `DELETE` owner predicates instead of overwriting and deleting
unconditionally.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(workflow): spawn compensations under an id the engine accepts

The Workflows engine validates an instance id on `create` before it does anything
else: at most 100 characters matching `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. `:` is not in
that class, so `ctx.parallel`'s group-saga rollback — spawned as
`<childId>:compensate` — was rejected on every attempt, in every deployment. The
rejection is not a duplicate-instance error, so the durable step burned its whole
retry budget, the catch in `compensateCompleted` logged it and moved on, and the
group failed with the completed branches never rolled back. A `chargeCard` branch
with `compensateWith: "refundCard"` took the money and refunded nothing.

The five unit tests hard-coded the `:compensate` id against a `create` double that
accepted any string, and the workerd smoke never spawns, so nothing caught it. The
double now applies the engine's own id check, and a new test asserts that every id
the package mints from a Cloudflare-shaped parent — children and compensations
alike — satisfies that grammar, so a future suffix carrying a `:` fails there.

Only the suffix is ours to constrain. The parent id it is appended to belongs to
the host, and `@lunora/platform-node` runs this same orchestrator on
`@visulima/workflow`, whose `generateRunId` mints `<definitionId>:<uuid>` and
accepts no override. A test pins that a host-issued parent id the Cloudflare engine
would refuse still fans out and compensates, so the Cloudflare grammar stays in the
assertion that belongs to Cloudflare rather than leaking into the portable path.

Also in this change:

- `ctx.parallel` reads an attached child's terminal `status()` instead of waiting
  for an event that has already been consumed. `instance.restart()` on a parent
  that had fanned out wipes the parent's step cache AND its event map, so the
  re-run spawn steps re-attach to children that already signalled; the joins then
  hibernated for the branch timeout (24 hours by default) and failed the group with
  the finished children's results sitting unread on their handles. The status read
  costs nothing on a first spawn — only the attach path performs it — and also
  recovers a join whose signal was lost for any other reason.

- `isDuplicateInstanceError` no longer misses an `already_exists` spelling. The
  predicate cannot be pinned against a live engine (miniflare never rejects a
  duplicate create at all, so the attach branch is unreachable under workerd), and
  the test now records why along with the separator variants it does defend.
* a group-saga compensation instance is now created as
`<childId>-compensate`, not `<childId>:compensate`. Nothing could observe the old
id — the engine rejected it — but an app that derived the name itself must update.
The `lunora:spawn:*` durable step now memoizes a branch outcome rather than the
child id; a parent already in flight replays the old string and joins as before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(container): key the readiness gate on the run, not on onStop

`lunoraReadiness` was cleared only in `onStop`, but the base reaches that hook
solely through `syncPendingStoppedEvents` — which `start()` never calls (only
`startAndWaitForPorts`, `stop()` and the alarm loop do), while the monitor callback
that observes a container exit merely records the state. So an explicit `start()`
inside the up-to-three-minute window before the next alarm found the finished run's
settled gate and returned early, skipping BOTH `armHardTimeout` and the `readyOn`
probes: run 2 had no hard timeout at all and was proxied to before it reported
ready. The hard timeout's own SIGTERM lands squarely in that window, so the
runaway-cost backstop disarmed itself on the way out.

The mirror case is why "always re-arm" is not the answer: a no-op `start()` on an
already-running container — an isolate recycled under a live run, or a periodic
"ensure started" call — begins no new run, and re-arming stamped a fresh generation
that orphaned the live schedule row and pushed the total-lifetime cap out
indefinitely.

Both now hang off one synchronous observation taken before anything is started:
the container was not running (a new run — drop the old gate, arm, probe) or it was
(no new run — probe for this isolate, leave the armed schedule alone). Read before
any await, so two concurrent starts of a stopped container still share one gate.
The two sites that drop a failed gate are identity-checked, so a gate failing late
for a run that has since ended cannot discard the current run's.

The existing test called `onStop` by hand between the two starts, encoding exactly
the assumption that does not hold; it now lets the run end the way the base does.
The start double stubs both entry points and flips the container's `running` flag
the way `doStartContainer` does, so a no-op start is distinguishable from a first
start.

Also in this change:

- `startAndWaitForPorts()` resolves the Secrets Store env. It was the only start
  entry that did not, despite being the path `containerFetch` routes through and the
  one an app can call itself; `doStartContainer` reads `this.envVars`, so a container
  started that way booted without its `secretsStore` values. Resolution moves out of
  `containerFetch`, which now performs it only when a start is actually needed.

- `hardTimeout` is documented as what it is. `stop()` sends SIGTERM and does not
  escalate to `destroy()`, so a container that traps or ignores the signal outlives
  its cap; the docs promised it would "never run longer than an hour, busy or not".
  The hook docblock names the escalation an app can add.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* build: regenerate the lockfile against the released manifest versions

`alpha`'s release commits bumped `@lunora/observability` to alpha.56 and
`@lunora/platform-cloudflare` to alpha.32 without updating `pnpm-lock.yaml`, so
every CI job fails in its setup step: the workflows install with
`--frozen-lockfile`, which refuses a lockfile whose specifiers disagree with the
manifests. That turns roughly a dozen checks red at once, including both
required ones, for reasons that look unrelated to the change under review.

Regenerated rather than hand-edited — a text-merged lockfile passes locally and
fails on the merge ref CI actually builds.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(flags): reword a comment that tripped the secret-entropy rule

The literal env-var reference in the new test's comment reads as a high-entropy
string to `no-secrets`, which fails `lint:eslint` at --max-warnings=0. The
comment says the same thing without spelling the identifier.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix: close the id, run-identity and provisioning gaps left open

`ctx.parallel`'s group-saga rollback was still unreachable, gated on length instead of the colon.
The engine's create-time id check tests `id.length > 100` BEFORE the character class, and a branch
id is caller-controlled right up to that ceiling — an explicit `branch(…, { id })`, or a derived
`<parentId>-c<n>` under a long host-issued parent. Adding `-compensate` puts the rollback over it,
`create` rejects, `compensateCompleted` logs and continues, and a completed branch that took payment
is never refunded. An over-long compensation id now folds back under the ceiling, keeping a digest
of the whole child id and the readable suffix. The regression test's short synthetic parent only
ever exercised the character class; it says so now, and a 90-character branch id covers the rest.

`codeTool` and `agent.asTool()` could never be used together. `codeTool` gives each script step a
tool-call id of `${toolCallId}:${step.id}` and takes any tool in its map, so `agentAsTool`'s
`sub-<name>-<toolCallId>` carried a colon into `create`, which rejects it — not as a duplicate, so
it rethrows and the per-step `step.do` burns its retries. The call id is hashed into the instance id
now (the thread key still carries it raw), and the docblock that called this "a note for whoever
changes the shape, not a live hazard" is gone. The agent binding double applies the engine's own id
check, which is what let this pass unnoticed.

The attach path returned a child's outcome straight into the durable step cache while only the event
path bounded it. Both channels cap at 1 MiB, and a step return the host cannot serialise aborts the
instance rather than failing one branch, so the attach path bounds it the same way.

Provisioning was reachable only through `validateWrangler`. `reconcileBindingsSafely` lived in the
wrangler validator's `config` hook, so turning the CHECKS off — an option whose name promises
nothing about writes — took the write back out of `config`, and the Cloudflare plugin parsed
`wrangler.jsonc`, and `remoteBindingsPlugin` copied it, before the binding existed: the exact
missing-`env.DB` boot that hook was moved to fix. It is its own unconditionally registered plugin
now, still `enforce: "pre"` and still ahead of the remote-bindings copy.

A re-entrant Vite `config` pass left `configPath` naming a deleted file: cleanup unlinked temp A, a
new plan wrote temp B, and `withRemoteBindings` read the A still on the options object as a
user-supplied path and returned unchanged. The plugin tracks what it injected, so only a path it did
not write counts as the user's.

The container's `beginStart()` snapshot was a TOCTOU across two awaits — a Secrets Store RPC, and
the base's own pre-start work. A container exiting in that window let a new run start with
`wasRunning === true`, so the hard timeout was never armed and (via `start()`) the readiness probes
were skipped too: run 2 ran uncapped and was proxied to before it reported ready. The snapshot moved
past the secrets resolution, and an `onStop` observed ACROSS the base call now demotes it. What
remains uncovered is an exit inside `start()`'s own base call, which never syncs pending stop
events — documented on `beginStart`, along with the hard timeout being a one-shot signal that
nothing re-sends to a container ignoring SIGTERM.

Docs and comments that overstated a guarantee: the mail queue recipe promised exactly-once for a
mark written after the send and read from an eventually-consistent store; `register()`'s owner guard
hard-fails browser account switching, because `subscribeToPush` reuses the browser's subscription
and every account derives the same id, so the README now makes the sign-out `unregister` part of the
recipe rather than an aside; the half-open breaker lets through every send already in flight, not
"exactly one"; `isPermanentFailure` is channel-less as well as kind-less and now governs retry for
chat/webhook/inApp; the duplicate-instance matcher is unreachable LOCALLY, not in production, which
is why `createOrAttach` exists at all.
* `flagshipProvider({ authToken: "" })` now throws at construction instead of
evaluating flags against their checked-in defaults — a deployment reading an unset secret straight
off `env` fails to boot rather than failing closed in silence. Omit `authToken` for an
unauthenticated endpoint, or pass a thunk. A sub-agent child run's instance id is now
`sub-<name>-<digest>` rather than `sub-<name>-<toolCallId>`, so a run in flight across the upgrade
starts a second child instead of re-attaching.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(deps): regenerate the lockfile after merging alpha

The merge took the branch's lockfile, which still carried the released-version
specifiers the new root overrides replace.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* make saga compensation, container restarts and push ownership actually work ([#592](https://github.com/anolilab/lunora/issues/592)) ([6fae07a](https://github.com/anolilab/lunora/commit/6fae07a056a6c93fea1fc11aa88c8d35ee031019))


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.63
* **@lunora/workflow:** upgraded to 1.0.0-alpha.45
* **@lunora/container:** upgraded to 1.0.0-alpha.44

## @lunora/agent [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.85...@lunora/agent@1.0.0-alpha.86) (2026-09-04)

### ⚠ BREAKING CHANGES

* **adapters:** `@lunora/angular`'s `VoiceAgentOptions.threadKey` is now `(() => string) | string`
and is resolved every time a call opens, matching the reactive-args form `liveQuery` and
`paginatedQuery` already take. A plain string keeps working; a `Signal<string>` is now honoured
instead of silently pinning every later call to the thread the component started on.

Tests: each harness now records the URL it was asked for, and the endpoint, the auto-teardown
wiring, the `error`/`interrupted` frames, `onclose`/`onerror`, teardown-while-mic-pending, duplicate
`startCall`, `sendText` on a closed socket and `toggleMute` before a call are asserted in all five
ports — 31 voice tests to 91.


Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

Co-authored-by: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Bug Fixes

* **adapters:** credential the voice socket and stop five copies drifting ([#597](https://github.com/anolilab/lunora/issues/597)) ([8bc777c](https://github.com/anolilab/lunora/commit/8bc777cfa5d7f2e8908a3a96f6463098283886ae))

## @lunora/agent [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.84...@lunora/agent@1.0.0-alpha.85) (2026-09-04)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.72
* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/mail:** upgraded to 1.0.0-alpha.62
* **@lunora/server:** upgraded to 1.0.0-alpha.102
* **@lunora/values:** upgraded to 1.0.0-alpha.39
* **@lunora/workflow:** upgraded to 1.0.0-alpha.44
* **@lunora/container:** upgraded to 1.0.0-alpha.43

## @lunora/agent [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.83...@lunora/agent@1.0.0-alpha.84) (2026-09-03)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.71
* **@lunora/server:** upgraded to 1.0.0-alpha.101

## @lunora/agent [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.82...@lunora/agent@1.0.0-alpha.83) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.70
* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/mail:** upgraded to 1.0.0-alpha.61
* **@lunora/server:** upgraded to 1.0.0-alpha.100
* **@lunora/values:** upgraded to 1.0.0-alpha.38
* **@lunora/workflow:** upgraded to 1.0.0-alpha.43
* **@lunora/container:** upgraded to 1.0.0-alpha.41

## @lunora/agent [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.81...@lunora/agent@1.0.0-alpha.82) (2026-09-02)

### Bug Fixes

* **mail:** align inbound auth verdicts with the From domain ([#546](https://github.com/anolilab/lunora/issues/546)) ([44be01f](https://github.com/anolilab/lunora/commit/44be01f4b69a8ac03aa65c1530a55302c341825f))


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.60

## @lunora/agent [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.80...@lunora/agent@1.0.0-alpha.81) (2026-09-02)

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

* **@lunora/ai:** upgraded to 1.0.0-alpha.69
* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/mail:** upgraded to 1.0.0-alpha.59
* **@lunora/server:** upgraded to 1.0.0-alpha.99
* **@lunora/values:** upgraded to 1.0.0-alpha.37
* **@lunora/workflow:** upgraded to 1.0.0-alpha.42
* **@lunora/container:** upgraded to 1.0.0-alpha.40

## @lunora/agent [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.79...@lunora/agent@1.0.0-alpha.80) (2026-09-01)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.68
* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/mail:** upgraded to 1.0.0-alpha.58
* **@lunora/server:** upgraded to 1.0.0-alpha.98
* **@lunora/values:** upgraded to 1.0.0-alpha.36
* **@lunora/workflow:** upgraded to 1.0.0-alpha.41
* **@lunora/container:** upgraded to 1.0.0-alpha.39

## @lunora/agent [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.78...@lunora/agent@1.0.0-alpha.79) (2026-09-01)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.97
* **@lunora/workflow:** upgraded to 1.0.0-alpha.40

## @lunora/agent [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.77...@lunora/agent@1.0.0-alpha.78) (2026-09-01)

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

* **@lunora/ai:** upgraded to 1.0.0-alpha.67
* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/mail:** upgraded to 1.0.0-alpha.57
* **@lunora/server:** upgraded to 1.0.0-alpha.96
* **@lunora/values:** upgraded to 1.0.0-alpha.35
* **@lunora/workflow:** upgraded to 1.0.0-alpha.39
* **@lunora/container:** upgraded to 1.0.0-alpha.38

## @lunora/agent [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.76...@lunora/agent@1.0.0-alpha.77) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.66
* **@lunora/mail:** upgraded to 1.0.0-alpha.56
* **@lunora/server:** upgraded to 1.0.0-alpha.95

## @lunora/agent [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.75...@lunora/agent@1.0.0-alpha.76) (2026-08-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.94
* **@lunora/values:** upgraded to 1.0.0-alpha.34
* **@lunora/workflow:** upgraded to 1.0.0-alpha.38

## @lunora/agent [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.74...@lunora/agent@1.0.0-alpha.75) (2026-08-30)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.65

## @lunora/agent [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.73...@lunora/agent@1.0.0-alpha.74) (2026-08-29)

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

* **@lunora/ai:** upgraded to 1.0.0-alpha.64
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/mail:** upgraded to 1.0.0-alpha.55
* **@lunora/server:** upgraded to 1.0.0-alpha.93
* **@lunora/values:** upgraded to 1.0.0-alpha.33
* **@lunora/workflow:** upgraded to 1.0.0-alpha.37
* **@lunora/container:** upgraded to 1.0.0-alpha.37

## @lunora/agent [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.72...@lunora/agent@1.0.0-alpha.73) (2026-08-28)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.63
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/mail:** upgraded to 1.0.0-alpha.54
* **@lunora/server:** upgraded to 1.0.0-alpha.92
* **@lunora/values:** upgraded to 1.0.0-alpha.32
* **@lunora/workflow:** upgraded to 1.0.0-alpha.36
* **@lunora/container:** upgraded to 1.0.0-alpha.36

## @lunora/agent [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.71...@lunora/agent@1.0.0-alpha.72) (2026-08-28)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.91

## @lunora/agent [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.70...@lunora/agent@1.0.0-alpha.71) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.90

## @lunora/agent [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.69...@lunora/agent@1.0.0-alpha.70) (2026-08-27)

### Bug Fixes

* **agent,server:** bound two regex scans that go quadratic on hostile input ([#502](https://github.com/anolilab/lunora/issues/502)) ([02ecb37](https://github.com/anolilab/lunora/commit/02ecb371dfd89dea930f6825990a38e267d7a5bb))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.89

## @lunora/agent [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.68...@lunora/agent@1.0.0-alpha.69) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.88

## @lunora/agent [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.67...@lunora/agent@1.0.0-alpha.68) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.87
* **@lunora/values:** upgraded to 1.0.0-alpha.31
* **@lunora/workflow:** upgraded to 1.0.0-alpha.35

## @lunora/agent [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.66...@lunora/agent@1.0.0-alpha.67) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.86
* **@lunora/values:** upgraded to 1.0.0-alpha.30
* **@lunora/workflow:** upgraded to 1.0.0-alpha.34

## @lunora/agent [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.65...@lunora/agent@1.0.0-alpha.66) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.85

## @lunora/agent [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.64...@lunora/agent@1.0.0-alpha.65) (2026-08-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.62
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/mail:** upgraded to 1.0.0-alpha.53
* **@lunora/server:** upgraded to 1.0.0-alpha.84
* **@lunora/values:** upgraded to 1.0.0-alpha.29
* **@lunora/workflow:** upgraded to 1.0.0-alpha.33
* **@lunora/container:** upgraded to 1.0.0-alpha.35

## @lunora/agent [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.63...@lunora/agent@1.0.0-alpha.64) (2026-08-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.61
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/mail:** upgraded to 1.0.0-alpha.52
* **@lunora/server:** upgraded to 1.0.0-alpha.83
* **@lunora/values:** upgraded to 1.0.0-alpha.28
* **@lunora/workflow:** upgraded to 1.0.0-alpha.32
* **@lunora/container:** upgraded to 1.0.0-alpha.34

## @lunora/agent [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.62...@lunora/agent@1.0.0-alpha.63) (2026-08-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.82

## @lunora/agent [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.61...@lunora/agent@1.0.0-alpha.62) (2026-08-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.81

## @lunora/agent [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.60...@lunora/agent@1.0.0-alpha.61) (2026-08-24)

### Bug Fixes

* **agent:** unstrand HITL approvals ([#438](https://github.com/anolilab/lunora/issues/438)) ([45c3b42](https://github.com/anolilab/lunora/commit/45c3b42297a1564a62a86ba8563d4e6c2d439106))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.80
* **@lunora/workflow:** upgraded to 1.0.0-alpha.31

## @lunora/agent [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/@lunora/agent@1.0.0-alpha.59...@lunora/agent@1.0.0-alpha.60) (2026-08-23)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.79

## @lunora/agent [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.58...%40lunora%2Fagent%401.0.0-alpha.59) (2026-08-18)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.51
* **@lunora/server:** upgraded to 1.0.0-alpha.78

## @lunora/agent [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.57...%40lunora%2Fagent%401.0.0-alpha.58) (2026-08-18)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.60
* **@lunora/server:** upgraded to 1.0.0-alpha.77
* **@lunora/container:** upgraded to 1.0.0-alpha.32

## @lunora/agent [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.56...%40lunora%2Fagent%401.0.0-alpha.57) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.76
* **@lunora/workflow:** upgraded to 1.0.0-alpha.30

## @lunora/agent [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.55...%40lunora%2Fagent%401.0.0-alpha.56) (2026-08-15)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.75

## @lunora/agent [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.54...%40lunora%2Fagent%401.0.0-alpha.55) (2026-08-14)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.59
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/mail:** upgraded to 1.0.0-alpha.50
* **@lunora/server:** upgraded to 1.0.0-alpha.74
* **@lunora/values:** upgraded to 1.0.0-alpha.27
* **@lunora/workflow:** upgraded to 1.0.0-alpha.29

## @lunora/agent [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.53...%40lunora%2Fagent%401.0.0-alpha.54) (2026-08-12)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.58
* **@lunora/mail:** upgraded to 1.0.0-alpha.49
* **@lunora/server:** upgraded to 1.0.0-alpha.73

## @lunora/agent [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.52...%40lunora%2Fagent%401.0.0-alpha.53) (2026-08-11)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.72
* **@lunora/workflow:** upgraded to 1.0.0-alpha.28

## @lunora/agent [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.51...%40lunora%2Fagent%401.0.0-alpha.52) (2026-08-11)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.57
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/mail:** upgraded to 1.0.0-alpha.48
* **@lunora/server:** upgraded to 1.0.0-alpha.71
* **@lunora/values:** upgraded to 1.0.0-alpha.26
* **@lunora/workflow:** upgraded to 1.0.0-alpha.27

## @lunora/agent [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.50...%40lunora%2Fagent%401.0.0-alpha.51) (2026-08-10)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.56

## @lunora/agent [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.49...%40lunora%2Fagent%401.0.0-alpha.50) (2026-08-10)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.70

## @lunora/agent [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.48...%40lunora%2Fagent%401.0.0-alpha.49) (2026-08-09)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.53
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/mail:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.68
* **@lunora/values:** upgraded to 1.0.0-alpha.23
* **@lunora/workflow:** upgraded to 1.0.0-alpha.25

## @lunora/agent [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.47...%40lunora%2Fagent%401.0.0-alpha.48) (2026-08-09)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.52
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/mail:** upgraded to 1.0.0-alpha.44
* **@lunora/server:** upgraded to 1.0.0-alpha.67
* **@lunora/values:** upgraded to 1.0.0-alpha.22
* **@lunora/workflow:** upgraded to 1.0.0-alpha.24

## @lunora/agent [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.46...%40lunora%2Fagent%401.0.0-alpha.47) (2026-08-08)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.51

## @lunora/agent [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.45...%40lunora%2Fagent%401.0.0-alpha.46) (2026-08-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.66

## @lunora/agent [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.44...%40lunora%2Fagent%401.0.0-alpha.45) (2026-08-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.65

## @lunora/agent [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.43...%40lunora%2Fagent%401.0.0-alpha.44) (2026-08-07)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.50
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/mail:** upgraded to 1.0.0-alpha.43
* **@lunora/server:** upgraded to 1.0.0-alpha.64
* **@lunora/values:** upgraded to 1.0.0-alpha.21
* **@lunora/workflow:** upgraded to 1.0.0-alpha.23

## @lunora/agent [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.42...%40lunora%2Fagent%401.0.0-alpha.43) (2026-08-07)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.49
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/mail:** upgraded to 1.0.0-alpha.42
* **@lunora/server:** upgraded to 1.0.0-alpha.63
* **@lunora/values:** upgraded to 1.0.0-alpha.20
* **@lunora/workflow:** upgraded to 1.0.0-alpha.22

## @lunora/agent [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.41...%40lunora%2Fagent%401.0.0-alpha.42) (2026-08-04)

## @lunora/agent [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.40...%40lunora%2Fagent%401.0.0-alpha.41) (2026-08-04)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.48
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/mail:** upgraded to 1.0.0-alpha.41
* **@lunora/server:** upgraded to 1.0.0-alpha.62
* **@lunora/values:** upgraded to 1.0.0-alpha.19
* **@lunora/workflow:** upgraded to 1.0.0-alpha.21

## @lunora/agent [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.39...%40lunora%2Fagent%401.0.0-alpha.40) (2026-08-04)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.61
* **@lunora/values:** upgraded to 1.0.0-alpha.18
* **@lunora/workflow:** upgraded to 1.0.0-alpha.20

## @lunora/agent [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.38...%40lunora%2Fagent%401.0.0-alpha.39) (2026-08-04)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.47
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/mail:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.60
* **@lunora/values:** upgraded to 1.0.0-alpha.17
* **@lunora/workflow:** upgraded to 1.0.0-alpha.19

## @lunora/agent [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.37...%40lunora%2Fagent%401.0.0-alpha.38) (2026-08-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.59
* **@lunora/values:** upgraded to 1.0.0-alpha.16
* **@lunora/workflow:** upgraded to 1.0.0-alpha.18

## @lunora/agent [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.36...%40lunora%2Fagent%401.0.0-alpha.37) (2026-08-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.58

## @lunora/agent [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.35...%40lunora%2Fagent%401.0.0-alpha.36) (2026-08-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.57

## @lunora/agent [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.34...%40lunora%2Fagent%401.0.0-alpha.35) (2026-07-31)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.56

## @lunora/agent [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.33...%40lunora%2Fagent%401.0.0-alpha.34) (2026-07-31)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/mail:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.55
* **@lunora/values:** upgraded to 1.0.0-alpha.13
* **@lunora/workflow:** upgraded to 1.0.0-alpha.15

## @lunora/agent [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.32...%40lunora%2Fagent%401.0.0-alpha.33) (2026-07-31)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.54

## @lunora/agent [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.31...%40lunora%2Fagent%401.0.0-alpha.32) (2026-07-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.53

## @lunora/agent [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.30...%40lunora%2Fagent%401.0.0-alpha.31) (2026-07-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.52

## @lunora/agent [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.29...%40lunora%2Fagent%401.0.0-alpha.30) (2026-07-28)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.43
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/mail:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.51
* **@lunora/values:** upgraded to 1.0.0-alpha.12
* **@lunora/workflow:** upgraded to 1.0.0-alpha.14

## @lunora/agent [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.28...%40lunora%2Fagent%401.0.0-alpha.29) (2026-07-28)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.42
* **@lunora/mail:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.50

## @lunora/agent [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.27...%40lunora%2Fagent%401.0.0-alpha.28) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.41
* **@lunora/mail:** upgraded to 1.0.0-alpha.34
* **@lunora/server:** upgraded to 1.0.0-alpha.49

## @lunora/agent [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.26...%40lunora%2Fagent%401.0.0-alpha.27) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.40
* **@lunora/mail:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.48

## @lunora/agent [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.25...%40lunora%2Fagent%401.0.0-alpha.26) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.39
* **@lunora/mail:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.47

## @lunora/agent [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.24...%40lunora%2Fagent%401.0.0-alpha.25) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.38
* **@lunora/mail:** upgraded to 1.0.0-alpha.31
* **@lunora/server:** upgraded to 1.0.0-alpha.46

## @lunora/agent [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.23...%40lunora%2Fagent%401.0.0-alpha.24) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.37
* **@lunora/mail:** upgraded to 1.0.0-alpha.30
* **@lunora/server:** upgraded to 1.0.0-alpha.45

## @lunora/agent [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.22...%40lunora%2Fagent%401.0.0-alpha.23) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.36
* **@lunora/mail:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.44

## @lunora/agent [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.21...%40lunora%2Fagent%401.0.0-alpha.22) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.35
* **@lunora/mail:** upgraded to 1.0.0-alpha.28
* **@lunora/server:** upgraded to 1.0.0-alpha.43

## @lunora/agent [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.20...%40lunora%2Fagent%401.0.0-alpha.21) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.34
* **@lunora/mail:** upgraded to 1.0.0-alpha.27
* **@lunora/server:** upgraded to 1.0.0-alpha.42

## @lunora/agent [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.19...%40lunora%2Fagent%401.0.0-alpha.20) (2026-07-27)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.33
* **@lunora/mail:** upgraded to 1.0.0-alpha.26
* **@lunora/server:** upgraded to 1.0.0-alpha.41

## @lunora/agent [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.18...%40lunora%2Fagent%401.0.0-alpha.19) (2026-07-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.32
* **@lunora/mail:** upgraded to 1.0.0-alpha.25
* **@lunora/server:** upgraded to 1.0.0-alpha.40

## @lunora/agent [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.17...%40lunora%2Fagent%401.0.0-alpha.18) (2026-07-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.31
* **@lunora/mail:** upgraded to 1.0.0-alpha.24
* **@lunora/server:** upgraded to 1.0.0-alpha.39

## @lunora/agent [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.16...%40lunora%2Fagent%401.0.0-alpha.17) (2026-07-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.30
* **@lunora/mail:** upgraded to 1.0.0-alpha.23
* **@lunora/server:** upgraded to 1.0.0-alpha.38

## @lunora/agent [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.15...%40lunora%2Fagent%401.0.0-alpha.16) (2026-07-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.29
* **@lunora/mail:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.37

## @lunora/agent [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.14...%40lunora%2Fagent%401.0.0-alpha.15) (2026-07-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.28
* **@lunora/mail:** upgraded to 1.0.0-alpha.21
* **@lunora/server:** upgraded to 1.0.0-alpha.36

## @lunora/agent [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.13...%40lunora%2Fagent%401.0.0-alpha.14) (2026-07-26)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.27
* **@lunora/mail:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.35

## @lunora/agent [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.12...%40lunora%2Fagent%401.0.0-alpha.13) (2026-07-25)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.26
* **@lunora/mail:** upgraded to 1.0.0-alpha.19
* **@lunora/server:** upgraded to 1.0.0-alpha.34

## @lunora/agent [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.11...%40lunora%2Fagent%401.0.0-alpha.12) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.33

## @lunora/agent [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.10...%40lunora%2Fagent%401.0.0-alpha.11) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.32

## @lunora/agent [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.9...%40lunora%2Fagent%401.0.0-alpha.10) (2026-07-25)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.25
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/mail:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.31
* **@lunora/values:** upgraded to 1.0.0-alpha.11
* **@lunora/workflow:** upgraded to 1.0.0-alpha.13

## @lunora/agent [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.8...%40lunora%2Fagent%401.0.0-alpha.9) (2026-07-23)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.30
* **@lunora/values:** upgraded to 1.0.0-alpha.10
* **@lunora/workflow:** upgraded to 1.0.0-alpha.12

## @lunora/agent [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.7...%40lunora%2Fagent%401.0.0-alpha.8) (2026-07-22)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.19

## @lunora/agent [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.6...%40lunora%2Fagent%401.0.0-alpha.7) (2026-07-22)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.18

## @lunora/agent [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.5...%40lunora%2Fagent%401.0.0-alpha.6) (2026-07-21)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.29

## @lunora/agent [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.4...%40lunora%2Fagent%401.0.0-alpha.5) (2026-07-20)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.17
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/mail:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.28
* **@lunora/values:** upgraded to 1.0.0-alpha.9
* **@lunora/workflow:** upgraded to 1.0.0-alpha.11

## @lunora/agent [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.3...%40lunora%2Fagent%401.0.0-alpha.4) (2026-07-19)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.27

## @lunora/agent [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.2...%40lunora%2Fagent%401.0.0-alpha.3) (2026-07-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.26

## @lunora/agent [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fagent%401.0.0-alpha.1...%40lunora%2Fagent%401.0.0-alpha.2) (2026-07-17)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.15
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/mail:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.25
* **@lunora/values:** upgraded to 1.0.0-alpha.8
* **@lunora/workflow:** upgraded to 1.0.0-alpha.10

## @lunora/agent 1.0.0-alpha.1 (2026-07-13)


### Dependencies

* **@lunora/ai:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.24
