# Plan 305 — First-class Supabase and Firebase importers

**Baseline:** `9ddd16f63` (2026-08-05)
**Status:** TODO
**Priority:** P2 · **Effort:** L · **Risk:** MED · **Category:** data/migration

> **Executor instructions**: follow this plan step by step, run every verification
> command, and confirm the expected result before moving on. If a STOP condition
> in §8 occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: re-confirm plan **304** (blob/`_storage` import)
> has landed — this plan's storage transfer and verification reuse its admin
> route work. If 304 is still open, branch after it, not before.
>
> **Read 304 §10 before writing any code.** Its answers are this plan's
> defaults, not background: content-hash keys, skip-if-present idempotency, the
> 32 MiB verified-upload cap with a signed-PUT fallback above it, digest
> normalisation at the source boundary, dangling references reported rather than
> guessed, and a flag that cannot apply failing loudly instead of no-opping. The
> §3 contract below restates the ones that bind here.

## 0. Headline finding

The migration guides for Supabase and Firebase are **docs-only** on the data
side. Convex migration has a working importer (`lunora import`); the other two
end at "dump each table, reshape by hand, batch-insert via a mutation or a
`lunora run` script" (`from-supabase.mdx` step 7, ~:279). Nobody wants to hand-
write a reshape script and a batch-insert mutation as the migration path for
each app. Data tables, auth users, and object storage are all unmigrated, and
nothing stops an app from carrying stale `@supabase/*` or `firebase/*` imports
into the Lunora codebase after porting.

## 1. Current state (audit)

### 1.1 Supabase

`apps/docs/src/content/docs/migrating/from-supabase.mdx` step 7 (~:279):
"Export & import data. Dump each table (`pg_dump`/`COPY … TO` …), reshape
(`timestamptz` → your `createdAt`; `uuid` PKs → your `id` columns), then
batch-insert via a mutation or a `lunora run` script." No CLI importer; the
reshape is a per-app hand-written step. `auth.users` (bcrypt passwords) and
Supabase Storage (S3-compatible) are not covered by any tooling.

### 1.2 Firebase

`apps/docs/src/content/docs/migrating/from-firebase.mdx` likewise documents the
port but ships no importer. Firestore export (`gcloud firestore export`) is a
typed, well-defined on-disk format, and Firebase Auth's `auth:export` JSON is
similarly regular — both are mechanical to read, which makes their absence a
pure tooling gap.

### 1.3 The pipeline both would feed

`runImportCommand` (`packages/cli/src/commands/data-transfer.ts`) + the admin
import endpoint (`packages/runtime/src/import-stream.ts`, `streamingImport`,
`parseImportRow`, per-shard `AdminBatch`, `ImportRowError`) accept NDJSON
`{ table, doc }` and insert with `allowExplicitId` — ids preserve verbatim and
`v.id()` validates only that a value is a string. This is exactly what Convex
migration relies on (§304), and it generalizes: **any** source reshaped to
`{ table, doc }` with preserved ids imports with zero new server machinery.

### 1.4 Auth target

`@lunora/auth` is better-auth on D1 with the standard models `user`, `session`,
`account`, `verification` (`packages/auth/src/admin.ts` reads/writes those
models). Supabase stores bcrypt hashes and Firebase stores its own scrypt
params — neither is portable into better-auth's hashing, so **passwords must be
nulled and reset**, not migrated.

### 1.5 Storage target

`@lunora/storage` is R2-backed (`packages/storage/src/create-storage.ts`).
Uploads already flow through the admin route that plan **304** extends with
checksum verification. Supabase Storage is S3-compatible (endpoint + access
keys); Firebase Cloud Storage is GCS (S3-interop XML API, but credentials are
Google OAuth unless the user configures HMAC keys).

### 1.6 Dependencies

The catalog (`pnpm-workspace.yaml`) has `adm-zip` but **no S3 client, no CSV
parser, no Postgres client**. `csv-parse` and `@aws-sdk/client-s3` would be
new catalog entries.

## 2. Existing seams (do not reinvent)

- **`runImportCommand` + `streamingImport`** — one sink for every source. A
  source is just a reader that yields `{ table, doc }` NDJSON.
- **Plan 304's admin upload route** (`PUT /_lunora/admin/storage` with
  `expectedSha256`/`expectedSize`) — the checksum-verified channel for object
  storage transfer.
- **The Convex import's id-preservation argument** (§304 §1.1, `data-transfer.ts:411`)
  — preserved source PKs mean FKs survive without a two-pass remap.
- **Config-file precedent** — `lunora/schema.ts` is already read by the CLI; a
  per-source mapping file is the same pattern, one level down.
- **The Convex importer's structure** — `convexExportTables`/`readConvexExport`
  are a directory detector + streaming reader; the new sources are the same
  shape with different formats. Add sibling readers, don't fork the pipeline.
- **`@lunora/advisor` lint layout** (`packages/advisor/src/lints/`) — the
  stale-import lint is a static lint exactly like the existing ones.

## 3. The behavioural contract to preserve

- Everything imports through `{ table, doc }` NDJSON with **ids preserved**
  verbatim; `allowExplicitId` and per-shard batching behave as today.
- **Passwords are never migrated.** `user.passwordHash` is nulled for every
  imported user; `emailVerified` and profile fields are preserved. The guide
  documents the reset flow (better-auth "forgot password" + `sendResetPassword`).
- **No silent type coercion.** A column the mapping does not name is copied
  through untouched; a reshape that would lose data (e.g. a `float8` into an
  integer column) errors rather than truncating.
- The guides' porting prose stays accurate — the importers replace step 7's
  hand-written script, they don't change the schema-mapping advice.
- New deps go in the catalog (`catalog:cli`-style), never hardcoded; `@lunora/cli`
  and `@lunora/advisor` stay the only packages that gain source in this plan.

Carried over from 304 §10 — these are not optional restatements, they are the
defects that plan hit and closed:

- **A flag that cannot apply is an error.** `--from supabase` without a CSV dir,
  `--verify` without a countable source, a storage transfer against a host with
  no admin upload route: exit non-zero. Never accept the flag and do nothing.
- **A malformed mapping file never degrades to a default.** Only a _missing_
  `lunora/import-<source>.json` is optional; invalid JSON, a bad `types` entry,
  or an unreadable file fails the run naming the key.
- **Every source-supplied identifier is a path until proven otherwise.** A
  Firestore `__name__`, a Supabase storage object key, a CSV filename from the
  mapping — resolve and containment-check before reading or writing anything.
- **Blob transfer is idempotent by construction and verified before write.**
  Content-hash keys, one prefix listing to skip what is already present, the
  verified admin route under the cap, and delete-on-mismatch above it.
- **Unresolvable references are reported, never guessed.** Same dangling report
  and same `--verify` failure as 304.

## 3.1 Coverage — what "migrated" covers, and what it does not

A migration that moves tables but leaves the operator to discover that their
Realtime Database, their enum columns, or their `numeric(20,4)` money column
never came across is not a migration. Each row is decided here, in the plan,
rather than at runtime.

| Asset                               | Supabase                                    | Firebase                                        | Verdict                             |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| Data tables                         | CSV per table (W1)                          | Firestore export (W2)                           | **In scope**                        |
| Ids / foreign keys                  | source PK preserved via `allowExplicitId`   | `__name__` → `_id`                              | **In scope** — no remap pass        |
| Auth users + linked providers       | `auth.users` + `auth.identities`            | `auth:export` JSON                              | **In scope**, passwords nulled      |
| Object storage                      | S3-compatible listing → R2                  | local `gcloud storage cp` dir → R2              | **In scope** (W4)                   |
| Sessions / refresh tokens           | —                                           | —                                               | **Out** — bearer state, re-login    |
| Firebase Realtime Database          | n/a                                         | single-JSON-tree export, not Firestore's format | **Out of W2** — see Q7              |
| Postgres enums / arrays / `numeric` | explicit `types` entries, else error        | n/a                                             | **In scope** — see the reshape rule |
| RLS policies / DB functions         | ported by hand per the guide                | security rules ported by hand                   | **Out** — prose, not tooling        |
| Edge functions / Cloud Functions    | rewritten as Lunora functions per the guide | same                                            | **Out** — prose, not tooling        |
| Realtime channels / listeners       | rewritten against `useQuery` per the guide  | same                                            | **Out** — prose, not tooling        |

The out-of-scope rows are not silence: the guides already cover them, and W6
must link each one from the data step so a reader who followed the importer
knows what is still theirs to do.

**Reshape rule.** A column with no `types` entry is copied through untouched. A
column whose declared reshape would lose information — `float8`/`numeric` into a
JS number past `Number.MAX_SAFE_INTEGER`, `int8` into a number, a timestamp with
an offset the target drops — **errors naming the column**, and the mapping must
choose a lossless target (`v.bigint()`, a string) instead. This is the plan's
first STOP condition; it is restated here because it is the rule most likely to
be quietly relaxed under a failing fixture.

## 4. Design decisions

### D1 — One shared "source reader" interface; a module per source

`runImportCommand` takes an NDJSON path today. Add a
`source: "convex" | "supabase" | "firebase" | "ndjson"` dispatch; each non-NDJSON
source is a reader module under `packages/cli/src/commands/import/sources/` that
yields `{ table, doc }` (and, for 304, blob uploads). **Rejected:** a separate
`@lunora/migrate` package — the readers have no second consumer, and the
`@lunora/seed` precedent is for reusable logic, not CLI-only format decoders.
Extract when a real second consumer appears (AGENTS: avoid premature
abstraction).

### D2 — Supabase data: CSV per table + a mapping file

Primary path is CSV (`COPY <t> TO STDOUT WITH CSV HEADER` or the dashboard's
export), read with `csv-parse`. `lunora/import-supabase.json`:

```jsonc
{
    "tables": {
        "users": {
            "file": "auth.users.csv", // optional; defaults to <table>.csv
            "idColumn": "id", // preserved as _id
            "types": {
                // column → Lunora reshape
                "created_at": "timestamp-ms",
                "metadata": "jsonb",
                "doc": "bytea-base64",
            },
            "foreignKeys": ["team_id"], // sanity-checked in --verify
        },
    },
    "auth": { "file": "auth.users.csv" }, // → better-auth user/account rows
}
```

Rejected alternatives: direct Postgres connection (adds a `pg` dependency and a
live-network path for marginal gain over a dump the user already can produce),
and `pg_dump --data-only --column-inserts` SQL parsing (fragile against
Postgres's escaping; CSV is the portable contract). Direct-PG stays an open
question (§9).

### D3 — Firebase data: Firestore export reader

`gcloud firestore export gs://bucket/path` produces `<kind>.export_metadata` +
JSON document shards per collection; each document carries `__name__`
(`projects/<p>/databases/(default)/documents/<collection>/<id>`) and typed
fields (`timestampValue`, `integerValue` as a string, `doubleValue`,
`booleanValue`, `referenceValue`, `bytesValue` base64, `geoPointValue`,
`nullValue`, `arrayValue`, `mapValue`). The reader decodes these to plain JS:
`__name__` → `_id`, `integerValue` → `number` (string → `v.bigint()` where the
mapping says so), `timestampValue` → ISO/ms per mapping, `referenceValue` →
string path per mapping, `geoPointValue` → `{ latitude, longitude }`.
`lunora/import-firebase.json` carries the same per-table `types`/`idColumn`
shape as D2. **Rejected:** reading `gcloud`'s live API — the export dir is the
stable artifact and needs no Google credentials in the CLI.

### D4 — Auth import maps into better-auth models

Supabase: `auth.users` (id, email, email_verified, name/avatar, timestamps,
password_hash) → `user`; `auth.identities`/`auth.providers` → `account`.
Firebase: `auth:export` JSON (`localId`, `email`, `emailVerified`,
`displayName`, `photoUrl`, `providerUserInfo`, `passwordHash`) → `user` +
`account`. **Passwords are nulled** (D3 in the plan's contract section) because
bcrypt/scrypt are not portable into better-auth. **Rejected:** porting the
hashes or transparent re-hash-on-login — both require a login-path shim this
plan would rather not ship.

### D5 — Storage transfer in the CLI, two ingestion modes

- **Supabase**: S3-compatible access keys; the CLI lists each bucket, downloads
  objects, uploads through 304's verified admin route, and rewrites columns
  named in the mapping. `@aws-sdk/client-s3` (catalog).
- **Firebase**: the user downloads first (`gcloud storage cp -r gs://bucket
dir/`), the CLI ingests the local dir. **Rejected:** Google OAuth in the CLI —
  the `gcloud` tool already owns that; and the HMAC/S3-interop XML API — more
  setup than a one-line `gcloud storage cp`.

Path-column remap uses the same mapping-file mechanism as 304's
`storageColumns` (`{ table: [col] }` → new R2 key), reusing its
`{ $storage }`-style ambiguity handling where the source self-describes.

### D6 — `migration_stale_import` advisor lint

A static lint in `packages/advisor/src/lints/` flagging imports of
`convex/*`, `@convex-dev/*`, `@supabase/*`, `firebase/*`, `@firebase/*` in
`lunora/` source, with a message naming the matching guide
(`migrating/from-*.md`). Same lint shape as the existing `argument-derived-sink`
and storage lints (codegen-feeder input or direct AST pass, whichever the
advisor's existing static lints use). **Rejected:** runtime lint — an import
that made it past codegen already failed the build.

## 5. Workstreams

Sized M/L, sequenced in §7. **Status is recorded here as each lands.**

- **W1 (M) — Supabase CSV reader + mapping file.** `csv-parse` in the catalog;
  `lunora/import-supabase.json`; reshape table (`timestamp-ms`, `jsonb`,
  `bytea-base64`, `int8-string`); ids preserved; `--scan`-style column-guess
  output for `types`.
- **W2 (M) — Firestore export reader.** Directory scan for
  `.export_metadata`/shard JSON; typed-field decoder; `__name__` → `_id`;
  `lunora/import-firebase.json`.
- **W3 (M) — Auth import (both sources).** Better-auth `user`/`account` row
  emission; password nulling; email-verified preservation; docs on the reset
  flow.
- **W4 (L) — Storage transfer (both sources).** Supabase S3 listing + download;
  Firebase local-dir ingest; both upload via 304's verified route with
  path-column remap per the mapping files.
- **W5 (S) — `migration_stale_import` lint** + its fixtures.
- **W6 (S) — Docs.** Steps 7+ of both guides rewritten around the importers;
  auth + storage recipes; every §3.1 out-of-scope row linked from the data step.
- **W7 (S) — `--verify` + `--scan` parity with 304.** Per-table row parity
  (source rows counted before the run, compared against inserted), the
  dangling-reference report for remapped storage/reference columns, and a
  `--scan` that _writes_ the candidate `lunora/import-<source>.json` (`wx`, never
  clobbering a confirmed one) instead of printing it. Non-zero exit on any
  mismatch. Firestore parity must count **every shard** named by
  `.export_metadata`, which is what turns the sharding risk below into a caught
  failure rather than a silent partial import.

## 6. Platform parity

**Mandatory** — the storage-transfer surface is binding-backed and the admin
upload route is Cloudflare-host-native:

| Feature                                              | `cloudflare` | `node` (experimental) | Notes                                                            |
| ---------------------------------------------------- | ------------ | --------------------- | ---------------------------------------------------------------- |
| Supabase/Firebase **table** import (`lunora import`) | native       | native                | Pure CLI reshaping into the existing admin import; host-agnostic |
| **Auth** user/account import                         | native       | native                | Writes regular D1-backed better-auth tables via the same import  |
| **Storage** transfer (S3 → R2 / GCS dir → R2)        | native       | unsupported           | Needs 304's admin upload route; Node spike has none              |

No `ctx.*` surface changes. Table + auth import work on any host that serves the
admin import endpoint; storage transfer is gated exactly as in §304.

## 7. Phasing & ordering

| Phase | Work                     | Gate                                                                                                                                      |
| ----- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | W1 — Supabase CSV reader | A fixture CSV (uuid PK, `timestamptz`, `jsonb`, `bytea`) imports to the expected `{ table, doc }`; reshape failures error, never truncate |
| 1     | W2 — Firestore reader    | A small `gcloud firestore export` fixture (timestamps, refs, arrays, maps, bytes) decodes correctly; `__name__` → `_id`                   |
| 2     | W3 — Auth import         | Fixture auth dumps produce `user`/`account` rows with nulled `passwordHash`; reset recipe in the guide                                    |
| 3     | W4 — Storage transfer    | Supabase S3 fixture + Firebase local dir transfer through 304's route with checksum verify; path columns remapped per mapping             |
| 4     | W5 — Stale-import lint   | A fixture with a `@supabase/*` import fails the lint; the message names the guide                                                         |
| 5     | W7 — `--verify`/`--scan` | A truncated fixture (dropped CSV row, missing Firestore shard, unmapped ref) exits non-zero naming the table; `--scan` writes the mapping |
| 6     | W6 — Docs                | `from-supabase.mdx` / `from-firebase.mdx` steps reference the importers; every §3.1 out-of-scope row is linked; Prettier-clean            |

Phase 3 depends on plan **304** (verified admin upload). Phases 0–2 and 4 are
independent of 304. `pnpm --filter "@lunora/cli" run test` / `lint:types`,
`pnpm --filter "@lunora/advisor" run test`, and `pnpm run lint:package-json`
must be green after every phase (the catalog grows new entries).

## Commands you will need

| Purpose            | Command                                                                              | Expected                           |
| ------------------ | ------------------------------------------------------------------------------------ | ---------------------------------- |
| CLI tests          | `pnpm --filter "@lunora/cli" run test`                                               | green                              |
| Advisor tests      | `pnpm --filter "@lunora/advisor" run test`                                           | green                              |
| Manifest order     | `pnpm run lint:package-json`                                                         | 69/69 sorted (new deps in catalog) |
| Rebuild deps first | `pnpm run build:packages`                                                            | dist current                       |
| Manual end-to-end  | `lunora import --from supabase --csv-dir …` / `--from firebase --firestore-export …` | rows land, ids preserved           |

## Test plan

- Fixtures committed per source: a small CSV set, a small Firestore export
  dir, auth dumps for both providers. Small but type-covering (every reshape in
  §5 W1/W2's lists).
- Negative tests: an unmapped column passed through untouched; a
  would-truncate reshape errors; an auth dump with a pre-existing email dedups
  or errors per the decided policy (Q4); passwords are never present in output.
- Lint: fixture with each banned import prefix → one finding each, guide named
  in the message; clean fixture stays clean.
- Integration: imported rows round-trip through `lunora export` (parity is
  already guaranteed by the shared NDJSON contract — assert it once).

## Done criteria

- [ ] `lunora import --from supabase` and `--from firebase` import data tables
      with preserved ids through the existing admin import
- [ ] Auth users land in better-auth `user`/`account` with nulled passwords and
      preserved `emailVerified`; reset flow documented
- [ ] Storage transfer ships for both sources through 304's verified upload
      with path-column remap
- [ ] `migration_stale_import` lint flags stale imports with guide links
- [ ] Both guides' data steps reference the importers; no manual reshape script
      remains in step 7
- [ ] New deps in the catalog; `lint:package-json` green; no `ctx.*` change
- [ ] `--verify` fails non-zero on row parity, a missing Firestore shard, or an
      unresolved reference; `--scan` writes the mapping file it documents
- [ ] Every §3.1 row is either implemented or linked from the guide as the
      reader's own remaining work — no asset is left unmentioned
- [ ] A storage-aware or source-specific flag that cannot apply exits non-zero
      rather than being ignored

## 8. Risks & STOP conditions

- **STOP** if reshaping a column would silently drop data and the design is
  tempted to coerce anyway (e.g. `float8` → integer, `int8` → `number`).
  A lossy reshape errors and names the column, or it does not ship.
- **STOP** if auth import cannot null passwords without breaking better-auth's
  model constraints. Better-auth's `user.passwordHash` is nullable by design;
  if a plugin under test proves otherwise, report rather than fabricate a hash.
- **Risk:** Firestore export sharding — large collections split across multiple
  JSON shards plus `.export_metadata`; a naive "first file only" reader silently
  imports a fraction. Mitigate: W2 must walk every shard referenced by the
  metadata and assert the count in `--verify`.
- **Risk:** Supabase CSV quirks — `COPY` CSV escaping, `\N` nulls, bytea hex
  (`\x…`). Mitigate: use `csv-parse` (not hand-rolled), and pin the bytea
  decode against a fixture.
- **Perf watch:** no `__bench__` exists for import; measure a 100k-row CSV pass
  and a 100-object S3 transfer in the PR and record the numbers. Target: table
  import ≥ 50k rows/s locally, matching the Convex import's observed rate.
- **Risk:** catalog growth (`csv-parse`, `@aws-sdk/client-s3`) — the SDK is
  heavy. Mitigate: import only `S3Client`/`ListObjectsV2`/`GetObject` from the
  tree-shakeable entry, and confirm the CLI bundle stays under the current size
  budget (record the before/after).

## 9. Open questions (answer during execution)

1. **Direct Postgres mode.** Worth a `--pg-url` path (new `pg` catalog dep) on
   top of CSV? Recommend no for now — CSV is the portable contract and every
   hosted Postgres offers it — but the reader interface (D1) must not preclude
   it.
2. **Firestore references.** `referenceValue` carries a full resource path. Map
   to a plain string by default (matches `v.id()`'s string-validating
   semantics) or allow a `refs: { col: ["refField"] }` remap to the target
   document's `_id`? Recommend the latter as an opt-in mapping key.
3. **`bytea`/`bytesValue` target.** Base64 string vs `v.bytes()`
   (`ArrayBuffer`)? Recommend base64 string (survives the NDJSON wire shape
   unchanged) unless a mapping key requests bytes.
4. **Auth email collisions.** When an imported `user.email` already exists,
   skip, dedup to the existing row, or error? Recommend error-with-list
   (imports are all-or-nothing by default) so the operator resolves it before
   the run.
5. **Supabase `auth.users` timestamps.** Preserve `created_at`/`last_sign_in_at`
   into better-auth's `createdAt`/`lastLoginAt`, or let the row defaults stand?
   Recommend preserve (`allowExplicitId` precedent), but confirm better-auth
   tolerates explicit timestamps.
6. **Stale-import lint scope.** Should the lint also flag `@tanstack/*`-style
   adapter confusion or only the three migration targets named in the guides?
   Recommend the three — the lint exists to catch a half-finished port, not to
   police library choice.
7. **Firebase Realtime Database.** RTDB exports one JSON tree, not Firestore's
   typed shards, and its "documents" are arbitrarily nested nodes with no
   collection boundary. Is it a third reader (`--from rtdb`, with the mapping
   naming which top-level nodes become tables and which key becomes `_id`), or
   does the guide keep telling RTDB users to reshape by hand? Recommend the
   third reader **only if** a mapping can express the node→table split without
   guessing; otherwise say so in `from-firebase.mdx` explicitly rather than
   leaving the reader to discover it. Either way §3.1 must not stay ambiguous.
8. **Storage transfer resumability.** 304 skips an object already present at its
   content-hash key, which makes a re-run cheap. For an S3 source, does the
   skip-probe list R2 once by prefix (304's shape) or HEAD per object? Recommend
   the single prefix listing — a bucket with 100k objects makes per-object HEADs
   the dominant cost of a resumed run.

Settled by 304 §10 — do not re-litigate: content-hash keys, skip-if-present
without a `--force`, the 32 MiB verified-upload cap with a signed-PUT fallback
above it, and "report, never guess" for unresolvable references.
