## @lunora/seed [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.109...@lunora/seed@1.0.0-alpha.110) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.105
* **@lunora/testing:** upgraded to 1.0.0-alpha.149
* **@lunora/values:** upgraded to 1.0.0-alpha.41

## @lunora/seed [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.108...@lunora/seed@1.0.0-alpha.109) (2026-09-05)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.104
* **@lunora/testing:** upgraded to 1.0.0-alpha.148

## @lunora/seed [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.107...@lunora/seed@1.0.0-alpha.108) (2026-09-05)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.103
* **@lunora/testing:** upgraded to 1.0.0-alpha.147
* **@lunora/values:** upgraded to 1.0.0-alpha.40

## @lunora/seed [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.106...@lunora/seed@1.0.0-alpha.107) (2026-09-04)

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

* **@lunora/testing:** upgraded to 1.0.0-alpha.146

## @lunora/seed [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.105...@lunora/seed@1.0.0-alpha.106) (2026-09-04)


### Dependencies

* **@lunora/testing:** upgraded to 1.0.0-alpha.145

## @lunora/seed [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.104...@lunora/seed@1.0.0-alpha.105) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/server:** upgraded to 1.0.0-alpha.102
* **@lunora/testing:** upgraded to 1.0.0-alpha.144
* **@lunora/values:** upgraded to 1.0.0-alpha.39

## @lunora/seed [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.103...@lunora/seed@1.0.0-alpha.104) (2026-09-03)

### ⚠ BREAKING CHANGES

* `SubscriptionStore` requires `deleteOwned(id, userId)`. Both
shipped stores implement it; an external store must make the predicate and the
removal atomic rather than reintroduce the read-then-write race. Seeding a
`.unique()` self-referencing column into a non-empty table is now refused.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* close twelve review findings, three fail-open ([#587](https://github.com/anolilab/lunora/issues/587)) ([74c2ac0](https://github.com/anolilab/lunora/commit/74c2ac0028a77c357870ca120e0b76d65627581e))

## @lunora/seed [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.102...@lunora/seed@1.0.0-alpha.103) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.101
* **@lunora/testing:** upgraded to 1.0.0-alpha.143

## @lunora/seed [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.101...@lunora/seed@1.0.0-alpha.102) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/server:** upgraded to 1.0.0-alpha.100
* **@lunora/testing:** upgraded to 1.0.0-alpha.142
* **@lunora/values:** upgraded to 1.0.0-alpha.38

## @lunora/seed [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.100...@lunora/seed@1.0.0-alpha.101) (2026-09-02)


### Dependencies

* **@lunora/testing:** upgraded to 1.0.0-alpha.141

## @lunora/seed [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.99...@lunora/seed@1.0.0-alpha.100) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.99
* **@lunora/testing:** upgraded to 1.0.0-alpha.140
* **@lunora/values:** upgraded to 1.0.0-alpha.37

## @lunora/seed [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.98...@lunora/seed@1.0.0-alpha.99) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/server:** upgraded to 1.0.0-alpha.98
* **@lunora/testing:** upgraded to 1.0.0-alpha.139
* **@lunora/values:** upgraded to 1.0.0-alpha.36

## @lunora/seed [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.97...@lunora/seed@1.0.0-alpha.98) (2026-09-01)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.97
* **@lunora/testing:** upgraded to 1.0.0-alpha.138

## @lunora/seed [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.96...@lunora/seed@1.0.0-alpha.97) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/server:** upgraded to 1.0.0-alpha.96
* **@lunora/testing:** upgraded to 1.0.0-alpha.137
* **@lunora/values:** upgraded to 1.0.0-alpha.35

## @lunora/seed [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.95...@lunora/seed@1.0.0-alpha.96) (2026-08-31)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.95
* **@lunora/testing:** upgraded to 1.0.0-alpha.136

## @lunora/seed [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.94...@lunora/seed@1.0.0-alpha.95) (2026-08-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.94
* **@lunora/testing:** upgraded to 1.0.0-alpha.135
* **@lunora/values:** upgraded to 1.0.0-alpha.34

## @lunora/seed [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.93...@lunora/seed@1.0.0-alpha.94) (2026-08-30)


### Dependencies

* **@lunora/testing:** upgraded to 1.0.0-alpha.134

## @lunora/seed [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.92...@lunora/seed@1.0.0-alpha.93) (2026-08-29)

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
* **@lunora/server:** upgraded to 1.0.0-alpha.93
* **@lunora/testing:** upgraded to 1.0.0-alpha.133
* **@lunora/values:** upgraded to 1.0.0-alpha.33

## @lunora/seed [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.91...@lunora/seed@1.0.0-alpha.92) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/server:** upgraded to 1.0.0-alpha.92
* **@lunora/testing:** upgraded to 1.0.0-alpha.132
* **@lunora/values:** upgraded to 1.0.0-alpha.32

## @lunora/seed [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.90...@lunora/seed@1.0.0-alpha.91) (2026-08-28)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.91
* **@lunora/testing:** upgraded to 1.0.0-alpha.131

## @lunora/seed [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.89...@lunora/seed@1.0.0-alpha.90) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.90
* **@lunora/testing:** upgraded to 1.0.0-alpha.130

## @lunora/seed [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.88...@lunora/seed@1.0.0-alpha.89) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.89
* **@lunora/testing:** upgraded to 1.0.0-alpha.129

## @lunora/seed [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.87...@lunora/seed@1.0.0-alpha.88) (2026-08-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.88
* **@lunora/testing:** upgraded to 1.0.0-alpha.128

## @lunora/seed [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.86...@lunora/seed@1.0.0-alpha.87) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.87
* **@lunora/testing:** upgraded to 1.0.0-alpha.125
* **@lunora/values:** upgraded to 1.0.0-alpha.31

## @lunora/seed [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.85...@lunora/seed@1.0.0-alpha.86) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.86
* **@lunora/testing:** upgraded to 1.0.0-alpha.124
* **@lunora/values:** upgraded to 1.0.0-alpha.30

## @lunora/seed [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.84...@lunora/seed@1.0.0-alpha.85) (2026-08-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.85
* **@lunora/testing:** upgraded to 1.0.0-alpha.123

## @lunora/seed [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.83...@lunora/seed@1.0.0-alpha.84) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/server:** upgraded to 1.0.0-alpha.84
* **@lunora/testing:** upgraded to 1.0.0-alpha.122
* **@lunora/values:** upgraded to 1.0.0-alpha.29

## @lunora/seed [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.82...@lunora/seed@1.0.0-alpha.83) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/server:** upgraded to 1.0.0-alpha.83
* **@lunora/testing:** upgraded to 1.0.0-alpha.121
* **@lunora/values:** upgraded to 1.0.0-alpha.28

## @lunora/seed [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.81...@lunora/seed@1.0.0-alpha.82) (2026-08-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.82
* **@lunora/testing:** upgraded to 1.0.0-alpha.120

## @lunora/seed [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.80...@lunora/seed@1.0.0-alpha.81) (2026-08-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.81
* **@lunora/testing:** upgraded to 1.0.0-alpha.119

## @lunora/seed [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.79...@lunora/seed@1.0.0-alpha.80) (2026-08-24)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.80
* **@lunora/testing:** upgraded to 1.0.0-alpha.117

## @lunora/seed [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.78...@lunora/seed@1.0.0-alpha.79) (2026-08-24)

### Bug Fixes

* **seed:** respect unique columns when seeding ([#457](https://github.com/anolilab/lunora/issues/457)) ([37f5157](https://github.com/anolilab/lunora/commit/37f515701408b456a68cfa6f1e3a1c0231691b64))

## @lunora/seed [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.77...@lunora/seed@1.0.0-alpha.78) (2026-08-23)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.79
* **@lunora/testing:** upgraded to 1.0.0-alpha.116

## @lunora/seed [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.76...%40lunora%2Fseed%401.0.0-alpha.77) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.78
* **@lunora/testing:** upgraded to 1.0.0-alpha.113

## @lunora/seed [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.75...%40lunora%2Fseed%401.0.0-alpha.76) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.77
* **@lunora/testing:** upgraded to 1.0.0-alpha.112

## @lunora/seed [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.74...%40lunora%2Fseed%401.0.0-alpha.75) (2026-08-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.76
* **@lunora/testing:** upgraded to 1.0.0-alpha.111

## @lunora/seed [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.73...%40lunora%2Fseed%401.0.0-alpha.74) (2026-08-15)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.75
* **@lunora/testing:** upgraded to 1.0.0-alpha.110

## @lunora/seed [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.72...%40lunora%2Fseed%401.0.0-alpha.73) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.74
* **@lunora/testing:** upgraded to 1.0.0-alpha.109
* **@lunora/values:** upgraded to 1.0.0-alpha.27

## @lunora/seed [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.71...%40lunora%2Fseed%401.0.0-alpha.72) (2026-08-12)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.73
* **@lunora/testing:** upgraded to 1.0.0-alpha.108

## @lunora/seed [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.70...%40lunora%2Fseed%401.0.0-alpha.71) (2026-08-11)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.72
* **@lunora/testing:** upgraded to 1.0.0-alpha.107

## @lunora/seed [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.69...%40lunora%2Fseed%401.0.0-alpha.70) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/server:** upgraded to 1.0.0-alpha.71
* **@lunora/testing:** upgraded to 1.0.0-alpha.105
* **@lunora/values:** upgraded to 1.0.0-alpha.26

## @lunora/seed [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.68...%40lunora%2Fseed%401.0.0-alpha.69) (2026-08-10)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.70
* **@lunora/testing:** upgraded to 1.0.0-alpha.103

## @lunora/seed [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.67...%40lunora%2Fseed%401.0.0-alpha.68) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.68
* **@lunora/testing:** upgraded to 1.0.0-alpha.102
* **@lunora/values:** upgraded to 1.0.0-alpha.23

## @lunora/seed [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.66...%40lunora%2Fseed%401.0.0-alpha.67) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/server:** upgraded to 1.0.0-alpha.67
* **@lunora/testing:** upgraded to 1.0.0-alpha.100
* **@lunora/values:** upgraded to 1.0.0-alpha.22

## @lunora/seed [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.65...%40lunora%2Fseed%401.0.0-alpha.66) (2026-08-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.66
* **@lunora/testing:** upgraded to 1.0.0-alpha.97

## @lunora/seed [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.64...%40lunora%2Fseed%401.0.0-alpha.65) (2026-08-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.65
* **@lunora/testing:** upgraded to 1.0.0-alpha.96

## @lunora/seed [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.63...%40lunora%2Fseed%401.0.0-alpha.64) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.64
* **@lunora/testing:** upgraded to 1.0.0-alpha.95
* **@lunora/values:** upgraded to 1.0.0-alpha.21

## @lunora/seed [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.62...%40lunora%2Fseed%401.0.0-alpha.63) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.63
* **@lunora/testing:** upgraded to 1.0.0-alpha.94
* **@lunora/values:** upgraded to 1.0.0-alpha.20

## @lunora/seed [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.61...%40lunora%2Fseed%401.0.0-alpha.62) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.62
* **@lunora/testing:** upgraded to 1.0.0-alpha.91
* **@lunora/values:** upgraded to 1.0.0-alpha.19

## @lunora/seed [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.60...%40lunora%2Fseed%401.0.0-alpha.61) (2026-08-04)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.61
* **@lunora/testing:** upgraded to 1.0.0-alpha.90
* **@lunora/values:** upgraded to 1.0.0-alpha.18

## @lunora/seed [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.59...%40lunora%2Fseed%401.0.0-alpha.60) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/server:** upgraded to 1.0.0-alpha.60
* **@lunora/testing:** upgraded to 1.0.0-alpha.89
* **@lunora/values:** upgraded to 1.0.0-alpha.17

## @lunora/seed [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.58...%40lunora%2Fseed%401.0.0-alpha.59) (2026-08-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.59
* **@lunora/testing:** upgraded to 1.0.0-alpha.86
* **@lunora/values:** upgraded to 1.0.0-alpha.16

## @lunora/seed [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.57...%40lunora%2Fseed%401.0.0-alpha.58) (2026-08-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.58
* **@lunora/testing:** upgraded to 1.0.0-alpha.85

## @lunora/seed [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.56...%40lunora%2Fseed%401.0.0-alpha.57) (2026-08-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.57
* **@lunora/testing:** upgraded to 1.0.0-alpha.84

## @lunora/seed [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.55...%40lunora%2Fseed%401.0.0-alpha.56) (2026-07-31)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.56
* **@lunora/testing:** upgraded to 1.0.0-alpha.83

## @lunora/seed [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.54...%40lunora%2Fseed%401.0.0-alpha.55) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/server:** upgraded to 1.0.0-alpha.55
* **@lunora/testing:** upgraded to 1.0.0-alpha.82
* **@lunora/values:** upgraded to 1.0.0-alpha.13

## @lunora/seed [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.53...%40lunora%2Fseed%401.0.0-alpha.54) (2026-07-31)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.54
* **@lunora/testing:** upgraded to 1.0.0-alpha.81

## @lunora/seed [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.52...%40lunora%2Fseed%401.0.0-alpha.53) (2026-07-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.53
* **@lunora/testing:** upgraded to 1.0.0-alpha.80

## @lunora/seed [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.51...%40lunora%2Fseed%401.0.0-alpha.52) (2026-07-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.52
* **@lunora/testing:** upgraded to 1.0.0-alpha.79

## @lunora/seed [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.50...%40lunora%2Fseed%401.0.0-alpha.51) (2026-07-29)


### Dependencies

* **@lunora/testing:** upgraded to 1.0.0-alpha.78

## @lunora/seed [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.49...%40lunora%2Fseed%401.0.0-alpha.50) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/server:** upgraded to 1.0.0-alpha.51
* **@lunora/testing:** upgraded to 1.0.0-alpha.76
* **@lunora/values:** upgraded to 1.0.0-alpha.12

## @lunora/seed [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.48...%40lunora%2Fseed%401.0.0-alpha.49) (2026-07-28)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.50
* **@lunora/testing:** upgraded to 1.0.0-alpha.75

## @lunora/seed [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.47...%40lunora%2Fseed%401.0.0-alpha.48) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.49
* **@lunora/testing:** upgraded to 1.0.0-alpha.74

## @lunora/seed [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.46...%40lunora%2Fseed%401.0.0-alpha.47) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.48
* **@lunora/testing:** upgraded to 1.0.0-alpha.73

## @lunora/seed [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.45...%40lunora%2Fseed%401.0.0-alpha.46) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.47
* **@lunora/testing:** upgraded to 1.0.0-alpha.72

## @lunora/seed [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.44...%40lunora%2Fseed%401.0.0-alpha.45) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.46
* **@lunora/testing:** upgraded to 1.0.0-alpha.71

## @lunora/seed [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.43...%40lunora%2Fseed%401.0.0-alpha.44) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.45
* **@lunora/testing:** upgraded to 1.0.0-alpha.70

## @lunora/seed [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.42...%40lunora%2Fseed%401.0.0-alpha.43) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.44
* **@lunora/testing:** upgraded to 1.0.0-alpha.69

## @lunora/seed [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.41...%40lunora%2Fseed%401.0.0-alpha.42) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.43
* **@lunora/testing:** upgraded to 1.0.0-alpha.68

## @lunora/seed [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.40...%40lunora%2Fseed%401.0.0-alpha.41) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.42
* **@lunora/testing:** upgraded to 1.0.0-alpha.67

## @lunora/seed [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.39...%40lunora%2Fseed%401.0.0-alpha.40) (2026-07-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.41
* **@lunora/testing:** upgraded to 1.0.0-alpha.66

## @lunora/seed [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.38...%40lunora%2Fseed%401.0.0-alpha.39) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.40
* **@lunora/testing:** upgraded to 1.0.0-alpha.65

## @lunora/seed [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.37...%40lunora%2Fseed%401.0.0-alpha.38) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.39
* **@lunora/testing:** upgraded to 1.0.0-alpha.64

## @lunora/seed [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.36...%40lunora%2Fseed%401.0.0-alpha.37) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.38
* **@lunora/testing:** upgraded to 1.0.0-alpha.63

## @lunora/seed [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.35...%40lunora%2Fseed%401.0.0-alpha.36) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.37
* **@lunora/testing:** upgraded to 1.0.0-alpha.62

## @lunora/seed [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.34...%40lunora%2Fseed%401.0.0-alpha.35) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.36
* **@lunora/testing:** upgraded to 1.0.0-alpha.61

## @lunora/seed [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.33...%40lunora%2Fseed%401.0.0-alpha.34) (2026-07-26)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.35
* **@lunora/testing:** upgraded to 1.0.0-alpha.60

## @lunora/seed [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.32...%40lunora%2Fseed%401.0.0-alpha.33) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.34
* **@lunora/testing:** upgraded to 1.0.0-alpha.59

## @lunora/seed [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.31...%40lunora%2Fseed%401.0.0-alpha.32) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.33
* **@lunora/testing:** upgraded to 1.0.0-alpha.57

## @lunora/seed [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.30...%40lunora%2Fseed%401.0.0-alpha.31) (2026-07-25)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.32
* **@lunora/testing:** upgraded to 1.0.0-alpha.56

## @lunora/seed [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.29...%40lunora%2Fseed%401.0.0-alpha.30) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/server:** upgraded to 1.0.0-alpha.31
* **@lunora/testing:** upgraded to 1.0.0-alpha.55
* **@lunora/values:** upgraded to 1.0.0-alpha.11

## @lunora/seed [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.28...%40lunora%2Fseed%401.0.0-alpha.29) (2026-07-23)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.30
* **@lunora/testing:** upgraded to 1.0.0-alpha.52
* **@lunora/values:** upgraded to 1.0.0-alpha.10

## @lunora/seed [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.27...%40lunora%2Fseed%401.0.0-alpha.28) (2026-07-21)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.29
* **@lunora/testing:** upgraded to 1.0.0-alpha.47

## @lunora/seed [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.26...%40lunora%2Fseed%401.0.0-alpha.27) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/server:** upgraded to 1.0.0-alpha.28
* **@lunora/testing:** upgraded to 1.0.0-alpha.46
* **@lunora/values:** upgraded to 1.0.0-alpha.9

## @lunora/seed [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.25...%40lunora%2Fseed%401.0.0-alpha.26) (2026-07-19)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.27
* **@lunora/testing:** upgraded to 1.0.0-alpha.45

## @lunora/seed [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.24...%40lunora%2Fseed%401.0.0-alpha.25) (2026-07-18)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.26
* **@lunora/testing:** upgraded to 1.0.0-alpha.44

## @lunora/seed [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.23...%40lunora%2Fseed%401.0.0-alpha.24) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/server:** upgraded to 1.0.0-alpha.25
* **@lunora/testing:** upgraded to 1.0.0-alpha.43
* **@lunora/values:** upgraded to 1.0.0-alpha.8

## @lunora/seed [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.22...%40lunora%2Fseed%401.0.0-alpha.23) (2026-07-13)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.24
* **@lunora/testing:** upgraded to 1.0.0-alpha.41

## @lunora/seed [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.21...%40lunora%2Fseed%401.0.0-alpha.22) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/server:** upgraded to 1.0.0-alpha.23
* **@lunora/testing:** upgraded to 1.0.0-alpha.39
* **@lunora/values:** upgraded to 1.0.0-alpha.7

## @lunora/seed [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.20...%40lunora%2Fseed%401.0.0-alpha.21) (2026-07-10)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.22
* **@lunora/testing:** upgraded to 1.0.0-alpha.38

## @lunora/seed [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.19...%40lunora%2Fseed%401.0.0-alpha.20) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/server:** upgraded to 1.0.0-alpha.21
* **@lunora/testing:** upgraded to 1.0.0-alpha.37
* **@lunora/values:** upgraded to 1.0.0-alpha.6

## @lunora/seed [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.18...%40lunora%2Fseed%401.0.0-alpha.19) (2026-07-08)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.20
* **@lunora/testing:** upgraded to 1.0.0-alpha.36

## @lunora/seed [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.17...%40lunora%2Fseed%401.0.0-alpha.18) (2026-07-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.18
* **@lunora/testing:** upgraded to 1.0.0-alpha.35

## @lunora/seed [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.16...%40lunora%2Fseed%401.0.0-alpha.17) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/server:** upgraded to 1.0.0-alpha.17
* **@lunora/testing:** upgraded to 1.0.0-alpha.34
* **@lunora/values:** upgraded to 1.0.0-alpha.5

## @lunora/seed [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.15...%40lunora%2Fseed%401.0.0-alpha.16) (2026-07-04)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.16
* **@lunora/testing:** upgraded to 1.0.0-alpha.28

## @lunora/seed [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.14...%40lunora%2Fseed%401.0.0-alpha.15) (2026-07-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.15
* **@lunora/testing:** upgraded to 1.0.0-alpha.27

## @lunora/seed [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.13...%40lunora%2Fseed%401.0.0-alpha.14) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.14
* **@lunora/testing:** upgraded to 1.0.0-alpha.26
* **@lunora/values:** upgraded to 1.0.0-alpha.4

## @lunora/seed [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.12...%40lunora%2Fseed%401.0.0-alpha.13) (2026-07-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.13
* **@lunora/testing:** upgraded to 1.0.0-alpha.24

## @lunora/seed [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.11...%40lunora%2Fseed%401.0.0-alpha.12) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.12
* **@lunora/testing:** upgraded to 1.0.0-alpha.22

## @lunora/seed [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.10...%40lunora%2Fseed%401.0.0-alpha.11) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.11
* **@lunora/testing:** upgraded to 1.0.0-alpha.20

## @lunora/seed [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.9...%40lunora%2Fseed%401.0.0-alpha.10) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.10
* **@lunora/testing:** upgraded to 1.0.0-alpha.19

## @lunora/seed [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.8...%40lunora%2Fseed%401.0.0-alpha.9) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.9
* **@lunora/testing:** upgraded to 1.0.0-alpha.18

## @lunora/seed [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.7...%40lunora%2Fseed%401.0.0-alpha.8) (2026-07-01)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.8
* **@lunora/testing:** upgraded to 1.0.0-alpha.17

## @lunora/seed [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.6...%40lunora%2Fseed%401.0.0-alpha.7) (2026-06-30)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.7
* **@lunora/testing:** upgraded to 1.0.0-alpha.12

## @lunora/seed [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fseed%401.0.0-alpha.5...%40lunora%2Fseed%401.0.0-alpha.6) (2026-06-29)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.6
* **@lunora/testing:** upgraded to 1.0.0-alpha.10

## @lunora/seed [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.4...@lunora/seed@1.0.0-alpha.5) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.5
* **@lunora/testing:** upgraded to 1.0.0-alpha.8
* **@lunora/values:** upgraded to 1.0.0-alpha.3

## @lunora/seed [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.3...@lunora/seed@1.0.0-alpha.4) (2026-06-27)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.4
* **@lunora/testing:** upgraded to 1.0.0-alpha.7

## @lunora/seed [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.2...@lunora/seed@1.0.0-alpha.3) (2026-06-27)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.3
* **@lunora/testing:** upgraded to 1.0.0-alpha.6
* **@lunora/values:** upgraded to 1.0.0-alpha.2

## @lunora/seed [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/seed@1.0.0-alpha.1...@lunora/seed@1.0.0-alpha.2) (2026-06-25)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))

### Code Refactoring

* remove dead code flagged by fallow ([be57eca](https://github.com/anolilab/lunora/commit/be57ecaf4d6f3bc95d7b1a5876305dfb2af80e45))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.2
* **@lunora/testing:** upgraded to 1.0.0-alpha.5

## @lunora/seed 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.1
* **@lunora/testing:** upgraded to 1.0.0-alpha.1
* **@lunora/values:** upgraded to 1.0.0-alpha.1
