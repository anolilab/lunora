## @lunora/container [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.44...@lunora/container@1.0.0-alpha.45) (2026-09-05)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32

## @lunora/container [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.43...@lunora/container@1.0.0-alpha.44) (2026-09-04)

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

## @lunora/container [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.42...@lunora/container@1.0.0-alpha.43) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31

## @lunora/container [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.41...@lunora/container@1.0.0-alpha.42) (2026-09-03)

### ⚠ BREAKING CHANGES

* writes already sitting in a durable outbox carry no identity stamp and are
dropped on the next drain instead of replayed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(db): report the reserved outbox handler's drop instead of swallowing it

The per-collection replay handler wraps its NonRetriableError and reports it on
`onWriteRejected`; the reserved `__lunora_outbox__` handler threw bare. A write
dropped there rolled the optimistic row back with no UI signal — the exact
failure that option was added to prevent, on the one path that already had the
identity guard. Reports the identity drop and a server-coded replay rejection
alike, because reporting only the first would leave the handler with the same
half-guarded shape it is being fixed for.

Also validates `rollout.gracePeriodSeconds` in `defineContainer`, which reached
wrangler's `rollout_active_grace_period` unchecked while its sibling
`stepPercentage` was validated; a fractional or negative value became a
deploy-time failure far from the line that caused it. Only the shape is
asserted — 0 is meaningful and no upper bound is sourced.

And corrects a `collection-options.ts` docblock that stated the inverse of the
code: it justified lazy resolution by an identity switch "retiring" the derived
registry, but a switch rewinds each registry in place precisely so captures stay
valid. The real replacement case is a client teardown.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* docs(container): cite the platform ceiling the readiness budget sits on

`READINESS_TIMEOUT_MS` is 30s, which is exactly Cloudflare's documented timeout
for a `blockConcurrencyWhile` callback — "if this timeout is exceeded, the
Durable Object will be reset" — and `armHardTimeout`'s three storage round-trips
run ahead of it. While that wait sat inside the gate the reset won the race, so
the `LunoraError` naming the failing check, port and budget was unreachable on
the one path it exists for. The same page calls blocking that gate on I/O an
anti-pattern, which a `readyOn` probe is.

Records the source at the constant so the number is not re-derived by assumption
and the wait is not moved back inside the gate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(db): hold a replayed write when no identity is established yet

The identity gate compared the stamped identity against `currentIdentity()` with
a bare `!==`. That destroys the queuing user's own offline writes on every
reload: `startOfflineExecutor` replays from its own constructor, before the app
has resolved its session and called `setAuthToken`, so `currentIdentity()` is
still null while the replay runs. A `NonRetriableError` there is terminal — the
executor removes the entry from durable storage — so an offline write made
before a reload was deleted rather than sent.

The property being protected is "never replay as a DIFFERENT user". A null
current identity is no user at all, so there is nobody to impersonate and the
write must be held. The verdict now belongs to the client
(`replayIdentityVerdict`): a mismatch is terminal, an unknown identity throws a
retriable error and the write waits. It also routes through the existing
token-hash check, so a subject that resolves after the token no longer looks
like a different user. Both replay handlers share it, which closes the same bare
comparison in the reserved `__lunora_outbox__` handler.

Also gates request proxying on the `readyOn` probes. The base commits the
healthy state inside its start gate, before the probes run, so `containerFetch`
skipped startup entirely and proxied to a container that never reported ready;
`afterContainerStart` is now single-flight and `containerFetch` awaits it.

Reads the last-login cookie after mount in all six auth-ui ports, so the first
client render matches the server instead of producing markup the server could
not have produced, and gates the email and magic-link badges on
`plugins.lastLoginMethod` the way the social buttons already were. Hardens the
cookie read against a malformed percent-escape, which threw `URIError` during
render.
* `db.actions.*` transactions persist `{ identity, shardKey }`
metadata. A write queued by an older build carries no stamp and is held rather
than replayed under an unverified identity.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(container): clear the readiness gate when a run stops

The single-flight gate added for concurrent starts outlived the run it belonged
to. After `onStop` — including the `onActivityExpired` path, which stops the
container — a restart found the settled promise and returned early, so the new
run skipped both `armHardTimeout` and the `readyOn` probes: the restarted app
was proxied to before it reported ready, and its hard timeout was never re-armed.

Cleared when the run ends rather than at the top of a start, so single-flight
still holds within a run. Resetting per start would let two concurrent starters
each build a gate and each arm a schedule stamped with the same generation,
which is the race the single-flight was added to close.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* close 15 audit findings across the db outbox, container DO and adapters ([#589](https://github.com/anolilab/lunora/issues/589)) ([57080c6](https://github.com/anolilab/lunora/commit/57080c65698170d60403f1ca7731a9009661f1fc))

## @lunora/container [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.40...@lunora/container@1.0.0-alpha.41) (2026-09-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30

## @lunora/container [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.39...@lunora/container@1.0.0-alpha.40) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29

## @lunora/container [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.38...@lunora/container@1.0.0-alpha.39) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/container [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.37...@lunora/container@1.0.0-alpha.38) (2026-09-01)

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

## @lunora/container [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.36...@lunora/container@1.0.0-alpha.37) (2026-08-29)

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

## @lunora/container [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.35...@lunora/container@1.0.0-alpha.36) (2026-08-28)

### Documentation

* repair 404 package links, and document .source() in the hyperdrive readme ([#501](https://github.com/anolilab/lunora/issues/501)) ([d519ac2](https://github.com/anolilab/lunora/commit/d519ac23f2bd8ddf5a10af5db11f141e8728babf))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25

## @lunora/container [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.34...@lunora/container@1.0.0-alpha.35) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24

## @lunora/container [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.33...@lunora/container@1.0.0-alpha.34) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/container [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.32...@lunora/container@1.0.0-alpha.33) (2026-08-24)

### Bug Fixes

* **dispatch:** idempotent retries, real deadlines ([#455](https://github.com/anolilab/lunora/issues/455)) ([c92909a](https://github.com/anolilab/lunora/commit/c92909af851553f9b63cf5d1ad0844550fbc3cc0))

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))

## @lunora/container [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.31...%40lunora%2Fcontainer%401.0.0-alpha.32) (2026-08-18)

## @lunora/container [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.30...%40lunora%2Fcontainer%401.0.0-alpha.31) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/container [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.29...%40lunora%2Fcontainer%401.0.0-alpha.30) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21

## @lunora/container [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.28...%40lunora%2Fcontainer%401.0.0-alpha.29) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/container [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.27...%40lunora%2Fcontainer%401.0.0-alpha.28) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19

## @lunora/container [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.26...%40lunora%2Fcontainer%401.0.0-alpha.27) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/container [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.25...%40lunora%2Fcontainer%401.0.0-alpha.26) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17

## @lunora/container [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.24...%40lunora%2Fcontainer%401.0.0-alpha.25) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/container [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.23...%40lunora%2Fcontainer%401.0.0-alpha.24) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/container [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.22...%40lunora%2Fcontainer%401.0.0-alpha.23) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14

## @lunora/container [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.21...%40lunora%2Fcontainer%401.0.0-alpha.22) (2026-08-04)

## @lunora/container [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.20...%40lunora%2Fcontainer%401.0.0-alpha.21) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13

## @lunora/container [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.19...%40lunora%2Fcontainer%401.0.0-alpha.20) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12

## @lunora/container [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.18...%40lunora%2Fcontainer%401.0.0-alpha.19) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11

## @lunora/container [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.17...%40lunora%2Fcontainer%401.0.0-alpha.18) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/container [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.16...%40lunora%2Fcontainer%401.0.0-alpha.17) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/container [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.15...%40lunora%2Fcontainer%401.0.0-alpha.16) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/container [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.14...%40lunora%2Fcontainer%401.0.0-alpha.15) (2026-07-24)

## @lunora/container [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.13...%40lunora%2Fcontainer%401.0.0-alpha.14) (2026-07-22)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.7

## @lunora/container [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.12...%40lunora%2Fcontainer%401.0.0-alpha.13) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/container [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.11...%40lunora%2Fcontainer%401.0.0-alpha.12) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/container [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.10...%40lunora%2Fcontainer%401.0.0-alpha.11) (2026-07-12)

## @lunora/container [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.9...%40lunora%2Fcontainer%401.0.0-alpha.10) (2026-07-11)

## @lunora/container [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.8...%40lunora%2Fcontainer%401.0.0-alpha.9) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/container [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.7...%40lunora%2Fcontainer%401.0.0-alpha.8) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/container [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.6...%40lunora%2Fcontainer%401.0.0-alpha.7) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/container [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.5...%40lunora%2Fcontainer%401.0.0-alpha.6) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/container [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fcontainer%401.0.0-alpha.4...%40lunora%2Fcontainer%401.0.0-alpha.5) (2026-06-29)

## @lunora/container [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.3...@lunora/container@1.0.0-alpha.4) (2026-06-28)

### Features

* **container:** close Cloudflare Container feature gaps ([#36](https://github.com/anolilab/lunora/issues/36)) ([0246176](https://github.com/anolilab/lunora/commit/02461764873b47d51fb55dbd12bc784bcf9dad42)), closes [28/#178](https://github.com/28/lunora/issues/178) [cloudflare/containers#30](https://github.com/cloudflare/containers/issues/30) [cloudflare/containers#147](https://github.com/cloudflare/containers/issues/147) [cloudflare/containers#147](https://github.com/cloudflare/containers/issues/147) [cloudflare/containers#135](https://github.com/cloudflare/containers/issues/135)

### Documentation

* fix package doc bugs and dead cross-links ([205d74c](https://github.com/anolilab/lunora/commit/205d74c3b730e201e822141191b45015f303336b))

## @lunora/container [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.2...@lunora/container@1.0.0-alpha.3) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)

## @lunora/container [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/container@1.0.0-alpha.1...@lunora/container@1.0.0-alpha.2) (2026-06-27)

### Features

* **server:** pin durable objects to a data-residency jurisdiction ([#29](https://github.com/anolilab/lunora/issues/29)) ([0fcdc94](https://github.com/anolilab/lunora/commit/0fcdc94a836ea1b54a0eba78b6926de52aa3a767))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))
* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))

## @lunora/container 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))
