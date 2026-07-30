# `@lunora/observability`

Host-neutral telemetry storage and read models for Lunora — the data behind the Studio's Logs, Traces, Metrics and Issues views.

## What's in it

| Area            | Modules                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Logs**        | `request-log` (durable, redacted request records), `log-buffer` (in-memory ring for the live tail)                             |
| **Traces**      | `context-telemetry` (`ctx.trace` / span creation), `span-buffer` (ring + waterfall folding), `trace-context` (W3C traceparent) |
| **Metrics**     | `function-metrics`, `query-metrics`, `auth-metrics`, `database-telemetry`, `metric-buffer`, `metric-history`                   |
| **Issues**      | `issue-state` (grouping + status), `issue-explainer` (AI explanation of a grouped issue)                                       |
| **Audit**       | `security-audit` (configuration findings)                                                                                      |
| **Correlation** | `storage-correlation`                                                                                                          |

## Why it is its own package

None of it is Cloudflare-specific. It reads and writes through the SQL handle the engine hands it, and it lived inside `@lunora/do` only because that is where the Durable Object it instruments happens to live.

That mattered in practice: anything wanting request logs or metrics had to depend on the Cloudflare Durable Object package to get them. The dependency now runs `@lunora/do` → `@lunora/observability` → `@lunora/shard-engine`, so a second host consumes this directly rather than inheriting a provider-bound edge.

`@lunora/do` re-exports every symbol it previously exposed from these modules, so existing imports and the codegen-emitted surface are unchanged.

## Host-specific values are injected, not baked in

Three details are Cloudflare's rather than this package's, so the host passes them:

- **AI model** — `explainIssue(binding, args, { defaultModel })`. `DEFAULT_EXPLAIN_ISSUE_MODEL` is a Workers AI id, exported so the Cloudflare host has a name to pass rather than a string literal.
- **Query batch size** — `readIssueStates(sql, hashes, { hashQueryBatch })`. `DEFAULT_HASH_QUERY_BATCH` is 100, the Durable Object SQLite bound-parameter cap; a host with a different cap passes its own.
- **Span projections** — `HostSpanLike`, `HostTracingLike`, `HostTracingResolver`, `resolveHostTracing`, `fuseHostSpans`, `applyHostSpanAttributes`. Named for the role, not the provider. Cloudflare's `enterSpan` callback argument is one shape that satisfies them.

## Importing it

Import from this package directly. `@lunora/do` deliberately does **not** re-export it — doing so would put the Cloudflare package back in the middle of a dependency it does not own, and would mean a second host reaching telemetry _through_ Cloudflare.
