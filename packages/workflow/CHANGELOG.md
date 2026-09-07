## @lunora/workflow [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.47...@lunora/workflow@1.0.0-alpha.48) (2026-09-06)

### Bug Fixes

* **client,workflow,testing:** stop losing wire-decode failures ([#644](https://github.com/anolilab/lunora/issues/644)) ([9be24dd](https://github.com/anolilab/lunora/commit/9be24dd665af62e524375eda6ecdcb9d6f1a3572))

### Tests

* **dispatch,queue,workflow,agent,do:** pin both halves of the ctx.run wire bracket ([#645](https://github.com/anolilab/lunora/issues/645)) ([9fd8827](https://github.com/anolilab/lunora/commit/9fd882739609734a3db51b45b27c380062e4b9ff))

## @lunora/workflow [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.46...@lunora/workflow@1.0.0-alpha.47) (2026-09-06)

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

### Bug Fixes

* **dispatch,scheduler:** wire-bracket ctx.run so it returns the value, not the envelope ([#615](https://github.com/anolilab/lunora/issues/615)) ([404264a](https://github.com/anolilab/lunora/commit/404264a805812b080a8298ff33e10c70e224ca2f))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33
* **@lunora/values:** upgraded to 1.0.0-alpha.41
* **@lunora/server:** upgraded to 1.0.0-alpha.105

## @lunora/workflow [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.45...@lunora/workflow@1.0.0-alpha.46) (2026-09-05)

### Bug Fixes

* **scheduler,workflow:** give a scheduled workflow an idempotency key ([#605](https://github.com/anolilab/lunora/issues/605)) ([0f3afb4](https://github.com/anolilab/lunora/commit/0f3afb44a005861c5b06b4be0cca4576ec0ce7e8))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/values:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.103

## @lunora/workflow [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.44...@lunora/workflow@1.0.0-alpha.45) (2026-09-04)

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

## @lunora/workflow [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.43...@lunora/workflow@1.0.0-alpha.44) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/values:** upgraded to 1.0.0-alpha.39
* **@lunora/server:** upgraded to 1.0.0-alpha.102

## @lunora/workflow [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.42...@lunora/workflow@1.0.0-alpha.43) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/values:** upgraded to 1.0.0-alpha.38
* **@lunora/server:** upgraded to 1.0.0-alpha.100

## @lunora/workflow [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.41...@lunora/workflow@1.0.0-alpha.42) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/values:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.99

## @lunora/workflow [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.40...@lunora/workflow@1.0.0-alpha.41) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/values:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.98

## @lunora/workflow [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.39...@lunora/workflow@1.0.0-alpha.40) (2026-09-01)

### ⚠ BREAKING CHANGES

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests (#541)

### Bug Fixes

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests ([#541](https://github.com/anolilab/lunora/issues/541)) ([dfc2d4d](https://github.com/anolilab/lunora/commit/dfc2d4d07bf8f67214122dc7f14d83a9b1533d07))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.97

## @lunora/workflow [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.38...@lunora/workflow@1.0.0-alpha.39) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/values:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.96

## @lunora/workflow [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.37...@lunora/workflow@1.0.0-alpha.38) (2026-08-30)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.34
* **@lunora/server:** upgraded to 1.0.0-alpha.94

## @lunora/workflow [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.36...@lunora/workflow@1.0.0-alpha.37) (2026-08-29)

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
* **@lunora/values:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.93

## @lunora/workflow [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.35...@lunora/workflow@1.0.0-alpha.36) (2026-08-28)

### Documentation

* repair 404 package links, and document .source() in the hyperdrive readme ([#501](https://github.com/anolilab/lunora/issues/501)) ([d519ac2](https://github.com/anolilab/lunora/commit/d519ac23f2bd8ddf5a10af5db11f141e8728babf))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/values:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.92

## @lunora/workflow [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.34...@lunora/workflow@1.0.0-alpha.35) (2026-08-26)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.31
* **@lunora/server:** upgraded to 1.0.0-alpha.87

## @lunora/workflow [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.33...@lunora/workflow@1.0.0-alpha.34) (2026-08-26)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.30
* **@lunora/server:** upgraded to 1.0.0-alpha.86

## @lunora/workflow [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.32...@lunora/workflow@1.0.0-alpha.33) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/values:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.84

## @lunora/workflow [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.31...@lunora/workflow@1.0.0-alpha.32) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/values:** upgraded to 1.0.0-alpha.28
* **@lunora/server:** upgraded to 1.0.0-alpha.83

## @lunora/workflow [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.30...@lunora/workflow@1.0.0-alpha.31) (2026-08-24)

### Bug Fixes

* **workflow:** reject reserved names on step.name ([#447](https://github.com/anolilab/lunora/issues/447)) ([f51690d](https://github.com/anolilab/lunora/commit/f51690da43c76e134de1b9dc68468da03c4e6834))

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.80

## @lunora/workflow [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.29...%40lunora%2Fworkflow%401.0.0-alpha.30) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.76

## @lunora/workflow [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.28...%40lunora%2Fworkflow%401.0.0-alpha.29) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/values:** upgraded to 1.0.0-alpha.27

## @lunora/workflow [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.27...%40lunora%2Fworkflow%401.0.0-alpha.28) (2026-08-11)

## @lunora/workflow [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.26...%40lunora%2Fworkflow%401.0.0-alpha.27) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/values:** upgraded to 1.0.0-alpha.26

## @lunora/workflow [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.25...%40lunora%2Fworkflow%401.0.0-alpha.26) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20
* **@lunora/values:** upgraded to 1.0.0-alpha.25

## @lunora/workflow [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.24...%40lunora%2Fworkflow%401.0.0-alpha.25) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/values:** upgraded to 1.0.0-alpha.23

## @lunora/workflow [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.23...%40lunora%2Fworkflow%401.0.0-alpha.24) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/values:** upgraded to 1.0.0-alpha.22

## @lunora/workflow [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.22...%40lunora%2Fworkflow%401.0.0-alpha.23) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/values:** upgraded to 1.0.0-alpha.21

## @lunora/workflow [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.21...%40lunora%2Fworkflow%401.0.0-alpha.22) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/values:** upgraded to 1.0.0-alpha.20

## @lunora/workflow [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.20...%40lunora%2Fworkflow%401.0.0-alpha.21) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/values:** upgraded to 1.0.0-alpha.19

## @lunora/workflow [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.19...%40lunora%2Fworkflow%401.0.0-alpha.20) (2026-08-04)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.18

## @lunora/workflow [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.18...%40lunora%2Fworkflow%401.0.0-alpha.19) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/values:** upgraded to 1.0.0-alpha.17

## @lunora/workflow [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.17...%40lunora%2Fworkflow%401.0.0-alpha.18) (2026-08-03)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.16

## @lunora/workflow [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.16...%40lunora%2Fworkflow%401.0.0-alpha.17) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/values:** upgraded to 1.0.0-alpha.15

## @lunora/workflow [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.15...%40lunora%2Fworkflow%401.0.0-alpha.16) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11
* **@lunora/values:** upgraded to 1.0.0-alpha.14

## @lunora/workflow [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.14...%40lunora%2Fworkflow%401.0.0-alpha.15) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/values:** upgraded to 1.0.0-alpha.13

## @lunora/workflow [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.13...%40lunora%2Fworkflow%401.0.0-alpha.14) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/values:** upgraded to 1.0.0-alpha.12

## @lunora/workflow [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.12...%40lunora%2Fworkflow%401.0.0-alpha.13) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/values:** upgraded to 1.0.0-alpha.11

## @lunora/workflow [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.11...%40lunora%2Fworkflow%401.0.0-alpha.12) (2026-07-23)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.10

## @lunora/workflow [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.10...%40lunora%2Fworkflow%401.0.0-alpha.11) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/values:** upgraded to 1.0.0-alpha.9

## @lunora/workflow [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.9...%40lunora%2Fworkflow%401.0.0-alpha.10) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/values:** upgraded to 1.0.0-alpha.8

## @lunora/workflow [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.8...%40lunora%2Fworkflow%401.0.0-alpha.9) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/values:** upgraded to 1.0.0-alpha.7

## @lunora/workflow [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.7...%40lunora%2Fworkflow%401.0.0-alpha.8) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/values:** upgraded to 1.0.0-alpha.6

## @lunora/workflow [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.6...%40lunora%2Fworkflow%401.0.0-alpha.7) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/values:** upgraded to 1.0.0-alpha.5

## @lunora/workflow [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.5...%40lunora%2Fworkflow%401.0.0-alpha.6) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/values:** upgraded to 1.0.0-alpha.4

## @lunora/workflow [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.4...%40lunora%2Fworkflow%401.0.0-alpha.5) (2026-07-02)

## @lunora/workflow [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fworkflow%401.0.0-alpha.3...%40lunora%2Fworkflow%401.0.0-alpha.4) (2026-06-30)

## @lunora/workflow [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.2...@lunora/workflow@1.0.0-alpha.3) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.3

## @lunora/workflow [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/workflow@1.0.0-alpha.1...@lunora/workflow@1.0.0-alpha.2) (2026-06-27)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))
* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.2

## @lunora/workflow 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/values:** upgraded to 1.0.0-alpha.1
