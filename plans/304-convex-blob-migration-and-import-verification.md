# Plan 304 — Migrate Convex `_storage` blobs and verify imports

**Baseline:** `9ddd16f63` (2026-08-05)
**Status:** DONE (landed on PR #354)
**Priority:** P1 · **Effort:** M · **Risk:** MED · **Category:** data/migration

> **Executor instructions**: follow this plan step by step, run every verification
> command, and confirm the expected result before moving on. If a STOP condition
> in §8 occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: re-confirm the `_storage` skip (§1.1) still exists
> at the cited line and that `PUT /_lunora/admin/storage` still requires a `key`
> query parameter. If either has changed, re-derive the seams before editing.

## 0. Headline finding

`lunora import` migrates a Convex export's **documents** but not its **files**.
The `_storage` table — Convex's system table describing every stored blob — is
explicitly skipped with a warning to "upload the exported blobs to R2 and
re-point the keys" by hand. So a Convex app with file storage loses every file,
and every document field holding a storage id becomes a dangling reference.
The Convex migration story is otherwise complete (ids preserved verbatim, single
pass); blobs are the last real gap. Import verification is also absent: the
command reports tallies but never checks row-count parity or dangling references
against the source.

## 1. Current state (audit)

### 1.1 The `_storage` skip

`packages/cli/src/commands/data-transfer.ts`:

- `CONVEX_STORAGE_TABLE = "_storage"` (~:361) — documented as "rows describe
  stored BLOBS … belong in R2, so importing the rows alone would create
  dangling references".
- `convexExportTables` (:373) — the detector: a directory whose subdirectories
  each hold a `documents.jsonl`. Returns `{ file, table }[]` or `undefined`.
  Only walks directories; a **`.zip` snapshot is not detected**.
- `readConvexExport` (:426) — streams each table as `{ table, doc }` NDJSON; the
  `_storage` branch warns and `continue`s (~:428). The comment block above it
  (:411) explains the single-pass no-remap correctness argument for plain docs:
  the admin import path inserts with `allowExplicitId` preserving `_id` verbatim.
- `wrapJsonlLines` (:395) — per-file streaming; the `{ table, doc }` envelope is
  the wire shape the admin import endpoint accepts.

### 1.2 The upload seam that already exists

`packages/runtime/src/storage-admin-routes.ts`:

- `PUT/POST /_lunora/admin/storage` → `handleStorageUpload` (:109) requires a
  `key` query parameter (`requireStorageKey` :59), reads the body to a buffer
  (:120, under the runtime's declared-length guard), and calls
  `storageUpload(key, body, { bucket, contentType })` (:124).
- `GET /_lunora/admin/storage` → `handleStorageList` (:69) lists by prefix.
- `DELETE` → `handleStorageDelete` (:95).
- Wired into the worker at `packages/runtime/src/create-worker.ts` (~:2861);
  the `storageUpload` option is created at `create-worker.ts:1205`.

`@lunora/storage` (`packages/storage/src/create-storage.ts`) surfaces the R2
checksum as `sha256` / `sha256Base64`, enforces a 1024-char key ceiling, and
lists capped at 1000. There is **no checksum/size verification** on any upload
path today — nothing a re-import can assert bytes were written correctly.

### 1.3 The Convex export format (what the importer must read)

`npx convex export --path <dir|snapshot.zip> --include-file-storage` emits:

- `<table>/documents.jsonl` — one JSON document per line (already handled).
- `_storage/documents.jsonl` — metadata rows shaped
  `{ _id, _creationTime, sha256, size, contentType? }` (`sha256` is hex of the
  file contents; `size` is bytes). Legacy pre-1.6 storage ids may appear in
  documents as plain strings distinct from any `_id`.
- `_storage/<id>` — the raw blob bytes, filename = the metadata row's `_id`.
- In the **ZIP** snapshot the same layout sits under a `snapshot_<ts>/` root.

A storage reference inside a document is one of two shapes:

- a plain **string** equal to a `_storage` `_id` (field validated with
  `v.id("_storage")`), or
- a self-describing **`{ $storage: "<id>" }`** object (Convex's typed Storage
  value form).

### 1.4 Import plumbing to reuse

`packages/runtime/src/import-stream.ts` — `streamingImport` (sole entry),
`parseImportRow` (:33), per-shard `AdminBatch` bucketing under
`MAX_BODY_BYTES`, per-row `ImportRowError` collection. The CLI hits it via
`POST /_lunora/admin/import`; `packages/cli/src/commands/import/handler.ts`
wires `--table / --batch-size / --prod / --yes / --url / --token`
(`packages/cli/src/commands/import/index.ts`). The export twin
(`packages/runtime/src/export-stream.ts` `streamExportRows`, backed by
`/_lunora/admin/export`) currently emits no blobs either.

### 1.5 Dependency availability

`adm-zip` is already in the root catalog (`pnpm-workspace.yaml:53`) — the ZIP
reader needs no new dependency.

## 2. Existing seams (do not reinvent)

- **`readConvexExport` / `wrapJsonlLines`** — the table→NDJSON streaming core.
  Blob import does not touch it; the docs half stays byte-identical.
- **`PUT /_lunora/admin/storage`** — the verified-upload home. Extend it with
  `expectedSha256`/`expectedSize` rather than minting a parallel route.
- **`runImportCommand` / `POST /_lunora/admin/import`** — the doc stream lands
  through the same channel as today, so shard bucketing, `allowExplicitId`, and
  error collection all apply unchanged.
- **`@lunora/storage` checksums** — the `sha256`/`sha256Base64` surface is how
  the route and the CLI can both speak checksums without new crypto plumbing.
- **`adm-zip`** (already catalogued) for snapshot `.zip` support.
- **`v.id()` semantics** — same as the existing single-pass argument: a migrated
  blob key is just a string, so remapped references stay plain strings.

## 3. The behavioural contract to preserve

- The **plain-document import path is byte-identical** to today: same envelope,
  same id-preserving single pass, same `_storage` handling **unless** the user
  opts into blob migration. Without a `--with-storage`-style opt-in, the current
  warn-and-skip remains the behaviour.
- **Verify before write.** No blob bytes are persisted without a passing
  `sha256` + `size` check against the `_storage` metadata row. A mismatch fails
  that blob loudly and stops the import — never "import what we got".
- `_storage` **rows are never imported as table documents** — that would create
  the dangling-reference problem the current skip exists to avoid.
- **No new runtime dependency on zero-dep packages** (`@lunora/platform`, …) and
  no `.js` extension on any relative import. `adm-zip` is a CLI-side dependency
  only.
- Wire shape `{ table, doc }` and the `ImportRowError` contract are unchanged.

## 4. Design decisions

### D1 — Content-hash blob keys (key = hex `sha256` of the bytes)

The remap target for every migrated blob is `[keyPrefix] + sha256hex`. Same
content re-imports to the same key (idempotent, and re-runs can skip objects
already present), dedup is free, and cache-friendly read URLs fall out.
**Rejected:** key = the Convex storage id. It needs no mapping for string
columns and round-trips the original value, but it preserves no dedup, makes
re-runs ambiguous, and keeps a foreign id format in R2 forever. The mapping cost
of content-hash is accepted and handled by D3.

### D2 — Two-phase import: blobs first, then documents

Phase 1 uploads and verifies every blob and builds the in-memory
`storageId → key` map; phase 2 streams documents through the existing import
endpoint with references rewritten. Because blobs land first, no document can
reference a missing object. **Rejected:** interleaving blob upload into the
document stream — couples the stateless NDJSON pipeline to upload ordering and
reopens the dangling-reference window on a mid-stream failure.

### D3 — Reference rewriting: mapping file + self-describing auto-rewrite

- `{ $storage: id }` objects are unambiguous and rewritten **automatically**
  (Convex's typed form; the object itself is not valid Lunora data).
- Plain-string columns that hold `v.id("_storage")` values are ambiguous against
  ordinary text, so they are remapped **only** via an explicit mapping file —
  `lunora/import-convex.json`:

    ```jsonc
    {
        "keyPrefix": "", // optional R2 key prefix (e.g. "convex/")
        "storageColumns": {
            // table → columns that hold storage ids
            "images": ["storageId"],
            "posts": ["coverId"],
        },
    }
    ```

- **`--scan`** helper: the CLI exact-matches every string value in the source
  documents against the `_storage` id set (new-format `_id` and legacy ids) and
  prints a candidate `storageColumns` for the user to confirm into the file.
  A string that matches a storage id but is **not** in the mapping is reported
  as a candidate dangling reference, not silently rewritten.

**Rejected:** schema-driven detection (a Lunora `v.string()` column cannot be
distinguished from a storage key — there is no validator for it yet) and
unconditional exact-match auto-rewrite (silent false positives on user text).

### D4 — Verification lives on the existing admin upload route

`handleStorageUpload` gains optional `expectedSha256` + `expectedSize` query
parameters. When present the handler digests the buffered body, rejects
non-matching bytes (400, before `storageUpload` is called), and returns the
computed hash in the JSON response. The CLI always sends both. **Rejected:** a
dedicated `/import-blob` route — duplicates the admin gating and option wiring
for no gain.

### D5 — ZIP snapshots via `adm-zip`

`convexExportTables` also accepts a `.zip` path: enumerate `*/documents.jsonl`
inside, and treat `_storage/` as the blob dir (metadata file + blobs read from
the archive on demand). Directory exports stay the primary, tested path; ZIP is
the convenience surface. **Rejected:** hand-rolled ZIP (error-prone) and shelling
out to `unzip` (platform-dependent).

### D6 — `--verify` folds into the import summary

Rather than a new subcommand, the import report gains an optional verify pass:
per-table source-line count vs inserted count, the dangling-storage list, and
(opt-in) a dangling-FK spot check. `--verify` exits non-zero on mismatch; the
default summary keeps today's shape. **Rejected:** a standalone `lunora verify`
command — no independent consumer yet, and the source context (the export dir)
is naturally at hand during import.

## 5. Workstreams

All S/M, sequenced in §7. **Status is recorded here as each lands.**

- **[x] W1 (S) — Admin route verification.** `expectedSha256`/`expectedSize` on
  `handleStorageUpload` (`storage-admin-routes.ts:109`), a registered
  `STORAGE_CHECKSUM_MISMATCH` error, computed-hash response, and route tests
  (mismatch → 400 before write; missing param → today's behaviour; match → 200).
  Also an idempotency affordance for re-runs (see Q3).
- **[x] W2 (M) — `_storage` snapshot reader + blob uploader (CLI).** `--with-storage`
  opt-in on `lunora import`; read `_storage/documents.jsonl`, stream each
  `_storage/<id>` file to the route with `key=[keyPrefix]sha256`,
  `expectedSha256`/`expectedSize`, building the `storageId → key` map; fail-close
  on any mismatch/missing file. `adm-zip` path for `.zip`.
- **[x] W3 (M) — Remap layer + `--scan` + dangling report.** `{ $storage }`
  auto-rewrite; `lunora/import-convex.json` mapping applied to the specified
  columns during doc streaming; `--scan` emits the candidate mapping; candidates
  outside the mapping are listed, not rewritten.
- **[x] W4 (S) — `--verify`.** Per-table parity vs the source JSONL line counts,
  dangling-storage list, optional FK spot check; non-zero exit on mismatch.
- **[x] W5 (S) — Docs + CLI help.** `from-convex.mdx` "files" step rewritten around
  `npx convex export --include-file-storage` + the opt-in; `import` command help
  and examples updated; the `_storage` warn message reworded to name the opt-in.

## 6. Platform parity

**Mandatory** — this adds a storage capability (checksum-verified upload) to the
admin surface, and codegen reads the matrix:

| Feature                                          | `cloudflare` | `node` (experimental) | Notes                                                                                                          |
| ------------------------------------------------ | ------------ | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Checksum-verified blob upload (`expectedSha256`) | native       | unsupported           | Lives on `/_lunora/admin/storage`; the Node host spike has no admin storage route                              |
| `lunora import --with-storage` (blobs + remap)   | native       | unsupported           | Blob phase requires the route above; table-only import behaviour unchanged everywhere                          |
| `--verify` parity / dangling-ref report          | native       | native                | Pure client-side counting over the source dir + the import response; works against any host that serves import |

No `ctx.*` surface changes. A future host that wants blob import must implement
the admin storage route (or an equivalent `native` path); until then it stays
`unsupported` and the CLI must fail with a clear message rather than silently
skipping blobs.

## 7. Phasing & ordering

| Phase | Work                                       | Gate                                                                                                                                                                                          |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | W1 — route verification                    | Route unit tests green: mismatch → 400 **before** `storageUpload` is invoked; match → 200 with the hash in the body                                                                           |
| 1     | W2 — reader + uploader (directory exports) | A fixture `npx convex export --include-file-storage` dir imports end-to-end; every blob verified; map complete; no dangling refs reported                                                     |
| 2     | W3 — remap + `--scan`                      | Fixture with a `{ $storage }` ref and a mapped column round-trips to content-hash keys; `--scan` prints the exact candidate mapping; an unmapped storage-id string is reported, not rewritten |
| 3     | W4 — `--verify`                            | A truncated fixture (delete one blob / drop one row) makes `--verify` exit non-zero with the right line                                                                                       |
| 4     | W5 — ZIP + docs + help                     | `snapshot.zip` imports identically to the directory form; `from-convex.mdx` + `--help` reflect the opt-in                                                                                     |

Every phase is independently shippable. Phases 0–1 are the core value; 2–4
tighten it. `pnpm --filter "@lunora/cli" run test` and `pnpm --filter "@lunora/runtime" run test`
must be green after every phase.

## Commands you will need

| Purpose            | Command                                                              | Expected                            |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------- |
| CLI tests          | `pnpm --filter "@lunora/cli" run test`                               | green                               |
| Runtime tests      | `pnpm --filter "@lunora/runtime" run test`                           | green                               |
| Type check         | `pnpm --filter "@lunora/cli" run lint:types`                         | clean                               |
| Rebuild deps first | `pnpm run build:packages` (or `--filter "@lunora/cli..." run build`) | dist current                        |
| Manual end-to-end  | `lunora import ./convex-export --with-storage --verify`              | all blobs verified, 0 dangling refs |

## Test plan

- Route: unit tests for `expectedSha256`/`expectedSize` presence, mismatch,
  pass, and byte-identical default behaviour when absent.
- Reader: a committed fixture directory and ZIP (tiny blobs, a
  `{ $storage }` ref, a mapped column, a legacy-id string) exercising W2/W3.
- Verify: positive and negative runs (missing blob, extra row) asserting the
  exit code.
- Regression: importing a **plain NDJSON** file and a Convex export **without**
  `--with-storage` produces today's exact behaviour (no new errors, same skip
  warning).

## Done criteria

- [ ] `--with-storage` imports a directory and ZIP Convex export with blobs,
      every blob sha256+size verified before write
- [ ] References rewritten: `{ $storage }` auto, mapped columns via
      `lunora/import-convex.json`, unmapped storage-id strings reported
- [ ] `--scan` prints a candidate mapping the user can confirm
- [ ] `--verify` fails non-zero on row-parity or dangling-storage mismatch
- [ ] Default (no opt-in) import behaviour unchanged
- [ ] `from-convex.mdx` + `--help` document the opt-in and the mapping file
- [ ] Platform-parity row above reflects the shipped surface; `api:update` run
      if any export changed

## 8. Risks & STOP conditions

- **STOP** if a blob cannot be verified before write and the design is tempted
  to "import what we got" — unverified bytes make the whole migration
  untrustworthy; re-scope to signed-PUT upload (via the existing
  `GET /_lunora/admin/storage/url` minter) rather than relaxing verification.
- **STOP** if content-hash remapping cannot be made unambiguous with the mapping
  file (a doc whose mapped column holds a value matching no `_storage` id is
  only ever reported, never guessed). If guessing creeps in, re-scope to
  preserve-id keys.
- **Risk:** large blobs — the admin upload route buffers the whole body under the
  runtime's declared-length guard (`storage-admin-routes.ts:117`). A
  multi-hundred-MB file may exceed it. Mitigate: the CLI pre-checks each blob's
  declared `size` against the cap and routes oversized blobs through the
  signed-PUT path, and the plan records the cap value at implementation time.
- **Risk:** `MAX_BODY_BYTES` on the import stream caps per-request doc batches —
  unrelated to blobs, but a huge source table means many batches; the existing
  batching already handles this. Perf watch: measure blob throughput on a
  fixture set (100 × 1 MB) — target > 20 MB/s locally; no `__bench__` exists
  for import, so record the measurement in the PR rather than a suite.
- **Risk:** re-import idempotency (Q3) — without a skip-if-present rule, a
  re-run re-uploads everything. Mitigate: `--scan`-style existence probe via the
  list route before upload (cheap), per Q3's answer.

## 9. Open questions (answer during execution)

1. **Idempotency semantics.** On re-import, should an existing object with the
   same key be (a) skipped after a cheap existence probe, (b) skipped only if a
   stored checksum confirms it, or (c) always re-uploaded? Recommend (a) with a
   `--force` re-upload escape hatch.
2. **Legacy id mapping.** Do modern exports still contain pre-1.6 `FileStorageId`
   strings in documents, and if so are they resolvable to a `_storage` row (via
   a legacy `storageId` field) or only detectable by `--scan`? Whatever the
   answer, the map built in phase 1 must index legacy ids too.
3. **Export parity.** Should `lunora export` gain a `--include-blobs` (download
   from R2 to the snapshot layout) so exports round-trip? Out of scope here, but
   decide and record so the format doesn't drift asymmetrically.
4. **`keyPrefix` default.** Empty (bare sha256) or a namespaced default like
   `convex/`? A prefix makes tenant/run attribution in the bucket browser
   trivial; it also changes every key a mapping file must reference. Decide
   before W3.
5. **Verify's FK spot check.** Which relations does it probe — every `v.id()`
   column against its target table, or only columns named in the mapping? Probing
   every `v.id()` is general but slow on wide schemas; scope the default to
   tables present in the export.
