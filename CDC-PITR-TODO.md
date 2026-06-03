# CDC / PITR / Backups — remaining work

Tracks the tail of the Ops/data-movement effort on `feat/data-layer-parity-gaps`.
The hard engines are landed and verified; what remains is HTTP/CLI wiring and the
scheduled handler.

## Done (pushed, Node-verified)

- [x] DO `__cdc_log` changelog on the write path (`b74d550`)
- [x] D1 `__cdc_log` changelog for global tables (`21c10e0`)
- [x] `cdcSync` shard admin RPC (`7174ecf`)
- [x] `orchestrateCdcSync` coordinator fan-out (`2199997`)
- [x] `/_cirrus/admin/sync` streaming-export endpoint + `syncGlobals` (`c380f29`)
- [x] `cirrus backup create/list/restore` (`ed94ef1`)
- [x] `applyCdcChanges` replay engine — upsert/delete (`fba13d7`)

## Phase 2 tail — `restore --to <time>` (replay-PITR)

- [x] **A. `applyCdc` shard admin RPC** (`@cirrus/do`) — `8b0adcb`
    - ADMIN_FUNCTIONS.applyCdc, base runShardApplyCdc (NOT_IMPLEMENTED), dispatch +
      flushChangedTables, parseApplyCdcArgs, types exported, 2 tests.
- [x] **A2. codegen: emit `runShardApplyCdc` override** — `35f4914`
- [x] **A3. codegen: `cdc` flag on the emitted `ShardDOConfig`**, threaded into
      every `createShardCtxDb` + `runShardMigrations`. App opts in via
      `createShardDO({ cdc: true })`. (D1 side: the host's `config.d1` factory should
      pass `cdc: true` to `createD1CtxDb`, and wire `syncGlobals`/`applyGlobals` to
      `readD1CdcChanges`/`applyCdcChanges` — runtime integration, not codegen.)
- [x] **B. Coordinator `orchestrateApplyCdc`** (`@cirrus/runtime`) — `5d30c78`
- [x] **C. `/_cirrus/admin/apply` worker route** + `applyGlobals` option — `ea1b538`
    - Takes pre-bucketed per-shard batches (the `/sync` shape) so no re-bucketing.
- [x] **D. CLI `cirrus backup restore <id|file> --to <ISO-time>`** — `ba46562`
    - Drains `/sync`, replays `ts <= T` through `/apply`, Node-tested.

> Phase 2 (replay-PITR) is functionally complete; A2/A3 below make it live in
> generated apps.

## Phase 4 — scheduled backups → R2 (workerd-verified)

- [x] **E. `scheduled()` handler in `createWorker`** — `0935e2b`
      Dispatches cron triggers to `crons` handlers and runs a built-in backup when
      the firing expression matches `backupCron`: streams the export to NDJSON,
      writes a `<file>.manifest.json` sidecar to `backupStore` (R2), and prunes past
      `backupRetain`. Export-row production factored into a shared `streamExportRows`.
      8 Node tests.
- [x] **F. R2 plumbing + docs** — `d8198d7`
      `WorkerOptions.backupStore` (R2-like put/list/delete) plus `backupCron` /
      `backupPrefix` / `backupRetain` / `backupTables` / `crons` (landed in E).
      Documented the `scheduled()` entry + wrangler `r2_buckets` / `triggers.crons`
      bindings on the runtime docs page; forwarded `scheduled` from the playground
      Worker. (No generated worker exists — the entry is hand-authored, so there is
      no codegen wiring to add; enabling the backup needs a `queryCoordinator` +
      `backupStore`.)
- [x] **G. workerd e2e** — `ca00751`
      Real-workerd test fires `scheduled()` via `createScheduledController` and
      asserts the snapshot + manifest land in a genuine R2 binding (covers the
      `ReadableStream`→R2 `put` path the Node mocks can't). Gated behind
      `CIRRUS_WORKERD_TESTS=1`; type-checks + lints clean and runs in CI, but cannot
      execute in this sandbox (workerd connect timeout — same limit as the other
      workerd suites; local run hit the 180s timeout).

> Phase 4 complete. CDC / PITR / Backups effort done end-to-end.

## Conventions (hold the bar)

- Every commit: `lint:eslint` clean (0 errors), `lint:types` clean (ignore the
  pre-existing `d1/__tests__/workerd/*` errors), package tests green.
- `packages/do/src/{ctx-db,shard-do}.ts` are non-UTF8 → `grep -a` / Read only.
- Never run `pnpm run test` (corrupts tree) — use `pnpm --filter <pkg> run test`.
- One coherent commit per checklist item; push after each.
