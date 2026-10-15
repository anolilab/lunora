# Plan 476 — Serve last-verified tenant plans through a control-plane outage, from storage that outlives the isolate

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** PARTIAL. A, C and D are shipped and the §3 contract is unit-tested. B now has a writer and an hourly refresh, but no KV namespace is bound and nothing is written on the fact change itself (see "Not closed" below). E is not run. Staleness bound decided: 48 hours.

## 0. Headline finding

The dispatcher's "a control-plane blip keeps serving tenants" grace does not survive the thing that happens constantly
on Workers: isolate eviction. The last-known plan lives in a module-level `Map` inside one isolate. A fresh isolate that
starts during an outage has an empty map, so it refuses every non-suspended tenant immediately. The advertised five-minute
grace protects only the isolates that happened to be warm, so a control-plane outage degrades into a random, partial
data-plane outage.

Size: **H** (availability of every tenant). Medium effort.

## 1. Current state (audit)

- `apps/cloud/src/targets/cloudflare-wfp/route.ts:116` — `PLAN_STALE_GRACE_MS = 5 * 60_000`.
- `route.ts:215-218` — `createPlanResolver` creates a fresh `cache` Map each time it is called. The dispatcher calls it from
  `buildResolvers` (`apps/cloud/src/dispatcher/worker.ts:263-276`), so the map is per isolate.
- `route.ts:228-231` — `lastKnown()` reads only that per-isolate `cache`. With no entry it returns `{ plan: UNAVAILABLE_PLAN }`.
- `dispatcher/worker.ts` (`refusalFor`, `:399-413`) — `UNAVAILABLE_PLAN` is refused with 503.
- No KV, Durable Object, Cache API, R2 or D1 is used anywhere in `src/dispatcher` or `src/outbound` (checked 2026-10-11).

Net effect: warm isolates serve through an outage of up to about `TTL + 5 min`; a cold isolate serves nobody.

## 2. Existing seams (do not reinvent)

- `ScriptFacts` and `createPlanResolver` (`route.ts:24-28`, `:215`). The persisted record is exactly `ScriptFacts` plus a
  `verifiedAt` timestamp, so the resolver's output type does not change.
- `PLAN_STALE_GRACE_MS` and the `suspended`-stands-indefinitely rule (`route.ts:112-115`, `:229`). Keep the rule; change
  where the value is read from.
- `UNKNOWN_TTL_MS` (`route.ts:119`). `unknown` answers stay out of persistence, so a new deploy is served within seconds.
- `recordDispatch` / `PLATFORM_METRICS` for the counter that makes this observable.
- The control plane already runs an hourly tick (`apps/cloud/src/fanout/`, `src/sweeps/`). A refresh job fits there.

## 3. The behavioural contract to preserve

- A lookup that succeeds is authoritative for that request, exactly as today.
- `suspended` is never served as "servable" from persistence, and a suspension already recorded keeps refusing during an
  outage.
- `unknown` is never persisted and never served from persistence.
- A persisted non-suspended record older than the maximum staleness is refused.
- The control plane's responses and the `/v1/tenants/plan` contract do not change.

## 4. Design decisions

1. **The control plane is the only writer; the dispatcher only reads.** A KV namespace holds one record per script,
   `plan:<scriptName>` = `{ plan, protected, recursion, verifiedAt }`. The control plane writes it:
    - **on every change** of those facts (plan change, suspension, lift, protection or recursion change), and
    - **on a refresh sweep**: the hourly tick rewrites any record whose `verifiedAt` is older than 20 hours, so a steady
      tenant is written about once a day.

    The dispatcher never writes. Writing from every isolate in every colo is wrong: each isolate would have to read first to
    know whether anything changed, and the write rate would scale with isolates, not with tenants.
    _Rejected:_ a Durable Object per script (a hot-key and cost problem to protect against a rare outage); Cache API (per colo,
    evicts); a D1 read from the dispatcher (D1 fails in the same outage).

2. **Maximum staleness: 48 hours** for non-suspended records, a dispatcher var (`PLAN_MAX_STALE_HOURS`).
   _Decided._ Why 48 and not another number:
    - The refresh runs every 20 hours, so one missed sweep (the record reaches 40 hours) is still inside the bound. 36 hours
      would leave no margin for a missed sweep; 72 would tolerate two.
    - What the bound protects against is a _downgrade or cap change_ not taking effect during an outage. Suspensions are
      exempt: they are stored indefinitely, so the money case never depends on the bound. A lift cannot be written during an
      outage and keeps refusing, which is the fail-closed direction. So the bound only governs how long a downgrade can lag an
      outage, and two days is the longest lag we accept for that.
    - Changing it is a dispatcher var, not a deploy of code.
      _Rejected:_ unbounded staleness (a downgrade during a long outage never takes effect); 24 hours (one missed sweep would
      start refusing paying tenants).
3. **Lookup order:** isolate cache → control plane → KV record (if younger than 48 h, or any age if `suspended`) →
   `UNAVAILABLE_PLAN`.
4. **KV failure equals current behaviour.** If KV is unreachable, refuse as today.
5. **Propagation is eventually consistent, and that is stated, not hidden.** A new suspension reaches a dispatcher's KV read
   after KV's propagation delay (confirm the current figure in Phase 0). An isolate's own 60-second cache sits on top of that.
   A **lift** made during an outage cannot be written, so the record keeps refusing until the control plane recovers.

## 5. Workstreams

**A. Persistence port (S).** A `PlanReader` (`get`) for the dispatcher and a `PlanStore` (`get`, `put`, `delete`) for the control
plane, in `src/plans/`, with a KV implementation and an in-memory one for tests. Both backends read through the same parser
(`parsePlanRecord`), and one contract suite (`__tests__/plan-store-contract.test.ts`) runs against both. The dispatcher is handed
only the reader, so it cannot write even by accident. The resolver takes it as an option, so `route.ts` gains no Cloudflare types.

**B. Control-plane writer (M).** On each fact change, write the record after the D1 commit, and retry failed writes from the
hourly sweep. The refresh sweep rewrites records older than 20 hours. The control plane gets a KV write binding; the dispatcher
gets a read-only binding.

_As built:_ `src/plans/plan-writer.ts` (`refreshPlanRecords`) and `src/sweeps/plan-records.ts` (`sweepPlanRecords`, the hourly
entry). The writer does not consume a change log and keeps no dirty marker. On each pass it reads a script's current facts from the
control plane's own `/v1/tenants/plan` (in-process, as the build drain does) and compares them with the stored record:

- written when the record is missing, differs in plan, protection or recursion, or is older than 20 hours;
- deleted when the facts are `unknown` or absent;
- counted as failed, and left alone, when the facts cannot be read or the write throws. The next pass sees the disagreement
  and retries. A failed write therefore needs no marker, and the sweep never relies on record age alone.

The sweep runs in the hourly invocation after the control plane's code crons (`worker.scheduled`), so the suspension,
dunning and spend-cap changes those crons commit are picked up in the same invocation. It is inert, with no D1 or KV read,
unless `PLAN_KV` and the admin token are both present. `PLAN_KV` is typed in `ControlPlaneEnv` but not declared in any wrangler
config, because it needs a real namespace id.

**C. Resolver read path (M).** Extend `createPlanResolver` to consult the store after the isolate cache and before
`UNAVAILABLE_PLAN`. No write from the dispatcher.

**D. Configuration, counters and the operator view (S).** `PLAN_MAX_STALE_HOURS` (default 48). A counter for "answered from
persistence" by reason. In the studio, a tenant whose plan is being served from persistence shows "plan verified N hours ago —
control plane unreachable", so an operator sees the outage from the project page, not only from metrics.

**E. Drill (S, ops).** In staging: block the control plane, force a cold isolate (deploy a no-op version), and confirm a healthy
tenant is served from KV, a suspended tenant is refused, and a tenant absent from KV is refused. Then suspend a tenant with the
control plane up and time how long a dispatcher takes to refuse it.

## 6. Platform parity

Not applicable. Dispatcher-internal and Cloud-only; no `ctx.*` surface or framework binding.

## 7. Phasing & ordering

| Phase | Work                                                                                             | Gate                                                                                                      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Measure: count cold-isolate lookups during a staged outage; read KV's current propagation figure | Recorded numbers in this file                                                                             | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1     | A, C with unit tests for every row of the §3 contract                                            | `pnpm --filter @lunora/cloud run test` green; a test fails if the persisted-suspension refusal is removed | Shipped. `__tests__/plan-persistence.test.ts` covers §3 and the hung-lookup timeout; `__tests__/dispatcher-plan-persistence.test.ts` covers the `worker.ts` wiring; `__tests__/plan-store-contract.test.ts` runs one contract against the memory and KV stores. `decideFallback` (pure) is the one place the fallback is decided. The newer-verdict rule is tested both within and past the grace. Run per file, not the whole suite                                                                                                                                                                                                                                                                                                                                                           |
| 2     | B with the write-volume estimate recorded                                                        | Writes per day measured on staging against the tenant count; estimate and KV plan limit recorded          | Partial. `planRecordFor`, `needsRefresh` and `refreshPlanRecords` are tested in `__tests__/plan-store.test.ts` and `__tests__/plan-writer.test.ts`: changed-young, matching-old, unknown-delete, failed-write retry, and a failed facts read that keeps the record. `sweepPlanRecords` is inert without `PLAN_KV`. Not done: the KV namespace is not bound; no fact change is written at the mutation itself (the change is picked up by the hourly pass, at most about an hour late, and a dispatcher that refuses a lift before then is the fail-closed direction); records of scripts that stop being live are not enumerated and so are not deleted (a non-suspended one lapses at the 48 h bound; a suspended one for a dead script refuses a dead hostname); no write-volume measurement |
| 3     | D and E                                                                                          | Staging drill output recorded here                                                                        | D shipped: `PLAN_MAX_STALE_HOURS` (48) in `dispatcher.wrangler.jsonc`; `recordPlanStore` counter (`plan_store`, outcomes served/stale/suspended/unreadable). Not built: the studio notice. E not run. No KV namespace is bound, so the store is inert until one is provisioned and the id is supplied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 8. Risks & STOP conditions

- **STOP** if the staging drill serves a suspended tenant from KV. That is the money bypass again; fix it before anything else.
- **Risk:** write volume. Writes per day ≈ tenants (refresh) + fact changes. At 10,000 tenants that is about 10,000 writes a
  day; check against the KV plan and its current pricing before enabling. If too high, lengthen the refresh and the bound
  together (keeping the bound at least 2 × the refresh interval); do not drop the refresh.
- **Risk:** the refresh sweep fails for a day and the bound is close. _Mitigate:_ the counter in D fires before the bound, and
  the sweep retries.
- **Perf watch:** a warm isolate must not read KV at all. Confirm with a before/after count of KV reads per request on staging.

## 9. Open questions — decided

1. **Is 48 hours the right bound?** Decided: yes, with the reasoning in §4.2. It is a var, so it can move without a deploy.
2. **Should a persisted `protected` flag be honoured during an outage?** Decided: yes. Dropping protection is the failure we
   care about.
3. **Should the outage counter page someone?** Decided: it populates the dashboard and the project-page notice in D. Paging
   waits until a real outage shows whether the notice is enough.

## 9a. Decisions made while closing the review (2026-10-12)

- **Vocabulary.** "store" is the name for the persisted record everywhere: `PlanReader`/`PlanStore`, `StoreOutcome`, `onStore`,
  `StoredRead`, the `plan_store` metric kind. The rename is clean because the branch has not merged and the kind was referenced
  only by the metrics module and its tests.
- **Newer verdict.** A servable isolate verdict (within grace, or `suspended`) is served without reading the store, which
  keeps the §3 "warm isolate does not read KV" invariant. Past grace, the store decides, and an isolate verdict newer than the
  stored record is the one judged, by the same rules as a record, at its own read time. So a warm isolate keeps serving its
  tenants for the 48 h bound during an outage, with their protection and suspension flags, and an older unflagged record cannot
  revert them. A newer isolate lift stands against an older stored suspension. With no store configured, or a failed read, a
  verdict past grace is refused as before. A cache-decided answer reports the outcome the store rules would give (`served`,
  `stale`, `suspended`), so the counter keeps its meaning.
- **Timeout.** `PLAN_LOOKUP_TIMEOUT_MS` = 5 s, passed as `AbortSignal.timeout` to every plan lookup. A timed-out lookup takes
  the same fallback path as a failed one.

## 10. Not in scope

- **Custom-domain tenants get no outage fallback.** They are routed by `createCustomDomainResolver`, a separate endpoint
  (`/v1/tenants/custom-domain`), keyed by hostname. A fallback would need hostname-keyed records written on domain verify and
  removed on domain removal, which is a second writer with its own lifecycle. It is a separate piece of work and is not part of
  this plan. Until it exists, a custom domain is refused during an outage exactly as before.

## 11. Not closed

- **On-change writes (open, a Must in §5B).** Nothing writes a record at the mutation that changes the fact. The planned
  mechanism is an outbox marker, the same pattern as the lifecycle notifications: each fact change inserts a small marker keyed
  by organization, in the same mutation. The sites are `edge.setRecursionPolicy`, the preview password set and clear in
  `projects.ts`, the suspend and lift transitions in `usage.enforceSpendCaps`, the `billing.enforceDunning` transitions, the plan
  change (the entitlement write, which the billing webhook or its sync makes), and the breach transition inside `usage.accrueSpend`
  (compare `organizationServing` before and after; never mark on every ledger row). A minute-cron drains the markers: organization
  to its live scripts to `refreshPlanRecords`, clearing a marker only when none of its scripts failed. That needs a Lunora table and
  a codegen fixture regen. Until it lands, the hourly pass delivers every change, at most about an hour late. The failure direction
  is safe: a new suspension is refused on the next pass, and a lift is refused until it too.
- **Records of scripts that stop being live.** The pass enumerates live deployments only, so a script whose deployment is
  destroyed is never asked about again. Its record is then deleted only if its facts are read as `unknown`, which needs the
  script to be enumerated once more. A non-suspended record lapses at the 48 h bound; a suspended one for a dead script stays and
  refuses a dead hostname. Closing it needs the non-destroyed rows, or a destroy timestamp, as the enumeration source.
- **Per-tick scale.** The pass walks at most `PLAN_RECORDS_PER_TICK` (1000) scripts per hourly tick, from a start that moves one
  slice per hour over sorted names, so a fleet of N is covered every ceil(N/1000) hours. This is an estimate: the per-invocation
  subrequest and CPU limits were not measured against a real fleet.
- **Propagation, write volume, phase E.** Not measured. Phase E needs a staging control plane and a KV namespace.
