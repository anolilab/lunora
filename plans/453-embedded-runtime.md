# Plan 453 — Ship the in-process runtime as an embedded (browser / device) target

**Baseline:** `f2541e3b0` (2026-08-29)
**Status:** TODO (design ratified before implementation — the dependency and the package boundary are the decisions, not the code)

## 0. Headline finding

**The embedded runtime already exists; it is Node-only and shipped as a test
helper.** `lunoraTest(schema)` runs real `query`/`mutation`/`action` functions —
the same `createShardCtxDb` + `runShardMigrations` the Durable Object uses —
against an in-memory SQLite, with no DO, no wrangler, and no network.

The seam that makes it portable is **63 lines**:
`packages/testing/src/node-sqlite.ts` adapts `node:sqlite` to
`SqlExec` (`{ exec(sql, ...params): SqlCursor }`, `packages/shard-engine/src/ctx-db.ts:148`).
Everything above that interface — the whole query engine, index handling, OCC,
companions — is engine-agnostic already.

So "add an embedded runtime" is really **a second `SqlExec` adapter plus a place
to ship it**. The engineering risk is not the runtime; it is the wasm SQLite
dependency, the persistence story, and which `ctx.*` surfaces are honestly
supported off-platform.

## 1. Current state (audit)

- `packages/testing/src/harness.ts` wires schema → migrations → function
  execution against one shared in-memory database (`lunoraTest`).
- `packages/testing/src/node-sqlite.ts` is the only engine adapter, and is
  explicitly documented as "the deliberate in-memory engine for this Node-only
  harness".
- `SqlExec.exec` is **synchronous**, mirroring workerd's `SqlStorage`. This is the
  single hardest constraint on engine choice (§4).
- The client already has the _other_ half of a local-first story — offline
  mutation queue, IndexedDB persistence, optimistic layers, React Native
  async-storage — but always against a remote server of record.
- No wasm SQLite dependency, no `browser` export condition on any package, no
  prior plan. This is greenfield.

## 2. Existing seams (do not reinvent)

| Seam                                     | Where                            | Reuse as-is                                       |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------- |
| `SqlExec` / `SqlCursor`                  | `shard-engine/src/ctx-db.ts:148` | The engine boundary. Do not widen it.             |
| `createShardCtxDb`, `runShardMigrations` | `@lunora/do`                     | The execution pipeline. Unchanged.                |
| `lunoraTest` harness wiring              | `testing/src/harness.ts`         | Extract, do not fork.                             |
| `node-sqlite.ts`                         | `testing/src/`                   | The reference implementation of a second adapter. |

## 3. The behavioural contract to preserve

- A function that runs embedded must behave as it does in a DO, or fail loudly.
  Silent divergence (a missing index, different collation, absent `json_extract`)
  is worse than an unsupported error — this is why the Node adapter deliberately
  uses a **real SQLite build** rather than a JS emulation.
- `SqlExec` stays synchronous. Anything that forces it async is a redesign of the
  whole store core, not a runtime addition.

## 4. Design decisions

**D1 — Engine.** `@sqlite.org/sqlite-wasm` (official build). Its OO1 API is
synchronous **after** an async module init, which is exactly the shape `SqlExec`
needs: `await` the load once at runtime construction, then hand out a sync exec.
`sql.js` is also sync but unmaintained relative to the official build; `wa-sqlite`
is more flexible and more moving parts. **Open:** bundle size, and whether the
wasm binary ships in-package or is fetched.

**D2 — Persistence.** In-memory first. OPFS (via the same package's
`opfs-sahpool` VFS) is a follow-on: it requires a Web Worker and
cross-origin-isolation headers, which is a deployment constraint on the consuming
app, not a library detail. **Ship in-memory, document the constraint, then add
OPFS behind a flag.**

**D3 — Package boundary.** A new `@lunora/embedded`, not an export from
`@lunora/testing`. Nobody should add a package named "testing" to run a
production local-first backend, and the wasm dependency should not land in every
project's test graph. Cost: the 56th package (release config, api-snapshot, docs).

**D4 — What is honestly supported.** The embedded target has no Durable Object,
no D1, no R2, no Vectorize, no Workflows. Scope v1 to `ctx.db` + `ctx.auth`
(caller-supplied identity) and make everything else a `platform_unsupported_feature`
diagnostic (§6). **A half-supported `ctx.storage` is the failure mode to avoid.**

**D5 — Reactivity.** Out of scope for v1. Live queries are the DO's broadcast
path; an embedded store would need its own subscription loop. Reads and writes
first; `useQuery` against an embedded store is a follow-on plan.

## 5. Workstreams

1. **Extract the engine seam.** Give the harness an `engine` parameter; move the
   schema→migrations→execute wiring somewhere both `@lunora/testing` and
   `@lunora/embedded` consume. No behaviour change; the Node suite is the gate.
2. **wasm adapter.** `SqlExec` over sqlite-wasm. Gate: the _existing_ harness
   suite passes against it unchanged — that is the parity proof.
3. **`@lunora/embedded` package.** `createEmbeddedLunora(schema)` →
   `{ query, mutation, action, run }`, browser export condition, size budget.
4. **Capability matrix + codegen diagnostics** (§6).
5. **Docs + a browser example.** The payoff that justifies the work: a docs page
   whose example runs in the reader's browser with no backend.

## 6. Platform parity

| Feature         | `cloudflare` | `node`   | `embedded`  | Notes                                                                      |
| --------------- | ------------ | -------- | ----------- | -------------------------------------------------------------------------- |
| `ctx.db`        | native       | native   | native      | Same store core over a wasm SQLite `SqlExec`.                              |
| `ctx.auth`      | native       | native   | emulated    | No JWT verification edge; identity is supplied by the host app.            |
| `ctx.storage`   | native       | emulated | unsupported | No R2/filesystem. Would need an OPFS blob store — separate plan.           |
| `ctx.vectors`   | native       | emulated | unsupported | No Vectorize; a brute-force local store is possible but not v1.            |
| `ctx.scheduler` | native       | emulated | unsupported | No alarms off-platform; a timer-based emulation is a lie about durability. |
| Live queries    | native       | native   | unsupported | See D5 — needs its own subscription loop.                                  |

Every `unsupported` row must land in `PlatformCapabilities` in the same change,
so codegen omits the surface and emits `platform_unsupported_feature` rather than
shipping a `ctx.*` that silently does nothing.

## 7. Phasing & ordering

| Phase | Work                                   | Gate                                                              |
| ----- | -------------------------------------- | ----------------------------------------------------------------- |
| 1     | Extract the engine seam                | `@lunora/testing` suite green, unchanged behaviour                |
| 2     | wasm `SqlExec` adapter                 | The same suite passes on the wasm engine — parity, not new tests  |
| 3     | `@lunora/embedded` + capability matrix | `api:check`, size budget, codegen diagnostics for unsupported ctx |
| 4     | Browser example + docs                 | Example runs in-page with no backend                              |

## 8. Risks & STOP conditions

- **STOP if the wasm engine cannot satisfy a synchronous `SqlExec`** without a
  Web Worker + cross-origin isolation. That would push the constraint onto every
  consuming app, and the plan should be re-scoped to "embedded in a Worker" with
  an async client boundary, not abandoned quietly.
- **STOP if phase-2 parity fails on real SQLite behaviour** (collation,
  `json_extract`, expression indexes). The Node adapter's whole rationale is that
  the engine is real; a wasm build that diverges is not a second target, it is a
  second set of bugs.
- **Risk:** bundle size. A wasm SQLite is ~1 MB. Mitigate: measure in phase 2,
  before the package exists; if it cannot be lazy-loaded, that is a product
  decision, not an implementation detail.
- **Risk:** scope creep into reactivity. Mitigate: D5 is explicit, and live
  queries get their own plan.

## 9. Open questions (answer during execution)

1. Does the wasm binary ship inside the package, or is it fetched? Offline-first
   users cannot fetch it.
2. Is `@lunora/embedded` the right name, or is this `@lunora/local`?
3. React Native: Expo SQLite is a third adapter, not the wasm one. In scope for
   v1, or a follow-on once the seam is proven twice?
4. What does an embedded app do with `.shardBy()` tables — collapse every shard
   into the one local store, or refuse the schema?
