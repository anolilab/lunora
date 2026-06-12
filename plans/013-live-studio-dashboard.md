# Plan 013: Make the studio a fully live dashboard (no Live toggles, no reload buttons)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If a "STOP condition" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 16bcb076..HEAD -- packages/studio/src`
> If any in-scope panel file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (touches ~20 panels + shared toggle infra + studio tests)
- **Depends on**: none (the live + polling primitives already exist)
- **Category**: dx / studio
- **Planned at**: commit `16bcb076`, 2026-06-12

## Why this matters

The studio should behave like the product it ships: a **reactive** backend whose
dashboard reflects every change in realtime, with no "Live: off" toggles to flip
and no Refresh/Reload buttons to hunt for. Today it doesn't — only the **Data
Browser** is live by default; six panels are live-_capable_ but gate it behind a
toggle that **defaults OFF**, and ~13 panels are one-shot fetches with manual
Refresh buttons.

### Prior art (why this design, not TanStack Query)

- **Convex dashboard** dogfoods Convex's own reactivity: its data browser uses
  the same `useQuery` subscription an app does — the server re-runs the query and
  **pushes a full snapshot** over WebSocket on every change. Live everywhere, no
  refresh buttons. ([realtime](https://www.convex.dev/realtime),
  [data browser](https://docs.convex.dev/dashboard/deployments/data))
- **Supabase Studio** is built on **React/TanStack Query** (fetch + cache +
  invalidate). Supabase Realtime emits *row-level deltas* (Postgres WAL), not
  snapshots, so React Query exists to hold state and Realtime only nudges a
  `refetch`/`invalidateQueries`. The table editor is fetch-and-refetch.
  ([architecture](https://supabase.com/docs/guides/realtime/architecture))

**Cirrus is the Convex model**: `client.subscribe` (wrapped by the studio's
`useLiveAdmin`) already pushes full snapshots. So adding TanStack Query would be
a step _backward_ — it's machinery to work around delta-only realtime Cirrus
doesn't have. **Decision: dogfood Cirrus subscriptions; do NOT adopt TanStack
Query for the studio.** This closes the dangling PLAN3 Tier-4 "TanStack decision".

## Architecture: two honest "live" mechanisms (both already exist)

1. **`useLiveAdmin`** (`packages/studio/src/use-live-admin.ts`) — opens a
   `client.subscribe()` to a reserved `__cirrus_admin__:*` op. The ShardDO
   re-runs the query and pushes a fresh snapshot on every write-flush touching a
   table the query reads. Use for **ShardDO-backed, write-driven** data.
2. **`useAutoRefresh`** (`packages/studio/src/use-auto-refresh.ts`) — fixed
   interval (default 5000 ms, skips while tab hidden). Use for **HTTP-only**
   backends with no client-observable write event: global D1, R2 storage, the
   auth SessionDO, and live WS-connection snapshots (connect/disconnect is not a
   write-flush, so it can't push).

Both already hold their callbacks in refs and tear down on unmount — no changes
to the primitives are needed.

## Per-panel decision matrix

Classification verified against the live source at `16bcb076`.

### Group A — Always-live (subscribe on mount; remove toggle **and** Refresh button)

These read append-log / time-series ShardDO ops that re-run on write-flush.

| Panel | File | Admin op(s) | Remove |
| --- | --- | --- | --- |
| Metrics | `metrics-panel.tsx` | `getMetrics` | `LiveToggle prefix="mt"`, `mt-refresh` |
| Function stats | `function-stats.tsx` | `getFunctionStats` | `LiveToggle prefix="fs"`, `fs-refresh` |
| Audit | `audit-panel.tsx` | `getAuditLog` | `LiveToggle`, `au-refresh` |
| Logs | `logs-panel.tsx` | `getLogs`, `getRequestLog` | both `LiveToggle`s, `lg-refresh` |
| Migrations | `migrations.tsx` | `migrationStatus` | `LiveToggle`, `mg-refresh` |
| Health | `health-panel.tsx` | `getMetrics`/`getFunctionStats`/`getLogs`/`getAuthMetrics`/`migrationStatus` | `LiveToggle`, `hl-refresh` |

**How:** drop the `useLiveToggle()` call; pass `enabled = true` (the default) to
every `useLiveAdmin` call; keep the existing one-shot load as the **initial seed**
on mount/shard-change (it's the source of truth before the first push); delete the
`LiveToggle` render and the Refresh `<Button>`. Health aggregates several ops —
subscribe each live op; the cross-shard aggregate stays a one-shot on shard
selection (it fans out, can't subscribe) but loses its button.

### Group B — Always-poll (remove button; `useAutoRefresh`, no toggle)

HTTP-only backends, or a snapshot whose change event isn't a write-flush.

| Panel | File | Source | Remove / change |
| --- | --- | --- | --- |
| Global data browser | `global-data-browser.tsx` | D1 (HTTP) | poll list+page; no button today |
| Files | `file-browser.tsx` / `use-file-browser.ts` | R2 (HTTP) | poll the current listing |
| Users | `users-panel.tsx` | auth SessionDO (HTTP) | make poll always-on; remove `us-refresh` + the `us-auto` toggle |
| Organizations | `organizations-panel.tsx` | auth SessionDO (HTTP) | poll the member/invite lists |
| Subscriptions | `subscriptions-panel.tsx` | WS snapshot | poll; remove `subs-refresh` |

**How:** add `useAutoRefresh(reload, true)` driving the panel's existing
`reload()/refresh()`; delete the manual button(s) and any auto-toggle. Pagination
controls stay (they're navigation, not refresh). Polling pauses when the tab is
hidden (built into the hook).

### Group C — Load-on-mount, remove button (effectively static at runtime)

These change only on **redeploy / codegen / migration**, not on row writes, so a
WS subscription would never push and polling them is mostly wasted work. Honor
"no reload buttons" by removing the button; keep the mount load. (A migration —
the one runtime mutation — already surfaces live in the Migrations panel.)

| Panel | File | Admin op | Remove |
| --- | --- | --- | --- |
| Settings | `settings-panel.tsx` | `getSettings` | `set-refresh` |
| Security advisor | `security-advisor-panel.tsx` | `getSecurityAudit` | refresh via `AdvisorView` |
| RLS | `rls-panel.tsx` | `rlsPolicies` | `rls-refresh` |
| Schema viewer | `schema-viewer.tsx` | `listTables`/`listTableIndexes` | `sc-refresh` |
| Insights | `insights-panel.tsx` | `getAdvisories` + stats/metrics/traffic | refresh via `AdvisorView` |

> **Open sub-decision (resolve during 3.C):** Insights mixes static advisories
> with live `getMetrics`/`getFunctionStats`. Option (a) leave one-shot + drop the
> button (cheapest); option (b) subscribe just the metrics/stats inputs so the
> perf advisories recompute live. Default to (a); revisit if the perf view feels
> stale. The cross-shard `shardTraffic` feed is HTTP and would need polling either
> way — leave it on the mount load.

### Group D — No change (already correct)

- **Data browser** (`use-data-browser.tsx`) — already always-live.
- **Home** (`home-panel.tsx`) — one-shot digest on mount, no toggle/button. Leave.
- **SQL editor** / **Dashboards** — execute-on-demand by nature (a query runs when
  you run it / when a widget's SQL changes). No refresh button to remove.
- **PITR** (`pitr-panel.tsx`) — a manual preview→confirm restore op; the bookmark
  read is on-demand. Remove `pitr-refresh` (it's a reload of an on-demand read) but
  keep the time-input-driven lookup. _Low priority; fold into Group C._

## Shared infra to delete once unused

- `packages/studio/src/live-toggle.tsx` (the `LiveToggle` component)
- `packages/studio/src/use-live-toggle.ts` (the `useLiveToggle` hook)
- Their exports in `packages/studio/src/index.ts`
- Any now-unused i18n strings in the locale catalog (`Live: on/off`, `Refresh`,
  `Reload users`, `Auto`) — only if no other panel references them.

Do NOT delete `use-live-admin.ts` or `use-auto-refresh.ts` — both are now used
more, not less.

## Steps (each ≈ one commit; verify before moving on)

1. **Group A — always-live (6 panels).** Remove `useLiveToggle`, force
   `useLiveAdmin` enabled, delete each `LiveToggle` render + Refresh button. Keep
   the mount seed load.
   - **Verify:** `pnpm --filter @cirrus/studio run lint:types` clean; the 6 panels
     render without a toggle; mutating data in a second client updates them with no
     interaction (mock-client test or manual).
2. **Group B — always-poll (5 panels).** Wire `useAutoRefresh(reload, true)`;
   delete manual buttons + the users `us-auto` toggle.
   - **Verify:** lint:types clean; with fake timers, a panel re-queries on the
     interval; tab-hidden pauses it.
3. **Group C — load-on-mount, drop button (5 panels).** Remove the Refresh
   buttons (and `AdvisorView`'s refresh affordance for the two advisor panels).
   - **Verify:** lint:types clean; panels still load on mount.
4. **Delete shared toggle infra.** Remove `live-toggle.tsx`, `use-live-toggle.ts`,
   their `index.ts` exports, and dead i18n strings.
   - **Verify:** `grep -rn "useLiveToggle\|LiveToggle\|use-live-toggle\|live-toggle" packages/studio/src` returns nothing.
5. **Update studio tests.** Remove/replace assertions keyed on the deleted
   `*-refresh` / `*-live` / `us-auto` test-ids; add a "no Refresh button" guard and
   a "live push updates the panel" assertion for a representative Group A panel and
   a "polls on interval" assertion for a Group B panel.
   - **Verify:** `pnpm --filter @cirrus/studio run test` green.
6. **Full gate.** `pnpm --filter @cirrus/studio run lint:types && lint:eslint && test`.
   Rebuild `@cirrus/client` first only if a client method signature changed (it
   shouldn't here).

## STOP conditions

- A Group-A op turns out **not** to be re-run on write-flush (no live push in a
  mutation test) — report; that panel may need polling instead.
- Removing a test-id breaks an E2E/Playwright spec outside `packages/studio`
  (`grep -rn "<testid>" e2e tests apps`) — surface before deleting.
- Deleting an i18n key that another package references — keep it, note it.

## Acceptance (done-when)

- No `LiveToggle` / `useLiveToggle` anywhere in the studio; `live-toggle.tsx` and
  `use-live-toggle.ts` deleted.
- No manual Refresh/Reload/Auto button on any panel except genuine
  execute-on-demand actions (SQL Run, PITR restore-confirm).
- Group A panels update via subscription with zero interaction; Group B panels
  update on a hidden-tab-aware interval; Group C panels load on mount.
- `pnpm --filter @cirrus/studio run lint:types && lint:eslint && test` all green.
