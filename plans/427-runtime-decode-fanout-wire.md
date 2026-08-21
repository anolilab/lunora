# Plan 427: Decode wire-tagged values before they reach warehouse connectors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/runtime/src/connector-format.ts packages/runtime/src/query-coordinator.ts packages/runtime/src/data-movement-admin-routes.ts shared/wire-codec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

Every shard admin RPC wraps its result in `encodeWire` (`packages/do/src/shard-do.ts:313`, `adminResponse`), so a `v.bigint()` column crosses the wire as `["$lunora.wire$","bigint","42"]` and `v.bytes()` as a base64 tag. The coordinator's fan-out (`callOneShard` in `packages/runtime/src/query-coordinator.ts`) does `await response.json()` and never decodes — and neither does anything downstream. The result: any table with a bigint/bytes column lands in **Fivetran and Airbyte connector output** as a three-element tag array instead of a value. Silent data corruption in third-party warehouses.

Critically, the internal round-trips are **correct by pairing**: `exportShard → importShard` and `cdcSync → applyCdc` hand the wire-form payload straight back to a shard, where `decodeAdminArgs` (`shard-do.ts:~324`) decodes it. That pairing is documented at `shard-do.ts:315-322` and must not be broken. So the fix is NOT "decode at `callOneShard`" — real `bigint` values would then throw `TypeError: Do not know how to serialize a BigInt` at every `JSON.stringify` egress (the NDJSON export writer, `Response.json(page)`), which is the exact failure `adminResponse`'s comment describes. The correct seam is the one boundary where third-party JSON is produced: `connector-format.ts`.

## Current state

- `packages/runtime/src/query-coordinator.ts:1199` — `const value = await response.json();` (inside `callOneShard`); no `decodeWire`/`encodeWire` import exists anywhere in `query-coordinator.ts`, `data-movement-admin-routes.ts`, `connector-format.ts`, or `export-stream.ts` (verified by grep at the planned-at commit).
- `packages/do/src/shard-do.ts:313`:
  ```ts
  const adminResponse = (result: unknown): Response => jsonResponse({ result: encodeWire(result) }, 200);
  ```
  and the ingress half right below it (`decodeAdminArgs`) documents the pairing: "a payload this shard exported can be handed straight back — `cdcSync` → `applyCdc`, `exportShard` → `importShard` — with its `bigint`/bytes intact."
- `packages/runtime/src/data-movement-admin-routes.ts:164` — the export stream writes `JSON.stringify(row)` per NDJSON line; `:293` — `/connector/sync` returns `Response.json(page)`. Both payloads are wire-form and round-trip through `decodeAdminArgs` on re-import/replay — leave both as they are.
- `packages/runtime/src/connector-format.ts:93` (`toFivetranResponse`) and `:151` (`toAirbyteMessages`) — both iterate `page.changes` and pass `change.doc` through untouched:
  ```ts
  const data = change.op === "delete" ? { ...change.doc, _lunora_deleted: true } : change.doc;
  ```
- The wire codec lives in `shared/wire-codec.ts` (bundler-inlined, zero-dep — see the repo's `shared/` conventions in `CLAUDE.md`); `shared/base64.ts` exists. The shard-side source values are real (`packages/shard-engine/src/ctx-db-cdc.ts:107` returns `decodeDocJson(row.doc)`), so the tags are introduced purely by the missing inverse at the connector boundary.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/runtime..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/runtime" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/runtime" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/runtime" run lint:eslint` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `packages/runtime/src/connector-format.ts`
- `shared/wire-codec.ts` (only if the portable-mapping helper belongs beside the codec; a local helper inside `connector-format.ts` is equally acceptable — prefer the local helper unless a second consumer exists)
- `packages/runtime/__tests__/` — the existing connector-format test file (find it: `ls packages/runtime/__tests__ | grep -i connector`)

**Out of scope** (do NOT touch, even though they look related):
- `packages/runtime/src/query-coordinator.ts` — `callOneShard` must keep returning wire-form payloads; the paired round-trips depend on it.
- `packages/runtime/src/data-movement-admin-routes.ts` — the NDJSON export and `/sync` page stay wire-form (they are Lunora-native formats that re-import through `decodeAdminArgs`).
- `packages/do/src/shard-do.ts` — the encode/decode pairing is correct as is.

## Git workflow

- Branch: `improve/wave22-runtime`
- Commit: `fix(runtime): decode wire tags in connector output`

## Steps

### Step 1: Add a portable-JSON mapping for wire-tagged docs

In `connector-format.ts`, add a module-private helper that takes a `Record<string, unknown>` doc and returns one with every wire tag replaced by a warehouse-portable JSON value. Implement it by running `decodeWire` (import from `../../shared/wire-codec` — check the exact relative path other runtime files use, e.g. `grep -rn "shared/wire-codec" packages/runtime/src | head -3`) over the doc and then mapping the decoded values:

- `bigint` → `Number(value)` when `value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER`, else the decimal string (`value.toString()`);
- `ArrayBuffer` / typed arrays → base64 string (use `shared/base64.ts`'s encoder — read it first for the exact export name);
- everything else → unchanged.

Note: if importing `shared/*` into `packages/runtime` is new, check `packages/runtime/tsconfig.json` — a package importing `shared/*` must not set `outDir`/`rootDir` (see the `shared/` section of `CLAUDE.md`). `packages/runtime` already imports `shared/` modules (verify with the grep above), so no tsconfig change should be needed; if it turns out to be needed, that is a STOP condition.

**Verify**: `pnpm --filter "@lunora/runtime" run lint:types` → exit 0.

### Step 2: Apply it in both formatters

In `toFivetranResponse` and `toAirbyteMessages`, map each `change.doc` through the helper before building the output rows. The delete-marker spread in `toAirbyteMessages` (`{ ...doc, _lunora_deleted: true }`) operates on the mapped doc.

**Verify**: `pnpm --filter "@lunora/runtime" run test` → all pass.

### Step 3: Regression tests

In the existing connector-format test file, add cases feeding a `ConnectorSyncPage` whose `changes[].doc` contains a wire-encoded bigint (both within and beyond `Number.MAX_SAFE_INTEGER`) and wire-encoded bytes, asserting:
- Fivetran `insert` rows carry the number / decimal-string / base64-string forms — never a `["$lunora.wire$", ...]` array;
- Airbyte `RECORD.data` likewise;
- a pure-JSON doc is byte-identical to today's output (the mapping is identity for pure JSON).

**Verify**: `pnpm --filter "@lunora/runtime" run test` → all pass, including the new cases.

## Test plan

- New tests as in Step 3, in the existing connector-format test file (model on its existing `toFivetranResponse`/`toAirbyteMessages` cases).
- Existing export/import and cdc round-trip tests must stay green untouched — if any of them fails, the change leaked outside the connector boundary (STOP condition).

## Done criteria

- [ ] `pnpm --filter "@lunora/runtime" run test` exits 0, including new wire-tag cases
- [ ] `pnpm --filter "@lunora/runtime" run lint:types` and `lint:eslint` exit 0
- [ ] `grep -n "decodeWire" packages/runtime/src/query-coordinator.ts packages/runtime/src/data-movement-admin-routes.ts` → no matches (the fan-out and admin routes stay wire-form)
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- Any existing export→import or cdcSync→applyCdc test fails after the change — the paired round-trip must remain untouched.
- `packages/runtime` turns out not to import `shared/*` anywhere today AND its tsconfig sets `rootDir` (the tsconfig change ripples; report instead).
- You find an additional egress that hands wire-form docs to third parties (e.g. a studio export path) — report it; do not widen scope.

## Maintenance notes

- The NDJSON `/export` format and the raw `/sync` page remain wire-form by design; anyone building a new third-party egress must map docs through this helper. A reviewer should confirm the helper's bigint policy (number-when-safe, else string) is acceptable for the warehouse schemas users declare.
- Explicitly deferred: documenting the wire-tag vocabulary in `protocol/README.md` for direct `/sync` consumers who don't use the helpers.
