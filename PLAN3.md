# Cirrus — Plan 3: Dashboard & Observability (Beat Cloudflare)

> Written 2026-06-06. The live roadmap for Cirrus's app-aware dashboard. Where
> [`PLAN.md`](./PLAN.md) / [`PLAN2.md`](./PLAN2.md) built the **framework** (runtime,
> data layer, Convex/kitcn parity — now essentially complete), this plan covers the
> **dashboard/observability layer** that differentiates Cirrus from the Cloudflare
> dashboard. Grounded in the live source (`packages/dashboard/src/*`, the
> `__cirrus_admin__:*` RPC layer in `@cirrus/do`) and two strategy docs:
> [`DASHBOARD-VS-CLOUDFLARE.md`](./DASHBOARD-VS-CLOUDFLARE.md) (what to own / beat /
> hand-off) and [`ECOSYSTEM-BORROW.md`](./ECOSYSTEM-BORROW.md) (what to copy / learn).
> Its framework-side counterpart is [`CLOUDFLARE-REUSE-AUDIT.md`](./CLOUDFLARE-REUSE-AUDIT.md)
> (where the _runtime packages_ reuse vs. hand off CF primitives) — keep the log/metrics
> positioning here consistent with it.
>
> **Refreshed 2026-06-07.** Since first writing: backups/PITR + a **Time Travel** panel and
> a read-only **Settings** panel shipped (Tier 4 + Tier 3.2 below now ✅), per-function
> metrics moved to durable SQLite, and storage gained native S3-presigned + R2 multipart.
>
> **Update 2026-06-07 (Tier 1 keystone landed).** The three differentiator items **1.1**
> (structured correlated request log — the keystone), **1.2** (causal full-scan / missing-index
> attribution), and **2.2** (writer-routed bulk ops) shipped together on
> `feat/plan3-observability`. Only **1.3 Files→schema join** remains in Tier 1.

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
admin-mutation log), **Time Travel** (`pitr` — restore a shard to a point in the last 30
days), and **Settings** (read-only deployment config — vars/secrets/bindings, masked).
All shard-aware with opt-in live subscriptions.

The framework hooks the differentiators below depend on already exist: the dependency
tracker (`packages/do/src/dependency-tracker.ts` — `SCAN_DEP`/`depKey` know which tables
a query read/scanned), per-function counters now **persisted to durable SQLite + time
buckets** (`packages/do/src/function-metrics.ts` — `__cirrus_metrics` /
`__cirrus_metrics_buckets`, served by `getFunctionStats`), the reactive cache stats
(`getMetrics`), `getCurrentUserId()`, and the durable reserved-table pattern
(`__cirrus_audit__`, `__cirrus_metrics*`, CDC log).

---

## Tier 1 — Differentiators (beat CF). Build in order.

### 1.1 Structured correlated request log `[the keystone]` — ✅ shipped

**Shipped.** A durable per-request log (`packages/do/src/request-log.ts` →
`__cirrus_reqlog__`, mirroring the audit-log append/trim/read pattern) is written once
per `/rpc` dispatch on both success and error paths, carrying function path, shard key,
acting `userId`/identity, **type-tag-redacted** args, outcome + duration, tables written
(always) / tables read + cache-hit (cached-query paths), served by the `getRequestLog`
admin RPC with server-side correlated filters (function-path prefix, userId, shard,
outcome, table-touched). The Logs panel gained a **Requests** view (durable, filtered)
alongside the kept **Errors** view (in-memory buffer) and a CF-Observability deep-link.
_Deferred:_ `subscriptionsReRun` is recorded as `0` (the refresh runs off-path via
`waitUntil`, so no count is available synchronously); the column exists for a later fill-in.

**Original target.** A durable, per-request **structured** log that CF cannot produce: each entry
carries the cirrus function path, shard key, acting `userId`/identity, redacted args,
outcome + execution time, **tables read/written** (from the dependency tracker),
**cache hit/miss**, and **subscriptions re-run**. Client panel filters and correlates on
all of it ("show failed `messages:*` by user U on shard room-9 that scanned `posts`").

**Mapping.** Server: a reserved `__cirrus_reqlog__` SQLite table (mirror the audit-log /
`__cirrus_metrics` append/read/trim pattern — both already exist), written once per `/rpc`
dispatch at the same site that records metrics/function-stats; bounded retention. A
`getRequestLog` admin RPC. Client: upgrade the Logs panel (correlated filters + a
CF-Observability deep-link for the raw firehose). Borrow filtering/streaming UX from
**Fogwatch** (MIT — code-copyable, though it's a TUI so the value is the UX).

**Consistency with `CLOUDFLARE-REUSE-AUDIT.md` #5.** That audit already ruled: hand the
raw log _transport_ off to Workers Logs / Logpush, keep only a dev/ops readout. This
request log is exactly that — a **cirrus-attributed, queryable readout**, not a competing
transport. It must not grow into a log pipeline; for high-volume metrics route to the
already-implemented `analyticsEngineSink` (audit #3).

**Why #1.** It's the single clearest place Cirrus leaves the CF dashboard behind, and
every hook already exists.

### 1.2 Causal metrics & insights attribution `[matrix: Insights/Metrics]` — ✅ shipped

**Shipped.** Full-scan events (`SCAN_DEP` from the dependency tracker) are aggregated per
function and per `(function, table)` into durable metrics (a `scans` column on
`__cirrus_metrics` + a new `__cirrus_metrics_scans` table), threaded from the dispatch
site through `recordFunctionCall` and surfaced additively on `getFunctionStats`. Insights
gained a **`missing-index`** kind: a slow function with scan attribution now renders the
causal chain ("slowest call full-scanned `<tables>` with no index") with an **"add index"
deep-link** that navigates to the Schema tab pre-expanded on the offending table.

**Original target.** **Link** them: "`feed:list` is slow _because_ it full-scanned `posts`
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

### 2.2 Writer-routed bulk operations — ✅ shipped

- **Shipped.** Server `deleteRows` / `clearTable` admin ops route through the schema-aware
  writer (FTS/aggregate/rank shadow tables + `onDelete` cascades stay in sync), reusing
  `readTablePage`'s filter/search predicate via a shared `selectMatchingIds`. Bounded by a
  hard `SHARD_BULK_DELETE_CAP = 500` per call returning `{ deleted, hasMore }`; the data
  browser now loops the single server call (capped) instead of issuing one `writeRow` per
  row, and gained a "clear table" affordance. The generated `ShardDO` emits a
  `deleteRowThroughWriter` override so codegen consumers get the writer path.

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

### 3.2 Settings area (read-only) — ✅ shipped

A Settings tab (`settings-panel.tsx`) surfaces **read-only** deployment config — env
vars/bindings with values masked. Resolves the deferred env-vars fork
(`DASHBOARD-VS-CLOUDFLARE.md` #4): **view in Cirrus, edit in wrangler/CF** — no runtime
config store. _Possible follow-up:_ deploy URL/info + the 3.1 deep-links wired in here.

### 3.3 Emit structured events to Logpush

Have the 1.1 request log also emit its structured events to `console`/Logpush so CF's
pipeline carries them to external SIEMs. Produce richer events; don't reimplement the
transport.

---

## Tier 4 — Deferred / decisions

- **Scheduled backups + PITR — ✅ shipped.** A `registry/backup` item (cron-driven
  `snapshot` → timestamped R2 NDJSON + retention `prune`), the `cirrus backup
create|list|pitr|restore` CLI, and the **Time Travel** dashboard panel (`pitr-panel.tsx`)
  cover this. DO shard state has no native CF backup, so this is cirrus-owned; D1's own
  Time Travel is handed off (see `CLOUDFLARE-REUSE-AUDIT.md` #2).
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
Tier 1 (differentiators):  1.1 request log ✅ → 1.2 causal attribution ✅ → 1.3 Files (R2-Explorer)
Tier 2 (depth):            2.1 data-browser decomposition + staged edits · 2.2 bulk ops ✅ · 2.3 SLO
Tier 3 (hand-off):         3.1 CF deep-links (quick) · 3.2 Settings ✅ · 3.3 Logpush emit
Tier 4:                    backups ✅ · integrations · TanStack decision
```

**1.1 (structured correlated request log) — the keystone — is now shipped**, along with
1.2 (causal attribution) and 2.2 (bulk ops). Next up: **1.3 Files→schema join**
(R2-Explorer lift, the last Tier-1 item) and the cheap **3.1 CF deep-links**, which can
land anytime. Tier 3.3 (Logpush emit) now has a natural home — fold it into the 1.1
request-log write site.

## Open questions

- **Request-log volume/retention.** Per-shard durable log needs a sane retention cap +
  sampling under high write rates (mirror CDC-log trim). Decide defaults.
- **PII in the request log.** Args/identity must be redacted by default (reuse
  `@visulima/redact`); decide the opt-in for full capture in dev.
- **Storage-reference modelling (1.3).** Does the schema express "this column points at
  an R2 object" today, or does that need a `v.storage()`-style marker first?
