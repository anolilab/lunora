# Spike: fat vs thin tenant workers (CLOUD-PLAN.md §6 risk #8, GAPS.md E4)

**Question.** `@lunora/runtime` + `@lunora/do` are bundled **into** every tenant
worker, so a security patch to the runtime today means rebuild + redeploy the
whole fleet. Do we commit to that (fat, with an automated forced-upgrade
pipeline), or move the runtime into a platform-owned worker that tenant scripts
call (thin, one deploy patches everyone)? This is the plan's ⭐ "decide NOW"
item: it dictates the bundle format, the deploy API, and codegen's emit, and
retrofitting fat→thin after launch is a rewrite.

## The architectural constraint that frames everything

Lunora executes **user functions inside `ShardDO`**: the generated function
registry is `import`ed by the DO, and `ctx.db` reads/writes the DO's SQLite
synchronously in-isolate — the OCC transaction model assumes same-isolate,
same-transaction access. workerd has **no dynamic code loading** in production
(no `eval` / `new Function` / dynamic `import()` of fetched code). Two
consequences:

1. **A fully central runtime DO cannot execute per-tenant user code.** The
   platform DO can't load the tenant's functions; shipping them as interpreted
   data is a different (much slower, semantically weaker) product.
2. **The only true-thin shape is a callback architecture**: a central runtime
   worker/DO owns state + protocol, and calls back into the tenant script
   (through the dispatch namespace) for each user-function execution — which
   then needs `ctx.db` operations proxied **back** over RPC mid-function. Every
   query becomes N cross-isolate round trips, and the OCC transaction has to
   hold across them.

So "thin" is not a packaging change; it is a distributed-transaction redesign.
The spike's job is to measure whether the callback shape is even in the right
performance class, and to confirm the WfP binding facts either way.

## Hypotheses to validate on live Cloudflare

1. **H1 — cross-script DO bindings under WfP.** Can a namespaced user worker
   declare a `durable_objects` binding whose `script_name` points at (a) another
   script in the same dispatch namespace and (b) an account-level platform
   worker? If (b) works, the DO _class code_ could be platform-owned while
   instances stay per-tenant — the least-invasive thin variant, blocked only by
   consequence 1 above (it still can't run user functions centrally).
2. **H2 — callback round-trip cost.** Platform worker → `env.DISPATCHER.get(tenant)`
   → tenant executes a trivial function → responds. Measure p50/p99 per call and
   per _chained_ call (simulating one `ctx.db` op per hop, 10 hops). Target to
   keep thin alive: **< 1 ms p50 per hop** (same-machine service-binding class);
   anything in the multi-ms class kills the callback architecture for query
   workloads.
3. **H3 — fleet re-release throughput (the fat path's operating cost).** Using
   the A1 versioned-release + A3 build machinery: how many tenants/hour can we
   rebuild + health-gate + pointer-swap inside the per-account API budget
   (1,200 req / 5 min, ~4 API calls per release)? This prices the fat answer:
   patch latency for a 10k-tenant fleet.

## What's in here

| File                              | Role                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `platform-runtime-worker.ts`      | Account-level "central runtime" stand-in: a DO class + a callback driver for H1b/H2.                                 |
| `platform-runtime.wrangler.jsonc` | Deploys it account-level with a binding to the dispatch namespace.                                                   |
| `thin-tenant-worker.ts`           | Namespaced user worker: answers callback executions; declares the H1 cross-script DO binding in its upload metadata. |
| `thin-tenant.wrangler.jsonc`      | Deploys the tenant into the dispatch namespace.                                                                      |
| `probe.mjs`                       | Node 22 probe (zero deps): runs H1/H2 and prints PASS/FAIL + latency percentiles.                                    |

Run order (needs a live account; see env vars at the top of `probe.mjs`):
`wrangler deploy -c platform-runtime.wrangler.jsonc` →
`wrangler deploy -c thin-tenant.wrangler.jsonc --dispatch-namespace lunora-production` →
`node probe.mjs`. H3 needs no new code — it is a load test of the existing
`/v1/deploy` path; `probe.mjs` prints the arithmetic from measured H2 numbers.

## Provisional recommendation (to confirm or refute with the probe)

**Fat tenant workers, pinned runtime version, automated fleet re-release** — on
current evidence:

- True thin (central execution) is architecturally excluded by
  no-dynamic-loading + user-code-in-DO.
- Callback-thin survives only if H2 lands under ~1 ms/hop _and_ we accept
  rewriting the OCC transaction to span isolates — a large, risky change for a
  benefit (instant fleet patching) the fat pipeline approximates operationally.
- The fat path's classic pain — "rebuild 100k tenants by hand" — is exactly
  what this platform already automates: server-side builds (A3) + immutable
  versioned releases with health-gated pointer swaps (A1) make a forced
  upgrade a _paced batch job_, not an incident. `src/fleet/upgrade.ts`
  implements that job (canary batch → failure-rate halt → fleet), and
  deployments now record their `runtimeVersion` so the planner can target
  exactly the stale ones.

If H1b passes, revisit a **hybrid** at leisure: platform-owned DO _class_ for
the protocol shell with user functions still bundled per-tenant — that would
shrink the patch surface without touching execution semantics. It is an
optimization on top of fat, not a fork in the road.
