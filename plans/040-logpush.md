# Plan 040: Logpush

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 388a6423..HEAD -- packages/config/src/wrangler-validator.ts packages/studio/src/features/logs`. Confirm `log-drains-panel.tsx` still renders the `logpush: true` snippet (cited below) and `wrangler-validator.ts:39-44` still defines `TailConsumer`. On mismatch, STOP.

## Status

- **Priority**: P2 — operationally useful (ship logs to R2/SIEM/HTTP for retention + audit) and cheap to support, but not on the core type-safe-backend critical path.
- **Effort**: S
- **Risk**: LOW — a config flag + validator nicety + docs; no runtime behavior change.
- **Depends on**: none
- **Category**: config-flag + docs (connect to existing Studio logs story)
- **Planned at**: commit `HEAD`, 2026-06-15

## Verdict

**Worth a small amount of work — but most of the value already ships.** Logpush is enabled by `"logpush": true` in `wrangler.jsonc` plus out-of-band **Logpush jobs** (R2 / HTTP / SIEM sinks) created via the Cloudflare API/dashboard — _not_ via worker bindings. The Studio already surfaces this: `packages/studio/src/features/logs/log-drains-panel.tsx:65-68` renders a "Logpush" card with the exact `{ "logpush": true }` snippet, alongside Tail Workers (`tail_consumers`) and Workers Logs cards. And `tail_consumers` is already validated end-to-end (`wrangler-validator.ts:39-44`, `validateTailConsumers` at `:300-322`, `withTailConsumer` at `:331-340`). So the remaining gap is tiny: teach the validator that `logpush` is a **known boolean key** (so it isn't flagged/typoed), and add a doc note tying the flag to the Studio panel. Do **not** build a Logpush-job CRUD API in Lunora — job creation is dashboard/API territory and out of scope.

## Current state

- **Studio already documents it**: `packages/studio/src/features/logs/log-drains-panel.tsx:65-68` — `id: "logpush"`, `snippet: ["{", '  "logpush": true', "}"].join("\n")`, `title: t("Logpush")`. The panel comment (`:54`) explicitly lists "Workers Logs / Logpush / Tail Workers" forwarding paths and deep-links to the CF observability dashboard via `CLOUDFLARE_OBSERVABILITY_URL` (`packages/studio/src/lib/cf-links.ts:19`).
- **`tail_consumers` is fully wired** (the sibling feature): `wrangler-validator.ts` defines `TailConsumer` (`:39-44`), validates it (`validateTailConsumers`, `:300-322`), and offers an idempotent wiring helper (`withTailConsumer`, `:331-340`). This is the pattern to mirror for the (much smaller) `logpush` flag.
- **The validator does NOT know `logpush`**: `WranglerConfig` (`:65-83`) lists `compatibility_date`, `containers`, `d1_databases`, `durable_objects`, `migrations`, `observability`, `r2_buckets`, `tail_consumers`, `vectorize`, `workflows` — no `logpush`, no `placement`, no `assets`. The validator is allowlist-by-omission (it only checks keys it knows), so an unknown `logpush` is silently ignored rather than validated. A typo like `"logPush": true` would be silently dropped by wrangler with no warning from Lunora.
- **Runtime sinks are unrelated**: `packages/runtime/src/observability-sinks.ts` (`webhookSink`, `sentrySink`, `analyticsEngineSink`, etc.) ship telemetry from _inside_ the worker via `ctx`/tail. Logpush is Cloudflare-side log shipping — different layer; do not conflate.

What's missing: `logpush` is not a typed/validated key, and there's no docs note connecting the flag to the Studio panel and to retention/SIEM use cases.

## Item breakdown

- [x] **Item 1: Recognize `logpush` as a known boolean key in the validator.**
    - In `packages/config/src/wrangler-validator.ts`, add `logpush?: boolean;` to the `WranglerConfig` interface (`:65-83`, alphabetical with the other keys).
    - Add a tiny `validateLogpush(wrangler, errors)` (mirror the shape of `validateTailConsumers`): if `wrangler.logpush !== undefined && typeof wrangler.logpush !== "boolean"`, push `'logpush must be a boolean (set "logpush": true to enable Cloudflare Logpush)'`. Call it from `validateWranglerConfig` next to the other `validate*` calls (`:395-398`).
    - Optional, only if low-friction: a `warnings.push` nudge when `logpush: true` is set but neither `tail_consumers` nor `observability.enabled` is present, hinting that a Logpush _job_ must still be created in the dashboard. Keep it a warning, never an error — Logpush jobs are out-of-band.
    - Tests in `packages/config/__tests__/` (mirror the existing `tail_consumers` validator tests): `logpush: true` → valid; `logpush: "true"` (string) → one error; absent → no error. Plain-Node Vitest; no workerd.

- [x] **Item 2 (docs only): tie the flag to the Studio logs story.**
    - Short docs note (where observability/logs are documented): `"logpush": true` enables Cloudflare Logpush; the actual sink (R2 / HTTP / Splunk / Datadog / S3) is a **Logpush job** created in the CF dashboard or via API — Lunora does not manage jobs. Point at the Studio Logs → Log Drains panel (`log-drains-panel.tsx`) which already shows the snippet and deep-links to the dashboard.
    - State the boundary explicitly: Lunora validates the flag; job lifecycle stays in Cloudflare.

## Verification

- `pnpm --filter "@lunora/config" run build`
- `pnpm --filter "@lunora/config" run test`
- `pnpm --filter "@lunora/config" run lint:types`
- `pnpm --filter "@lunora/config" run lint:eslint`
- Item 2: n/a — docs only.

## STOP conditions

- If you start building Logpush-_job_ CRUD (create/list/delete jobs via the CF API) inside Lunora, STOP — job lifecycle is dashboard/API territory and explicitly out of scope.
- If the `logpush` check grows beyond a boolean type-guard (+ at most one warning), STOP and reconsider — this is a config-flag plan, not a feature.
- If `log-drains-panel.tsx` no longer renders the `logpush` card (drift), STOP and re-scope against the current Studio logs UI.
