# Plan 466 — Wire `@lunora/replica` into every client: a persisted, reactive local SQLite read path

**Baseline:** `d8a41fe8d` (origin/alpha, 2026-10-10)
**Status:** PLANNED (no code written). Phase 0 needs decisions from the maintainer before Phase 1 starts.

## 0. Headline finding

`@lunora/replica` is a working local SQLite mirror, but nothing in the client path uses it. Three
facts shape the plan:

1. **The bridge already exists, but only as a helper.** `subscribeToMirror`
   (`packages/replica/src/subscribe-mirror.ts:79`) takes any `client.subscribe` and writes each full
   result frame into a per-function table (`fn_<ref>`), diffing against the last frame. `useLocalQuery`
   (`packages/replica/src/react.ts`) reads those tables reactively through `useSyncExternalStore`.
   Both are `@experimental`, and nothing in `@lunora/client`, `@lunora/react`, or any other framework
   client calls them.
2. **The client already persists query results.** `QueryCacheAdapter` and `CachedQuery`
   (`packages/client/src/types.ts:296` and `:366`) cache each query's last value for offline reads,
   with `persistenceVersion` gating (`types.ts:518`). The replica must not duplicate that. Its real
   addition is **SQL over cached results**: joins, filters, and aggregates, reactive, offline.
3. **Nothing persists the replica yet.** Every adapter (`sqlite-wasm`, `sqljs`, `better-sqlite3`)
   wraps a database the caller already opened, and no storage backend is involved. A "local
   replica" that empties on reload is not useful offline. Browser durability (OPFS, or sql.js with an
   IndexedDB snapshot) and React Native durability are new work.

## 1. Constraints the plan has to respect

- **Tier mismatch.** `ROADMAP.md` (around line 58) lists `replica` and `react-native` as
  **Experimental**, outside the 1.0 promise, while `client`, `react`, `vue`, and `solid` are Stable.
  A stable package that imports an experimental one breaks the tier contract, and
  `check-roadmap-tiers` will not catch it because it only checks the ROADMAP table against the
  snapshot lists. Phase 0 must choose between (a) optional peer plus dynamic import in the client, so
  the replica stays experimental and is opt-in, or (b) graduating `replica` through plan 463's bar
  first. Recommendation: (a) for 1.0; graduation later.
- **Bundle cost.** sql.js and sqlite-wasm are multi-megabyte WebAssembly payloads. The client bundle
  must not grow for apps that do not opt in. Use a dynamic `import()` behind an explicit option, and
  add a size assertion (see §6).
- **Identity partitioning.** A mirror holds one user's data. Cookie sessions have no client identity
  (the `identity` gate compares `null === null`), so the replica must be keyed by the identity the
  client advertises, and cleared on sign-out or user switch. Reuse the fingerprint that
  `CachedQuery` already carries (`types.ts:300-305`).
- **Platform parity.** The per-target mapping must be stated in the same change, per the repo's
  platform-parity rule: browser (OPFS or IndexedDB snapshot), Node (better-sqlite3 file), React
  Native (sql.js with a file path, or a native SQLite module), and Workers (not a client target;
  unsupported and say so).

## 2. Phase 0 — decisions (maintainer)

| #   | Question                                                                                                                         | Recommendation                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Tier: optional peer plus dynamic import, or graduate `replica` first?                                                            | Optional peer. Graduation is a later plan.                                                                                                                                        |
| D2  | Relationship to `@lunora/db` (TanStack DB collections, in-memory): keep them separate, or back the collections with the replica? | Keep separate in v1. `@lunora/db` stays the reactive collection layer and the replica is an opt-in read store. Revisit after measurement.                                         |
| D3  | Do replica reads include unconfirmed optimistic writes?                                                                          | v1: confirmed server state only. Writes appear after the frame that confirms them. Document the lag. Folding optimistic layers into SQL rows is a separate, larger plan.          |
| D4  | Multi-tab: one writer (cross-tab leader) or one replica per tab?                                                                 | One writer, the leader tab, using `cross-tab.ts`. Other tabs read the same OPFS file. If OPFS locking makes that impractical, fall back to a per-tab in-memory mirror and say so. |
| D5  | Sync granularity: full frames (current `subscribeToMirror`) or delta frames with cursors (protocol §5.4)?                        | v1: full frames, which are already correct. Delta-based catch-up is Phase 5 and only if measurement shows full-frame diffing is too slow.                                         |
| D6  | Which framework clients are in scope for v1?                                                                                     | All of them, per the request, but react first. Order below.                                                                                                                       |

## 3. Phases

**Phase 1 — durable storage adapters (`@lunora/replica`).**

- Browser: a sqlite-wasm adapter using the OPFS VFS, with a fallback to sql.js plus an IndexedDB
  snapshot when OPFS is unavailable. Node: better-sqlite3 on a file path.
- React Native: sql.js on a file path, or a documented native module if sql.js is too slow.
- A storage contract: `open(identity)`, `close()`, `destroy()`. `destroy()` is what sign-out calls.
- Schema-version reconciliation already exists (`local-mirror.ts:424`, `#reconcileSchemaVersion`).
  Extend it so a persisted file from an older app version is dropped, not read.
- Exit criterion: a unit test writes rows, closes, reopens the same file, and reads them back. Test
  under the real OPFS path with a browser runner, not only the in-memory fake.

**Phase 2 — client integration (`@lunora/client`).**

- New option on `LunoraClientOptions` (`types.ts:387`): `localReplica?: { storage, tables?, identity? }`.
  When absent, nothing is imported and behaviour is unchanged.
- When present, the client loads the replica lazily, and `subscribe` accepts `{ mirror: true }` so
  each opted-in query runs through `subscribeToMirror`. Hydrate the replica on startup before the
  first network frame, so offline reads work from a cold start.
- `client.localQuery(sql, params)` returns rows synchronously once hydrated, and `subscribeLocal`
  notifies on mirror version changes.
- Identity: on identity change, `destroy()` the old mirror and open the new one. Gate reads on the
  identity the client currently advertises, so a user never sees another user's rows.
- Cross-tab: route the leader-only writer through `cross-tab.ts`; other tabs read.
- Tests: `packages/client/__tests__/local-replica.test.ts`, covering option absent (no import, no
  behaviour change), hydrate-before-network, identity switch clears data, leader write and follower
  read, and schema-version drop.

**Phase 3 — React (`@lunora/react`).**

- Re-export `useLocalQuery` from `@lunora/replica` through `@lunora/react`, so the dependency stays
  behind the optional peer.
- Add a `source` option to `useQuery`: `"network"` (default, unchanged), `"local"`, or
  `"local-then-network"`. The default must not change.
- Tests: `packages/react/__tests__/`, using the existing `react.test.ts` in replica as a model. Cover
  SSR (no replica on the server, graceful fallback), concurrent rendering, and strict-mode double
  mount.
- Gates: `api-snapshots/react.api.md` and the re-export list in `packages/react/src/index.ts`.

**Phase 4 — remaining framework clients.** Thin adapters, same option and `source` semantics:

- `@lunora/vue` (`useQuery`, `useSubscription`), `@lunora/solid` (`useLunora`), `@lunora/svelte`
  (`useQuery`, `usePreloadedQuery`).
- `@lunora/angular` and `@lunora/nuxt` (experimental; wrap the client option only, no new hooks).
- `@lunora/react-native`: re-exports `@lunora/react`, so it inherits Phase 3. Add the RN storage
  adapter from Phase 1 and its factory option.
- `@lunora/db`: out of scope for v1 (D2).
- Each framework gets one parity test that renders the same query under all three `source` modes.

**Phase 5 — measurement and optional delta sync.**

- Benchmark full-frame diffing on a 10k-row query (CodSpeed, `packages/replica/__bench__`). Only if
  the cost is too high, plan the delta path against protocol §5.4 (the `delta` frame and its cursor).
  Changing the delta path is a protocol-touching change, so it needs the `protocol/` fixtures and
  every SDK in the same change.

## 4. Testing — the part that must be good

Testing is a first-class deliverable, not a final phase. Every phase lands its own tests.

**Unit (vitest).**

- Replica storage contract: open, write, close, reopen, read, destroy. Run for every adapter
  (in-memory fake, better-sqlite3, sql.js, and sqlite-wasm with OPFS in a browser runner).
- `subscribeToMirror` edge cases already documented in its header: identical frames produce no
  writes, a `clearData()` mid-frame, and bigint primary keys. Extend, do not replace.
- Identity partitioning: two identities over one origin never see each other's rows.

**Integration (vitest, `packages/client`).**

- Offline cold start: a client with a populated replica file and no network serves `localQuery`.
- Hydrate-before-network ordering, asserted with a controlled fetch, not with timing.
- Identity switch and sign-out both clear the mirror.
- Schema-version mismatch drops the persisted file.

**Framework (vitest per package).**

- Each `source` mode for each framework, including SSR and strict-mode double mount for React.

**End-to-end (Playwright, `tests/e2e`).** Use a real example app (`examples/offline-rejections` or a
new `examples/local-replica`) against a running dev server. Required scenarios:

1. Online load, then `context.setOffline(true)`, then reload. Data still renders from the replica.
2. Offline write, reload while still offline: the write survives, and the local query shows the
   confirmed state only (D3). Reconnect: the write confirms, and the local query updates without a
   manual refresh.
3. Two tabs: the leader writes, the follower's `localQuery` updates. Close the leader: a follower
   takes over (D4).
4. Sign out, then sign in as another user in the same browser: the first user's rows are gone from
   OPFS and the second user's rows are present.
5. Schema bump in the app: the persisted file is dropped on the next load.

**Verify the tests catch what they claim.** For each e2e scenario and each identity test, break the
implementation on purpose (skip `destroy()` on sign-out, skip the leader check, skip the
schema-version check) and confirm the test fails for the right reason before trusting a green run.

**Workerd.** Not needed for the client changes. Run `pnpm run test:workerd` anyway if any server or
shard code changes, per the repo's gotcha list.

**Gates to run locally before pushing.** `pnpm run build:packages` first, because `api:check` reads
`dist/`. Then `api:check` (and `api:update` only after a fresh build), `dist:check`,
`lint:package-json`, `lint:eslint`, `lint:types`, `lint:prettier`, and the affected test set, using
`--no-cache` because the vis cache hides repo-walking tests.

## 5. Platform parity statement (required in the implementing PR)

| Target                  | Storage                     | Status                                                        |
| ----------------------- | --------------------------- | ------------------------------------------------------------- |
| Browser, OPFS available | sqlite-wasm + OPFS          | native                                                        |
| Browser, no OPFS        | sql.js + IndexedDB snapshot | emulated (slower writes, full snapshot per flush)             |
| React Native            | sql.js on a file path       | emulated, pending a device test                               |
| Node client             | better-sqlite3 file         | native                                                        |
| Workers (server)        | not a client target         | unsupported; the client option is rejected with a clear error |

## 6. Size and performance budgets

- The client bundle size with `localReplica` absent must not change beyond noise. Assert it in CI.
- Hydrating 10k rows and first `localQuery` should be measured and recorded in the PR. The target is
  set in Phase 0, not guessed here.

## 7. Risks

- **OPFS locking across tabs.** Mitigated by D4's single-writer design and the in-memory fallback.
- **Stale optimistic reads.** Accepted under D3 and documented; a user-visible write lag is a product
  decision, not a bug.
- **Schema drift.** A reconciled file is dropped, which costs a refetch. Acceptable for v1.
- **Experimental leakage.** If D1 is not honoured, the stable tier promise breaks. The API snapshot
  gate for the client must show no new unconditional export from `replica`.

## 8. Exit criteria

- Phase 2 e2e scenarios 1–5 pass in CI, and each has been shown to fail when its feature is broken.
- The client bundle with the option absent is unchanged within noise.
- Every framework client exposes the same `source` semantics, with a parity test.
- The replica's experimental status is unchanged or deliberately graduated, per D1.
