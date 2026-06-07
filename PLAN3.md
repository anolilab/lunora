# Cirrus — Plan 3: Dashboard & Observability (Beat Cloudflare)

> Written 2026-06-06. The live roadmap for Cirrus's app-aware dashboard. Where
> [`PLAN.md`](./PLAN.md) / [`PLAN2.md`](./PLAN2.md) built the **framework** (runtime,
> data layer, Convex/kitcn parity — now essentially complete), this plan covers the
> **dashboard/observability layer** that differentiates Cirrus from the Cloudflare
> dashboard. Grounded in the live source (`packages/dashboard/src/*`, the
> `__cirrus_admin__:*` RPC layer in `@cirrus/do`) and two strategy docs:
> [`DASHBOARD-VS-CLOUDFLARE.md`](./DASHBOARD-VS-CLOUDFLARE.md) (what to own / beat /
> hand-off) and [`ECOSYSTEM-BORROW.md`](./ECOSYSTEM-BORROW.md) (what to copy / learn).

## Thesis

**Cloudflare's dashboard is infra-level and domain-blind. Cirrus sits in the request
path and knows the domain model.** Two structural facts make this a durable advantage:

1. CF has **no Durable-Object data browser** — shard data is opaque `__doc__` SQLite
   blobs reachable only through Cirrus.
2. Cirrus **functions are invisible to CF** — they run inside one Worker, so CF metrics
   and logs can't attribute anything to a `<file>:<function>`.

The product goal: **wherever there is a raw infra signal, attach app meaning to it
(function, query, table, index, user, shard, subscription, cache).** That is data CF
structurally cannot show. We hand off only the control-plane/billing surface.

## Already shipped (baseline)

The dashboard (`@cirrus/dashboard`, served over the gated `__cirrus_admin__:*` RPC layer)
ships these tabs today: **Data** (typed doc-expansion + `v.id` ref-navigation + filter
builder + bulk delete), **Globals** (D1), **Schema** (viewer + graph + **indexes**),
**Functions** (runner + **per-function metrics**), **Migrations**, **Scheduled**,
**Export/Import**, **Files** (R2), **Users**, **Health**, **Insights** (auto-detected
slow funcs / error spikes / cache problems), **Metrics**, **Logs**, **Audit** (durable
admin-mutation log). All shard-aware with opt-in live subscriptions.

The framework hooks the differentiators below depend on already exist: the dependency
tracker (`packages/do/src/dependency-tracker.ts` — `SCAN_DEP`/`depKey` know which tables
a query read/scanned), per-function counters (`getFunctionStats`), the reactive cache
stats (`getMetrics`), `getCurrentUserId()`, and the durable reserved-table pattern
(`__cirrus_audit__`, CDC log).

---

## Tier 1 — Differentiators (beat CF). Build in order.

### 1.1 Structured correlated request log `[the keystone]`

**Today.** `Logs` is a 500-entry in-memory RPC-error buffer that resets on hibernation
(`packages/do/src/log-buffer.ts`). Strictly worse than CF Workers Logs.

**Target.** A durable, per-request **structured** log that CF cannot produce: each entry
carries the cirrus function path, shard key, acting `userId`/identity, redacted args,
outcome + execution time, **tables read/written** (from the dependency tracker),
**cache hit/miss**, and **subscriptions re-run**. Client panel filters and correlates on
all of it ("show failed `messages:*` by user U on shard room-9 that scanned `posts`").

**Mapping.** Server: a reserved `__cirrus_reqlog__` SQLite table (mirror the audit-log
append/read/trim pattern), written once per `/rpc` dispatch at the same site that records
metrics/function-stats; bounded retention. A `getRequestLog` admin RPC. Client: upgrade
the Logs panel (correlated filters + a CF-Observability deep-link for the raw firehose).
Borrow filtering/streaming UX ideas from **Fogwatch** (ideas-only).

**Why #1.** It's the single clearest place Cirrus leaves the CF dashboard behind, and
every hook already exists.

### 1.2 Causal metrics & insights attribution `[matrix: Insights/Metrics]`

**Today.** Insights detect slow functions / error spikes / cache issues from
`getFunctionStats` + `getMetrics`, but as independent signals.

**Target.** **Link** them: "`feed:list` is slow _because_ it full-scanned `posts`
(missing index)." Aggregate `SCAN_DEP` per function/table, expose a "full scans by
function / tables read without an index" signal, and render the causal chain in Insights
(→ jump to the Schema/Indexes tab to add the index).

**Mapping.** Small server addition — a per-function scan counter folded into the existing
`recordFunctionCall` site; surface via `getFunctionStats` or a sibling RPC. Client:
Insights gains "missing index" / "full scan" insight kinds with a deep-link to fix.

### 1.3 Files → schema join (copy-safe lift) `[matrix: Files]`

**Today.** Files is a thin R2 browser — largely redundant with CF's R2 object browser.

**Target.** Make it app-aware: which **record** owns a file (storage references in the
schema), typed buckets, app-context signed URLs, **orphan detection** (objects no row
references). CF can't join R2 to the data model.

**Mapping.** **Vendor MIT components from [R2-Explorer](https://github.com/G4brym/R2-Explorer)**
(folders, sharable links w/ password+expiry) — keep the MIT header, as we already do for
the TanStack scripts — and wire them to `@cirrus/storage` typed buckets + schema refs.
The only major copy-safe lift available.

---

## Tier 2 — Depth & ergonomics (borrow ideas)

### 2.1 Data browser: staged edits + decomposition

- Adopt **Outerbase Studio**'s "stage all edits → preview diff → commit" data-editing
  UX (idea, re-implemented — Outerbase is AGPL, no code).
- **Debt:** `data-browser.tsx` is ~1160 lines (over the 1k guideline). Extract the
  `useDataBrowser` hook into its own module before further growth.
- Optional: surface column types so the filter builder offers type-correct operators.

### 2.2 Writer-routed bulk operations

- Replace the client-side N+1 delete loop with a server `deleteRows`/`clearTable` admin op
  routed through the schema-aware writer (keeps FTS/aggregate/rank in sync). Bounded,
  filter-aware. Cleaner and faster than the current loop.

### 2.3 Health → app SLO + time-series

- Compose an app-level SLO view: error rate **per function**, auth-failure rate,
  scheduler backlog, migration status. Add request/error sparklines (the metrics panel
  already has the sparkline primitive) — cirrus-attributed, not CF's per-Worker charts.

---

## Tier 3 — Hand-off & settings (cirrus = app lens, CF = infra plane)

### 3.1 Cloudflare deep-links

From every overlapping panel, link out to the _infra plane_ (not an apology — a handoff):
Logs → Workers Logs, Files → the R2 bucket, Globals → D1 console (raw SQL/Time-Travel),
Metrics → the DO analytics page. Small, high-clarity change.

### 3.2 Settings area (read-only)

A Settings tab surfacing **read-only** deployment config: configured env vars/bindings
(values masked), deploy URL/info. This resolves the deferred env-vars fork
(`DASHBOARD-VS-CLOUDFLARE.md` #4): **view in Cirrus, edit in wrangler/CF** — no runtime
config store.

### 3.3 Emit structured events to Logpush

Have the 1.1 request log also emit its structured events to `console`/Logpush so CF's
pipeline carries them to external SIEMs. Produce richer events; don't reimplement the
transport.

---

## Tier 4 — Deferred / decisions

- **Scheduled backups** — extend shard Export/Import to scheduled snapshots (DO storage
  has no CF backup; D1 has Time-Travel — hand that off). Ref: Durafetch pattern.
- **External integrations** (Sentry/Datadog/Axiom) — defer to CF Logpush + the 3.3 event
  emission rather than building per-vendor adapters in the dashboard.
- **TanStack Query adapter** for the dashboard's own data fetching — open decision
  (carried from PLAN2 #20); the bespoke admin hooks work today.

---

## Non-goals (explicitly CF's plane — do not build)

Deployments / versions / rollbacks / routes; secret **values** or env-var **editing**;
billing & usage metering; account security (WAF, edge rate-limiting, DDoS); the log
**transport at scale** (Logpush is the pipe — we emit into it). For all of these the
dashboard links out; it never half-reimplements them.

---

## Recommended sequencing

```
Tier 1 (differentiators):  1.1 request log → 1.2 causal attribution → 1.3 Files (R2-Explorer)
Tier 2 (depth):            2.1 data-browser decomposition + staged edits · 2.2 bulk ops · 2.3 SLO
Tier 3 (hand-off):         3.1 CF deep-links (quick) · 3.2 Settings (read-only) · 3.3 Logpush emit
Tier 4:                    backups · integrations · TanStack decision
```

**1.1 (structured correlated request log) is the keystone** — it's the clearest "better
than Cloudflare" win and the hooks already exist. Tier 3.1 (deep-links) is the cheapest
high-clarity change and can land anytime.

## Open questions

- **Request-log volume/retention.** Per-shard durable log needs a sane retention cap +
  sampling under high write rates (mirror CDC-log trim). Decide defaults.
- **PII in the request log.** Args/identity must be redacted by default (reuse
  `@visulima/redact`); decide the opt-in for full capture in dev.
- **Storage-reference modelling (1.3).** Does the schema express "this column points at
  an R2 object" today, or does that need a `v.storage()`-style marker first?
