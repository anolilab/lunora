# Plan 476 — Serve last-verified tenant plans through a control-plane outage, from storage that outlives the isolate

**Baseline:** `origin/feat/cloud-platform-dx` @ `1d8f444fe` (2026-10-11)
**Status:** TODO (sequenced after plan 475). Staleness bound decided: 48 hours.

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

**A. Persistence port (S).** A small `PlanStore` interface (`get`, `put`) with a KV implementation and an in-memory one for
tests. The resolver takes it as an option, so `route.ts` gains no Cloudflare types.

**B. Control-plane writer (M).** On each fact change, write the record after the D1 commit, and retry failed writes from the
hourly sweep. The refresh sweep rewrites records older than 20 hours. The control plane gets a KV write binding; the dispatcher
gets a read-only binding.

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

| Phase | Work                                                                                             | Gate                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 0     | Measure: count cold-isolate lookups during a staged outage; read KV's current propagation figure | Recorded numbers in this file                                                                             |
| 1     | A, C with unit tests for every row of the §3 contract                                            | `pnpm --filter @lunora/cloud run test` green; a test fails if the persisted-suspension refusal is removed |
| 2     | B with the write-volume estimate recorded                                                        | Writes per day measured on staging against the tenant count; estimate and KV plan limit recorded          |
| 3     | D and E                                                                                          | Staging drill output recorded here                                                                        |

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
