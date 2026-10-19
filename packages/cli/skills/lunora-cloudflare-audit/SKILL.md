---
name: lunora-cloudflare-audit
description: Audits a Lunora app for Cloudflare cost and reliability risk before launch or after a surprise bill. Chains the read-only `lunora doctor`, `lunora advisor` and `lunora insights` signals, then traces what they cannot see — retry and fan-out loops, cron cadence, public routes that reach a metered product (Workers AI, Browser, Containers, Vectorize, R2, D1), preview environments with paid bindings, and missing usage alerts (`lunora cloudflare alerts`). Reports each finding with the billing meter it moves, the smallest fix, and how to verify. Use when the user asks to "audit before launch", "what could blow up our Cloudflare bill", "why did the bill spike", "is this safe to put on the public internet", or "review our cron / queue / AI / workflow cost". For a slow query or OCC conflict use `lunora-performance-audit`; for a failing deploy use `lunora-deploy`.
---

# Lunora Cloudflare Audit

Diagnose from evidence: name the mechanism that spends money or breaks, point at
the line, and prescribe the smallest fix. Lunora already ships three scanners,
so this skill is mostly the order to run them in and the judgment they lack.

Recurring work (crons, queue consumers, workflows) has no public entry point, so
check it before concluding costs are modest. If nothing metered is reachable
from outside, traffic is modest and nothing recurs, say so and stop. Do not
manufacture findings to fill a report.

## Ground rules

- **Evidence first.** Every finding needs a file and line (or command output)
  and a concrete Cloudflare mechanism. "Could be expensive" is not a finding.
- **Prices and limits come from current docs, never memory.** Name the meter
  (DO requests, DO duration, SQLite rows read, D1 rows written, R2 Class A ops,
  Workers AI neurons, Browser duration, Vectorize queried dimensions, …) and
  fetch the current Cloudflare pricing/limits page before quoting a unit, an
  allowance or a cap. If you could not fetch it, say the claim is unverified.
- **Do not infer account state from the repo.** Alerts, WAF, cache rules, Access
  and billing live in the dashboard. Without an export or screenshot, list that
  scope as _not inspected_.
- **Confirmed vs suspected.** A scanner hit is a lead. Confirm it against the
  code path before it becomes a finding.
- **Read-only.** Never run `lunora doctor --fix`, `deploy`, or `cloudflare
alerts setup` from an audit. Show the change and get explicit approval first.

## Workflow

1. **Scope.** Which wrangler environments (read each `env.<name>` block in
   `wrangler.jsonc` or `wrangler.json`, the two files Lunora reads; the scan
   commands below take no `--env`), and which paths
   are hot: public queries/mutations, HTTP actions, crons, queue consumers,
   workflows.
2. **Preflight signal** (read-only; never pass `--fix`):

    ```bash
    lunora doctor --format json        # wrangler bindings, paid products, sampling, DO class budget
    lunora advisor --format json --no-write   # static lints, scored per procedure
    ```

    `lunora doctor` reports `paid-product-bound` (a metered binding is declared:
    Workers AI, Browser, Images), `observability-full-sampling`,
    `r2-lifecycle-unset`, `cpu-limit-missing` and `do-class-budget-*`.
    `lunora advisor` lint ids are listed below.

3. **Runtime signal, only if the user points you at a worker that has served
   traffic.** `lunora insights` (local by default). Production needs `--prod` and
   the user's admin token, plus `--url …` when the checkout has no production
   link; do not go looking for a token.
4. **Account signal.** `lunora cloudflare alerts` (status) reads last month's
   usage and which products have a usage alert. Needs Cloudflare credentials;
   ask first. Budget alerts have no API, so they are always _not inspected_.
5. **Trace the gaps** in the next section by reading code.
6. **Report** in the format at the end.

## What each signal already covers

Check this table before reading code by hand. Only the last column is yours.

| Risk                                         | Already flagged by                                                                                                                                                              | Still read by hand                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-table reads re-sent to every subscriber | `unbounded_collect`, `unbounded_collect_on_open_range`, `filter_without_index`, `count_without_index`, `filter_after_index_scan`                                                | Whether the table will actually grow; `.global()` D1 cost                                                                                                                                                                          |
| Runaway loops and re-arming schedules        | `unbounded_loop`, `self_reschedule_without_progress`, `dispatch_cycle`, `queue_dispatch_cycle`                                                                                  | Loops spanning a Queue → Worker → DO hop the graph cannot see                                                                                                                                                                      |
| Sweeps that re-read the same rows            | `unbounded_collect_on_open_range`                                                                                                                                               | —                                                                                                                                                                                                                                  |
| Cron cadence                                 | `cron_every_minute` (sees `cronJobs()` registrations only)                                                                                                                      | Every-minute schedules the lint cannot see: `createWorker({ crons })` handlers and `backupCron` in the worker entry; what any tick does: rows read, calls made per fire                                                            |
| Queue retries losing messages                | `queue_without_dlq`                                                                                                                                                             | Retry delay and `maxRetries` against the downstream's own rate limit                                                                                                                                                               |
| Hot shard / wide fan-out                     | `privileged_fanout_from_public_procedure`; `hot_shard` and `fan_out_breadth` are runtime lints, shown in the Studio Advisors tab against a live worker, not by `lunora advisor` | Shard traffic on a live worker (Studio Advisors); singleton shard keys (`"global"`, an env var) on `.shardBy()`                                                                                                                    |
| Unbounded AI use                             | `ai_unbounded_generation_public`, `ai_run_without_logging`                                                                                                                      | Output and usage bounds on every raw `ctx.ai.run()` (`ai_raw_run_escape_hatch` only checks where the model id comes from, so a fixed-model call escapes it); a `ctx.ai` call inside a retry or `Promise.all` over user-sized input |
| Browser / Containers left running            | `browser_user_url_without_allowlist`, `container_long_sleep_after`, `container_oversized_instance` (the container lints read configuration, not lifecycle)                      | A browser session opened without a close path in an `action`; named container starts that are never stopped or destroyed once their work finishes, within the configured idle window                                               |
| Public mutations with no throttle            | `public_mutation_without_ratelimit`, `ratelimit_default_memory_store`, `ratelimit_key_spoofable_or_global`                                                                      | Public _reads_ that reach a metered product                                                                                                                                                                                        |
| Upload size and type                         | `storage_upload_without_max_size`, `storage_upload_without_content_type_allowlist`                                                                                              | Egress and lifecycle on the bucket (`r2-lifecycle-unset`)                                                                                                                                                                          |
| Secrets in the repo                          | `hardcoded_secret`, `plaintext_secret_in_wrangler_vars`                                                                                                                         | —                                                                                                                                                                                                                                  |
| Log volume                                   | `observability-full-sampling` (doctor)                                                                                                                                          | Retention and plan                                                                                                                                                                                                                 |
| Handled by construction                      | Codegen reconciles bindings, DO migrations and the compatibility date; `ShardDO` uses the WebSocket Hibernation API                                                             | Nothing, unless `wrangler.jsonc` was hand-edited                                                                                                                                                                                   |

## Gaps to trace by hand

For each, find the call site, then count the billed units per user action.

- **Fan-out without a cap.** `Promise.all(items.map(...))` or a loop that calls
  `ctx.db`, `ctx.runMutation`, `ctx.scheduler.runAfter`, a queue send
  (`ctx.queues.<name>.send` / `sendBatch`) or `ctx.ai` once per element of user-sized input. Cap the batch or hand the list
  to a Queue/workpool with a concurrency limit.
- **Retry storms.** A retry (hand-rolled, queue `maxRetries`, workflow step
  retry) around a call that is itself billed or rate-limited, with no backoff or
  circuit breaker. A workflow step that retries a paid `ctx.ai` call bills each
  attempt.
- **Webhooks with side effects and no dedupe.** An `httpAction` for a provider
  webhook that writes or sends mail without keying on the event id. Providers
  redeliver. (Payment webhooks have their own lints; this is every other
  provider.)
- **Preview / staging with paid bindings.** An `env.<name>` block that binds
  Workers AI, Browser, Containers or the production R2 bucket and is reachable
  without auth.
- **Enumeration on hot paths.** Storage enumeration through
  `ctx.db.system.query("_storage")` or a Vectorize query (`ctx.vectors.query`)
  inside a `query` that every subscriber re-runs. (`ctx.storage.list` is
  action-only.)
- **Third-party origins.** An action that fetches a public serverless URL on
  every request instead of caching, queueing, or using a service binding.

## Public-path cost gate

Run this whenever an anonymous caller (an unauthenticated `query`, a public
`httpAction`, a crawlable GET) can reach a metered product. The caller does not
have to be a crawler: any script can repeat the request.

1. List the public entry points (`lunora advisor` flags `http_action_missing_auth_guard`;
   read `lunora/http.ts` and the public builders). Also read the custom routes
   registered on the app in the worker entry (`defineApp()`): they run outside
   the HTTP-action router, so no lint covers their use of paid `env` bindings.
2. For each, trace arbitrary, missing and malformed inputs. Where is the first
   rejection, and does it happen **before** the metered call?
3. State the per-hit unit (one DO request? N rows read? one AI inference? one
   browser session?) and the exposure: `anonymous requests × units per request`.
   Only count a cache if it sits in front of the work and its misses, expiry and
   concurrent fills are also bounded.
4. Verdict: **BLOCK** when evidence shows repeated anonymous requests run
   corpus-scale or high-unit work before validation; **CONDITIONAL** when the
   shape may exist but a query plan, measurement or config is missing (never
   assume safe); **PASS** only when the expensive path is prevented before it
   executes.

A rate limit or alert that fires _after_ the metered work started is defense in
depth, not a fix. The fix is to reject early, bound the work, or move it behind
auth.

## Report

Lead with scope, then one card per finding, most severe first.

```markdown
## Lunora Cloudflare audit

Scope inspected: <paths, env, commands run>
Scope not inspected: <dashboard / alerts / billing / prod>
Docs refreshed: <URLs fetched, or "none — claims marked unverified">

### <critical|high|medium|low> — <title>

- Evidence: <file:line or command output; lint id / doctor code if one fired>
- Mechanism: <the billed meter or failure, in Cloudflare terms>
- Fix: <smallest change; the better primitive if the primitive is wrong>
- Cost / trade-off: <meter moved, effort, downside>
- Verify: <command or check that proves it>
- Confidence: <high|medium|low>
```

Severity: **critical** = exposed secret, public data exposure or an unbounded
billed loop; **high** = anonymous traffic reaches high-unit work, or a retry
path bills each attempt; **medium** = a cost or reliability gap that grows with
usage; **low** = hygiene. If nothing is supported, write `No confirmed findings.`
and list what was not inspected.

End with the proposed next steps, and offer `lunora cloudflare alerts setup
--email <address> --dry-run` if no usage alert exists. Do not run it unasked.
