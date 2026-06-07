# Cloudflare Reuse Audit

Validation of Cirrus's packages against the upstream Cloudflare docs (cloned to `/tmp/cloudflare-docs`,
888 MB) to find places where we built something Cloudflare's platform already provides natively — and
should therefore reuse, hand off to, or at least document why we don't.

Scope: `@cirrus/{scheduler, do, runtime, d1, storage, observability, vectors, ratelimit}`. Each finding
lists the Cirrus code, the native primitive it overlaps, and a verdict: **REUSE** (replace ours),
**HAND OFF** (delegate to the platform tool), **ADD** (adopt a native primitive we're missing), or
**KEEP (with reason)** (intentional divergence — document it).

Legend for effort: 🟢 small · 🟡 medium · 🔴 large.

---

## Ranked findings

### 1. 🟢 ADD — `setWebSocketAutoResponse` for hibernation-safe keepalive _(HIGH)_

**Cirrus:** `packages/do/src/shard-do.ts:2570-2587` runs subscription WebSockets through the Hibernation
API but implements no ping/pong keepalive. Idle subscription sockets either rely on the client to ping
(which wakes the DO and bills a request) or risk silent half-open connections.

**Native:** `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong))` lets the
runtime answer a known ping payload with a canned pong **without waking the Durable Object** — exactly
the keepalive case for hibernated subscription sockets. Billable-wakeup savings on every idle heartbeat.

**Verdict:** Adopt it. Set one auto-response pair when we accept a hibernatable subscription socket;
keep our app-level protocol for everything that genuinely needs the DO awake. Smallest high-value win
in the audit.

---

### 2. 🟡 HAND OFF — D1 CDC "replay-PITR" framing → D1 Time Travel _(MED)_

**Cirrus:** `packages/d1/src/d1-ctx-db.ts:94,1149` maintains a `__cdc_log` change table and frames part
of it as a "replay-PITR" restore path — reconstructing a past state by replaying the changelog forward.
That reinvents D1's own point-in-time recovery **non-atomically** (replay can interleave with live
writes; no single consistent cut).

**Native:** D1 **Time Travel** restores a database to any timestamp/bookmark in the last 30 days as a
first-class, atomic operation (`wrangler d1 time-travel restore --timestamp=…`). No changelog replay,
no consistency window.

**Verdict:** Drop the "replay-PITR" _framing_ and hand point-in-time restore off to D1 Time Travel. The
`__cdc_log` table itself is legitimate — keep it for **streaming export / CDC consumers** (its real job).
This is a documentation + a small code deletion (remove the replay-restore path), not a rewrite.

---

### 3. 🟢 ADD — `analyticsEngineSink` for the metrics plane _(MED)_

**Cirrus:** `packages/observability` names an `analyticsEngineSink` in `observability.ts` but never
implements it. Metrics accumulate into a `__cirrus_metrics_buckets` time-series table inside the DO —
correct for exact, queryable counters, but it's storage we own and grow.

**Native:** Workers **Analytics Engine** (`env.AE.writeDataPoint({...})`) is the platform's
unbounded-cardinality, sampled time-series store, queryable over SQL. It's the natural backing for the
high-volume, approximate slice of our metrics.

**Verdict:** Implement the already-named `analyticsEngineSink` as a thin `writeDataPoint` wrapper. Keep
the exact in-DO accumulators for counters that must be precise (billing, quotas); route high-volume
observability metrics to AE. Cleanest single fix — we're filling in a stub we already declared.

---

### 4. 🟡 KEEP (with reason) / offer variant — scheduler workpool ↔ Cloudflare Queues _(HIGH)_

**Cirrus:** `packages/scheduler` `createWorkpool` implements a durable semaphore with retry, backoff,
dead-letter, and delayed-dispatch on top of `SchedulerDO`. That's a substantial overlap with Cloudflare
Queues: `max_concurrency`, `max_retries`, `retry({ delaySeconds })`, `dead_letter_queue` are all native.

**Native:** **Cloudflare Queues** covers concurrency-capped, retried, dead-lettered, delayed job
dispatch out of the box. `dispatchToShard` is the consumer shim that would sit in front of a queue
consumer.

**Verdict:** **Keep** the workpool — it earns its place where Queues can't follow: a _hard_ concurrency
cap, per-job cancellation, and per-job status introspection. But **offer a Queues-backed variant** for
the common "just rate-limit my background jobs" case, and at minimum **document why we don't use Queues
by default**. Alarms + Cron Triggers usage elsewhere in the scheduler is correct reuse — but verify
codegen **warns when a project declares >3 distinct cron expressions** (the platform's 3-trigger limit).
Do **not** grow multi-step orchestration on SchedulerDO — that's Cloudflare **Workflows**' job
(`step.do` / `step.sleep` / `step.waitForEvent`).

---

### 5. 🟡 HAND OFF — observability log-buffer → Workers Logs / Logpush _(MED)_

**Cirrus:** the log-buffer in `packages/observability` is effectively a stub transport.

**Native:** Workers **Logs**, **Logpush**, and **Tail Workers** are the platform's log transport and
sink. We should not build a real log pipeline here.

**Verdict:** Hand raw log transport off to Workers Logs / Logpush. Keep only a tiny in-dev readout
buffer for the dashboard's live log panel. Don't invest in a production log transport of our own.

---

### 6. 🟢 KEEP (with reason) — R2 signed URLs (custom HMAC vs native presigned) _(HIGH keep)_

**Cirrus:** `packages/storage` signs object URLs with a custom HMAC scheme rather than R2's native
S3-style presigned URLs.

**Native:** R2 supports **S3 presigned URLs** directly.

**Verdict:** **Keep** — our scheme exists so access can be **gated through the app** (auth/session checks,
per-object policy) rather than handing out a bearer-style S3 URL. That's a real product reason. Action
items are documentation-only: state the positioning clearly, and _optionally_ expose a native-presigned
adapter for callers who want raw S3 URLs. Separately, **LOW gap:** we don't wrap R2 **multipart upload**
— worth adding later for large objects. Sessions API + batch usage in D1 is correctly reused.

---

## Confirmed keeps (native already reused, or divergence justified)

| Area                | Native primitive             | Why it's fine                                                                                                                                                                    |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cirrus/vectors`   | Vectorize                    | Already a thin wrapper over Vectorize — no over-build.                                                                                                                           |
| `@cirrus/ratelimit` | native Rate Limiting binding | Justified divergence: the native binding is per-colo, intentionally approximate, and only supports 10–60 s windows. Our limiter needs cross-colo accuracy and arbitrary windows. |
| DO **Alarms**       | `state.storage.setAlarm`     | Correct reuse in scheduler.                                                                                                                                                      |
| **Cron Triggers**   | `triggers.crons`             | Correct reuse — codegen emits them (verify the >3-trigger warning, see #4).                                                                                                      |
| **D1 Sessions API** | read-your-writes sessions    | Correctly reused for the `.global()` read plane.                                                                                                                                 |
| reactive-cache      | Cache API / KV               | Unrelated — it's an in-request query memo, not an HTTP/edge cache. No overlap.                                                                                                   |
| `runInTransaction`  | `transactionSync`            | Keep — our raw `BEGIN`/`COMMIT` supports **async** handlers, which `transactionSync` can't. Possible future: a sync-body fast path (mind the cursor-snapshot caveat).            |

---

## Recommended order of work

Cheap, clearly-correct wins first:

1. **#1 `setWebSocketAutoResponse`** — small, pure savings, no API surface change.
2. **#3 `analyticsEngineSink`** — fill in the stub we already named.
3. **#2 drop D1 "replay-PITR" framing** → point users at D1 Time Travel (deletion + docs).
4. **#5 log-buffer hand-off** docs + shrink to a dev-only readout.
5. **#6 / #4 documentation** — write down the R2-signed-URL and workpool-vs-Queues positioning.

Larger / decision-gated:

6. **#4 Queues-backed workpool variant** — real feature work; only if the "just rate-limit jobs" use
   case is common enough to justify a second implementation.
7. **#6 native-presigned R2 adapter** + **R2 multipart wrapper** — additive, do when a caller needs them.

---

_Generated from a 5-agent audit against the Cloudflare docs at `/tmp/cloudflare-docs`. Findings ranked
by value-to-effort; "keeps" are credited so the divergences are on the record, not silently carried._
