# Cirrus Dashboard ↔ Cloudflare Dashboard — Boundary & Strategy

> Written 2026-06-06. Decides what the cirrus dashboard should own, where it should
> beat Cloudflare's own dashboard, and the few places it should hand off. Grounded in
> the current dashboard surface (`packages/dashboard/src/*`) and the cirrus runtime
> (`@cirrus/do`, `@cirrus/runtime`, `@cirrus/scheduler`, `@cirrus/storage`).

## The principle

**Cloudflare's dashboard is infra-level and domain-blind. Cirrus sits _in the request
path_ and knows the _domain model_.** Cloudflare sees bytes, Worker invocations, and
opaque Durable Object storage. Cirrus sees functions, queries, the schema, reactive
dependencies, auth identity, subscriptions, cache, and OCC. CF observes
infrastructure; cirrus observes the _application_.

Two structural facts follow:

1. **CF has no Durable-Object data browser.** Shard data (the default topology) lives in
   DO SQLite as opaque `__doc__` JSON blobs and is reachable _only_ through cirrus. Only
   `.global()` tables live in D1, where CF's SQL console partially overlaps.
2. **Cirrus functions are invisible to CF.** They run inside a single Worker, so CF's
   per-Worker metrics/logs cannot attribute anything to a `<file>:<function>`.

**Consequence: in almost every overlapping area, cirrus can show _strictly better_ data
than Cloudflare — richer, correlated, domain-attributed, causal — not merely
redundant.** The goal is not to thin overlapping panels down to a lesser CF; it is to
make them show what CF structurally cannot.

The only real exception is the **control-plane / billing** surface, where cirrus has no
privileged information and should _link out_ rather than compete.

---

## Area-by-area

Legend: **own** = CF is blind, cirrus is the only lens · **beat** = overlaps CF but
cirrus can show better data via domain correlation · **hand-off** = CF is authoritative,
deep-link out.

| Dashboard area | CF coverage | Verdict | Why |
| --- | --- | --- | --- |
| **Data** (shard tables) | None — no DO data browser exists | **own** | Opaque DO SQLite; typed doc-expansion + `v.id` ref-navigation only cirrus can do. |
| **Schema / graph / indexes** | None | **own** | shardBy/global, aggregate/rank/vector indexes, relations are cirrus concepts. |
| **Functions + per-function metrics** | Per-_Worker_ only | **own** | Functions are sub-Worker and invisible to CF. The standout differentiator. |
| **Migrations** | None | **own** | No CF concept of cirrus data migrations. |
| **Scheduled jobs** (SchedulerDO) | CF Cron Triggers are _Worker-level_ cron | **own** | `runAfter`/`runAt` is app-level, a different thing. |
| **Users / sessions** (auth) | None | **own** | App-level identity. |
| **Insights** | None | **own** | Slow-query / missing-index / cache-health signals are cirrus-internal. |
| **Audit log** | None | **own** | App-mutation audit; CF has nothing equivalent. |
| **Export / Import** (shard NDJSON) | D1 has Time-Travel/backups; **DO SQLite has no CF backup** | **own** (shards) | Only path to back up/move DO shard state. |
| **Globals** (D1 tables) | CF D1 console runs raw SQL on the same data | **beat** | Typed, doc-expanded, ref-navigable view; hand off to CF D1 for raw SQL / Time-Travel. |
| **Health** | Partial — Workers analytics (invocations/errors/CPU) | **beat** | Compose an app-SLO view (per-function error rate, auth failures, scheduler backlog, migration status). |
| **Metrics** | Per-DO requests/duration/storage | **beat** | Add per-function/per-query metrics, reactive-cache hit-rate, per-table hotspots, OCC retries, **causal attribution** (which query/scan made it slow). |
| **Logs** | Workers Logs / `wrangler tail` / Logpush (raw, persisted, at scale) | **beat** | Structured, _correlated_ request log: function, shard, userId, args (redacted), outcome, timing, tables read/written, cache hit/miss, subscriptions re-run. CF cannot correlate any of that. |
| **Files** (R2) | CF R2 object browser (list/upload/download/delete, lifecycle) | **beat** _(if it joins the schema)_ | Correlate objects to owning records, typed buckets, app-context signed URLs, orphan detection. Plain key-browsing alone is redundant with CF. |
| **Env vars** (#4, deferred) | CF owns Workers vars + secrets | **hand-off** | At most a read-only view; editing belongs in wrangler/CF. |
| Deploys / versions / rollbacks / routes | CF control plane | **hand-off** | Cirrus has no special API; pure CF. |
| Secret _values_ | CF | **hand-off** | Do not display secret values. |
| Account security (WAF, edge rate-limit, DDoS) | CF | **hand-off** | Edge/account plane. |
| Log _transport at scale_ / Logpush to SIEM | CF Logpush + Tail Workers | **hand-off** (emit, don't reimplement) | Produce richer _events_ into `console`/Logpush; let CF's pipeline carry them. |
| Billing & usage metering | CF | **hand-off** | CF is the source of truth. |

---

## Where cirrus beats CF — the concrete wins

The through-line: **wherever there is a raw infra signal, cirrus can attach app meaning
to it (function, query, table, index, user, shard, subscription, cache) — and that is
better data.**

- **Logs → structured correlated request log.** Today's panel is a 500-entry in-memory
  RPC-error buffer that resets on hibernation (`packages/do/src/log-buffer.ts`). The
  _upgrade_ (not demotion) is a durable, per-request structured log — function path,
  shard key, `getCurrentUserId()` identity, redacted args, outcome + execution time,
  tables read/written (the dependency tracker already knows — `SCAN_DEP`/`depKey` in
  `packages/do/src/dependency-tracker.ts`), cache hit/miss, and subscription fan-out.
  CF physically cannot say "`messages:send` by user U on shard `room-9` wrote `messages`,
  missed cache, re-ran 3 live queries in 4ms." **This is the single biggest "better than
  CF" win and the hooks already exist.**
- **Metrics/Insights → causal attribution.** CF says "the Worker took 200ms"; cirrus can
  say "_because_ `feed:list` full-scanned `posts` (missing index)." The per-function
  stats (`getFunctionStats`) and the full-scan signal (`SCAN_DEP`) already exist — surface
  the _link_ between them.
- **Files → join to the schema.** Which record owns a file, typed buckets, app-context
  signed URLs, orphaned-object detection. CF can't join R2 to the data model; cirrus can.
- **Health → app SLO.** Error rate per function, auth-failure rate, scheduler backlog,
  migration status — a composite CF can't assemble because it doesn't know those concepts.

---

## What this changes (recommendation)

An earlier take suggested "thin out Logs/Files/Metrics and defer to Cloudflare." **That
was wrong** — it treated cirrus as a lesser CF. Corrected strategy:

1. **Logs → upgrade, not demote.** Build the structured, correlated, persisted request
   log. Highest-leverage differentiator; hooks already present.
2. **Metrics/Insights → add causal attribution** (per-query, per-table, full-scan →
   function). Collect the links, not just the counters.
3. **Files → join to the schema** (record-ownership + orphans) where storage references
   exist; otherwise keep minimal.
4. **Deep-link to Cloudflare _only_ from the genuine control-plane gaps** (billing,
   deploys, secrets, raw Logpush) — as a hand-off to the _other plane_, not an apology.

The richest next build is the **structured correlated request log** — it is the clearest
place cirrus leaves the Cloudflare dashboard behind.

---

## Sort rule (for future features)

> Does this require knowing the cirrus data/function model?
>
> - **Yes →** cirrus owns it, and can beat CF by correlation. Build it.
> - **No, and cirrus has privileged in-path data →** still beat CF by attaching app
>   meaning to the raw signal.
> - **No, and it's control-plane / billing →** hand off to Cloudflare with a deep-link.
