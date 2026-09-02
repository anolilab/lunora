## @lunora/notify [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.32...@lunora/notify@1.0.0-alpha.33) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29

## @lunora/notify [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.31...@lunora/notify@1.0.0-alpha.32) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/notify [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.30...@lunora/notify@1.0.0-alpha.31) (2026-09-01)

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

## @lunora/notify [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.29...@lunora/notify@1.0.0-alpha.30) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))

## @lunora/notify [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.28...@lunora/notify@1.0.0-alpha.29) (2026-08-30)

### Features

* **hyperdrive:** pgvector-backed ctx.vectors, plus a design plan for the embedded runtime ([#530](https://github.com/anolilab/lunora/issues/530)) ([58e0c0c](https://github.com/anolilab/lunora/commit/58e0c0cf154293ef0be8c48683d471b5533559f6))

## @lunora/notify [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.27...@lunora/notify@1.0.0-alpha.28) (2026-08-29)

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

## @lunora/notify [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.26...@lunora/notify@1.0.0-alpha.27) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25

## @lunora/notify [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.25...@lunora/notify@1.0.0-alpha.26) (2026-08-27)

### Bug Fixes

* **shard-engine:** reject cursors minted before the tiebreak changed direction ([#503](https://github.com/anolilab/lunora/issues/503)) ([fdc58bc](https://github.com/anolilab/lunora/commit/fdc58bc6acc6c4f794da42e038c6953d2554c0fe))

## @lunora/notify [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.24...@lunora/notify@1.0.0-alpha.25) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24

## @lunora/notify [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.23...@lunora/notify@1.0.0-alpha.24) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/notify [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.22...@lunora/notify@1.0.0-alpha.23) (2026-08-25)

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

## @lunora/notify [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/@lunora/notify@1.0.0-alpha.21...@lunora/notify@1.0.0-alpha.22) (2026-08-23)

### Bug Fixes

* **notify:** route push targets by their kind ([#450](https://github.com/anolilab/lunora/issues/450)) ([2b0e29b](https://github.com/anolilab/lunora/commit/2b0e29b43abbac315218fe9bbe657cb79d6779a0))

## @lunora/notify [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.20...%40lunora%2Fnotify%401.0.0-alpha.21) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/notify [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.19...%40lunora%2Fnotify%401.0.0-alpha.20) (2026-08-12)

## @lunora/notify [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.18...%40lunora%2Fnotify%401.0.0-alpha.19) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21

## @lunora/notify [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.17...%40lunora%2Fnotify%401.0.0-alpha.18) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/notify [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.16...%40lunora%2Fnotify%401.0.0-alpha.17) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19

## @lunora/notify [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.15...%40lunora%2Fnotify%401.0.0-alpha.16) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/notify [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.14...%40lunora%2Fnotify%401.0.0-alpha.15) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17

## @lunora/notify [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.13...%40lunora%2Fnotify%401.0.0-alpha.14) (2026-08-07)

## @lunora/notify [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.12...%40lunora%2Fnotify%401.0.0-alpha.13) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/notify [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.11...%40lunora%2Fnotify%401.0.0-alpha.12) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/notify [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.10...%40lunora%2Fnotify%401.0.0-alpha.11) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14

## @lunora/notify [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.9...%40lunora%2Fnotify%401.0.0-alpha.10) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13

## @lunora/notify [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.8...%40lunora%2Fnotify%401.0.0-alpha.9) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12

## @lunora/notify [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.7...%40lunora%2Fnotify%401.0.0-alpha.8) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11

## @lunora/notify [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.6...%40lunora%2Fnotify%401.0.0-alpha.7) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/notify [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.5...%40lunora%2Fnotify%401.0.0-alpha.6) (2026-07-30)

## @lunora/notify [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.4...%40lunora%2Fnotify%401.0.0-alpha.5) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/notify [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.3...%40lunora%2Fnotify%401.0.0-alpha.4) (2026-07-26)

## @lunora/notify [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.2...%40lunora%2Fnotify%401.0.0-alpha.3) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/notify [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fnotify%401.0.0-alpha.1...%40lunora%2Fnotify%401.0.0-alpha.2) (2026-07-24)

## @lunora/notify 1.0.0-alpha.1 (2026-07-23)
