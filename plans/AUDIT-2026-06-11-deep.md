# Deep audit — every package: DX, performance, features, security

- **Date**: 2026-06-11 · **Commit**: `2f6a466f` · **Branch**: `alpha`
- **Scope**: all 27 `packages/*` (deep — 8 parallel category auditors + advisor vetting of every cited location). `apps/*` and `templates/*` only where they evidence a package finding.
- **Method**: every finding below was re-verified by opening the cited code. Roughly half of the raw subagent findings were rejected on vetting; they're listed at the bottom so the next audit doesn't re-litigate them.
- **Relation to prior run**: the 2026-06-11 standard-depth audit (plans 001–005, all MERGED) covered docs drift, template smoke, and the mutation→subscription test. Its rejected-findings list was honored; nothing here duplicates it.

---

## Vetted findings (by leverage)

| #   | Finding                                                                                                              | Category     | Impact  | Effort | Risk | Conf. | Evidence                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------ | ------- | ------ | ---- | ----- | ----------------------------------------------------------------------- |
| 1   | One throwing subscription aborts every other subscription's refresh on the shard                                      | bug          | HIGH    | M      | MED  | HIGH  | `packages/do/src/shard-do.ts:3221-3257` → **plan 006**                   |
| 2   | Schema errors from codegen lack file:line; fatal codegen failures never reach the Vite error overlay                  | dx           | HIGH    | M      | LOW  | HIGH  | `packages/codegen/src/discover-schema.ts:171`, `packages/vite/src/codegen-plugin.ts:85-91` → **plan 007** |
| 3   | Standard Schema args acceptance (PLAN5 §6.1) is half-shipped: `v.*` exports `~standard` but `query`/`mutation` args can't take zod/valibot/arktype | direction/dx | MED-HIGH | M     | LOW  | HIGH  | `packages/values/src/v.ts:278`, `packages/server/src/functions.ts:68` → **plan 008** |
| 4   | RLS is opt-in per procedure with no lint when a policy-covered table is read without `rls()`                          | security     | MED     | M      | LOW  | HIGH  | `packages/server/src/rls/middleware.ts:27-31` ("by design, PLAN2 §3.2"), `packages/advisor/src/index.ts:52` (precedent: `authApiCallWithoutHeaders`) → **plan 010** |
| 5   | Subscription refresh executes + serializes per socket — N identical subscriptions = N query runs per change (ReactiveCache is opt-in) | perf | MED-HIGH | M-L | MED | MED | `packages/do/src/shard-do.ts:3221-3287` (per-socket `subMemos`), `:1161-1162` (cache only if configured) — **investigate first**: profile a high-fanout fixture before designing cross-socket dedup |
| 6   | Per-row `JSON.stringify(prev) !== JSON.stringify(next)` diffing in the delta path; changed rows are stringified again for the frame | perf | LOW-MED | S | LOW | HIGH | `packages/do/src/shard-do.ts:407`, `:3320-3326` — cache per-row fingerprints in the memo |
| 7   | `ctx.authApi` header-less call = privilege bypass; mitigations are docs + a static advisor lint, no runtime guard      | security     | MED     | M      | LOW  | HIGH  | `packages/auth/src/middleware.ts:44-80` (documented sharp edge); guard option: proxy that throws on header-less calls unless explicitly opted out |
| 8   | Scheduler tests drive `alarm()` by direct method call; the `setAlarm` → `onAlarm` Workers contract is never exercised  | tests        | MED     | M      | LOW  | MED   | `packages/scheduler/__tests__/scheduler-do.test.ts` — add fake-clock `setAlarm` tracking + `fastForwardToAlarm()` |
| 9   | Auth integration tests use a no-op D1 fake: concurrent login, session revocation propagation, refresh-under-skew untested | tests     | MED     | M      | MED  | MED   | `packages/auth/__tests__/` (10 files, mostly adapter-shape) — wire an in-memory SQLite adapter |
| 10  | Six framework adapters hand-roll subscription/error/cleanup logic with visible drift (react=TanStack cache, vue=manual refs, …) | tech-debt | MED | L | MED | MED | `packages/{react,vue,svelte,solid}/src/*query*` — extract a framework-neutral `useQuerySubscription` core into `@cirrus/ssr` (aligns with PLAN5 §0.1) |
| 11  | Papercut pack: 8 confirmed S-effort fixes (details in plan)                                                            | bug/dx/sec   | LOW ea. | S      | LOW  | HIGH  | → **plan 009**                                                           |
| 12  | D1 rank count SQL uses chained `OR` branches that may defeat the partition index                                       | perf         | ?       | M      | MED  | LOW   | `packages/d1/src/d1-ctx-db.ts:2656` — **investigate**: run `EXPLAIN QUERY PLAN` before believing or fixing |
| 13  | Paginated-core attach/detach refcounting may double-detach on rapid arg changes                                        | bug          | ?       | M      | MED  | MED   | `packages/react/src/use-paginated-core.ts:268` + `cache.ts:104` — **investigate**: write a churn test first |
| 14  | README gaps: `@cirrus/vue` is a 16-line stub; `@cirrus/mcp` + `@cirrus/db` lack API reference sections                  | docs         | LOW     | S      | LOW  | HIGH  | `packages/vue/README.md`, `packages/mcp/README.md`, `packages/db/README.md` |
| 15  | `@cloudflare/vite-plugin` pinned at `1.40.1` with a stale comment referencing the 1.39.2/1.40.0 regression              | deps         | LOW     | S      | LOW  | MED   | `pnpm-workspace.yaml:88` + `:194` — retest latest, refresh or remove the pin note |

## Features the packages should have (direction — maintainer's call, not ranked against bugs)

Grounded in roadmap docs, TODO clusters, and surface asymmetries — all premises re-verified:

1. **Remote-binding dev (`CIRRUS_REMOTE=1`)** — PLAN5 Phase 5, confirmed unstarted (no `CIRRUS_REMOTE` / `__cirrus/d1` code anywhere). Proxy shims for D1/KV/R2 against the deployed worker so local dev hits real data; VOID-TEARDOWN names it the last local-dev gap vs void. Effort M-L (coarse). The single highest-value *user-facing* feature on the books.
2. **Standard Schema args** — Phase 6.1, half-shipped (see finding #3). Plan 008 closes it. Effort S-M.
3. **Cross-shard rank pagination** — `orchestrateRankPage` exists nowhere in the tree (grep: zero hits outside docs); single-shard `rankBefore` ships via the codegen subclass (`packages/do/src/shard-do.ts:1826-1832`), so the only missing piece is the runtime fan-out/merge coordinator (PLAN5 §7.1). Blocks multi-tenant pagination over `.shardBy()` tables. Effort M.
4. **Advisor runtime lints** — `packages/advisor/src/index.ts:55` says "runtime lints join as they land"; none have landed. The `__cirrus_metrics` time-series shipped (CONVEX-PARITY #17), so hot-shard, index-utilization, and mutation-span-breadth rules now have data to read. Effort M. (Plan 010's RLS-coverage lint is the cheapest first new lint and reuses the same plumbing.)
5. **Wire the 5 orphaned templates into `cirrus init -t`** — carried from the prior audit: astro/nuxt/react-router/solid-start/sveltekit ship as template dirs but `isTemplate` silently falls back to `vite`. Wire them in or delete them; the smoke matrix (plan 003) now tells you which ones actually build. Effort S-M.
6. **CLI `--format json`** — no command emits machine-readable output; CI consumers regex-scrape. Start with `verify`, `deploy`, `codegen` (they already produce structured results internally). Effort M.

## Security summary

No exploitable injection, auth bypass, or cross-tenant access was found. Verified clean: parameterized SQL throughout `@cirrus/d1` and `@cirrus/do`; constant-time admin-token comparison in runtime and ShardDO; internal functions gated by the `x-cirrus-system` header; `MAX_SUBSCRIPTIONS_PER_SOCKET=32` cap; CLI template-source allowlist + path-traversal guards; studio-host inline-script escaping; mail send/queue paths share header-injection validation; ratelimit fails closed by default. The real items are hardening, captured above as findings #4 and #7 and in the papercut pack (storage `allowedContentTypes: []` permit-all footgun; non-configurable 1h impersonation TTL).

## Investigate-first (don't plan a fix yet)

- **#5 cross-socket dedup** — profile first; plan 004's integration test pins current memo behavior.
- **#12 D1 rank query plan** — `EXPLAIN QUERY PLAN` on realistic data.
- **#13 paginated refcount** — reproduce with a rapid-arg-change test before touching `cache.ts`.
- **`@cirrus/values` coverage** — still: run `pnpm --filter "@cirrus/values" run test:coverage` and read the branch report before writing tests.

## Findings considered and rejected this run (do not re-audit)

- **Admin `createUser`/`updateUser` mass assignment** (`auth/src/admin.ts:393`): explicitly documented by-design — the whole plane is admin-token gated; `data` carrying `additionalFields` that can override `role` matches better-auth's own admin plugin.
- **Ratelimit `failOpen` brute-force risk**: defaults to fail-closed; opting into `failOpen: true` logs loudly. Operator choice, sound default.
- **Signed-URL timing side channel + parameter pollution** (`storage/src/signed-url.ts`): HMAC check uses constant-time `crypto.subtle.verify`; early rejection of malformed/expired input is not a meaningful oracle; extra query params don't affect what's served.
- **Mail queue silently swallows failures**: false — `mailer.queue()` throws when no queue binding (`create-mailer.ts:254-256`), and `consumeQueuedSend` shape-checks the untrusted boundary.
- **Cookie-flag enforcement on better-auth**: speculative; better-auth defaults are secure and Cirrus adds no insecure override path.
- **Studio admin endpoints unauthenticated**: unsubstantiated — token gating verified constant-time in runtime + ShardDO; studio-host escapes injected config.
- **`concurrentMap` cursor race** (`vectors/src/concurrent.ts`): no `await` between the cursor read and increment — atomic in single-threaded JS. (Same pattern in `shard-do.ts` `refreshSubscriptions` workers is equally safe.)
- **Object validator prototype pollution** (`values/src/v.ts:558`): the object validator copies only schema-declared keys, never attacker-controlled input keys; `record` (which does take input keys) already uses `Object.create(null)`.
- **`use-presence` post-unmount heartbeat race**: effect cleanup removes both the interval and the visibility listener; no escape path.
- **PERF micro-optimizations** (WS-origin parse per upgrade, `writeIfChanged` existsSync, vite module-graph walk, registry-key restringify, admin-outcome Set allocs, db sync double-stringify): all real code, all negligible at realistic scale; playbook excludes micro-opts.
- **"OpenAPI/OpenRPC emitters are orphaned"**: false — the CLI wires them via `--api-spec` (`packages/cli/src/util/api-spec.ts`) across codegen/prepare/verify/deploy.
- **"Studio redesign planned but unstarted"**: stale — the Supabase-style IA, Advisors, Home, and ⌘K shipped.
- **"Offline-queue ↔ reconnect never integration-tested"**: false — `client/__tests__/cirrus-client.test.ts:638` covers queue-while-offline → replay-on-reconnect. Residual gap is only multi-mutation FIFO depth; folded into the test backlog, not a headline finding.
- **`@visulima/*` alpha pins**: first-party ecosystem (same maintainer); upstream breakage risk is self-controlled.
- **postcss < 8.5.10 in the docs chain**: already on the prior run's rejected list (rides the next fumadocs/next bump).

## Not audited

- `apps/docs`, `apps/playground`, `apps/studio` beyond what package findings required.
- `packages/studio`'s 20k lines beyond the security pass and obvious perf smells (it has 49 test files and shipped its redesign; a dedicated UX/a11y audit would be a separate run).
- Runtime behavior under real Cloudflare deployment (all findings are static-analysis + test-reading).
