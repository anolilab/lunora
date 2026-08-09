# Plan 313 — Put the long-term backup tier on object storage instead of someone's disk

**Baseline:** `38ffc2ea7` (2026-08-08)
**Status:** PHASES 0-1 + WS5 SHIPPED in #375 (12 commits, three thermo rounds). WS4 deliberately deviated from — see §10. WS6 docs shipped.
**Priority:** P2 · **Effort:** M · **Risk:** MED · **Category:** data/durability

> **Executor instructions**: almost everything this needs already exists — the
> export/import admin endpoints, the NDJSON snapshot format, the manifest, R2
> typed buckets, cron triggers. The work is a destination, not a format. If you
> find yourself designing a snapshot format, stop and re-read §2.
>
> **Drift check (run first)**: `packages/cli/src/commands/backup/handler.ts` —
> confirm `create` still writes through `node:fs/promises` to `--dir`. If it
> already writes to a bucket, this plan has been done.

## 0. Headline finding

`lunora backup` already ships two tiers, and its own docblock names them:

- **In-place**: `pitr` drives the platform's Durable Object change log to restore
  a shard to any moment in the last 30 days. No R2 read, no snapshot replay.
- **Off-platform / portable / >30 days**: `create` exports every table to a
  timestamped NDJSON file and records it in `manifest.json`; `restore <id|file>`
  imports one back.

**The second tier writes to `--dir` (default `.lunora-backups`) via
`node:fs/promises`.** Its durability is therefore whatever disk the CLI happened
to run on, and the documented way to automate it is "schedule `create` (CI cron,
or a cron-triggered action)". So the tier that exists precisely for the case
where the platform's own 30-day window cannot help you depends on an external
machine, its disk, and a cron nobody monitors.

The fix is a destination, not a redesign: write the same snapshot to R2, and let
the platform schedule it itself.

## 1. Current state (audit)

Verify each before building on it:

- `packages/cli/src/commands/backup/handler.ts` — `create`/`list`/`restore` over
  `mkdir`/`writeFile`/`readFile`; `MANIFEST_FILE` in the backup directory.
- The admin export/import endpoints the CLI drives (`exportShard` / `importShard`
  in `packages/do/src/shard-do.ts`). **Note both were touched by plan 265**:
  admin results now go through `adminResponse` (`encodeWire`) and ingress through
  `decodeAdminArgs`, which is what makes a `v.bigint()`/`v.bytes()` column
  survive a snapshot at all. Confirm a round-trip of both types before trusting
  any new destination.
- `@lunora/storage` — typed R2 buckets and signed URLs. This is the write path;
  do not reach for the S3 API.
- `@lunora/scheduler` — `runAfter`/`runAt` plus cron triggers, for phase 2.
- Snapshot blob support shipped in plan 304 (`_storage` blobs, content-hash R2
  keys, `--verify`). Read how it addresses R2 — the key scheme and the
  checksum-verified upload route are precedent to reuse, not to re-invent.

## 2. Existing seams (do not reinvent)

The NDJSON snapshot format, the manifest shape, the export/import endpoints and
the R2 binding all exist. What does not exist is a bucket-backed implementation
of the three verbs and a schedule that runs inside the platform.

Plan 304's admin storage upload route is the model for getting bytes into R2
with a checksum, and it deliberately avoided minting new credentials. Follow
that: no new auth surface for this.

## 3. The behavioural contract to preserve

- **A snapshot written to R2 must restore byte-for-byte identically to one
  written to disk.** Same format, same manifest semantics, one destination
  abstraction — not two code paths that drift. Two implementations of one
  encoding is the defect this repo produced three times running.
- **`pitr` is untouched.** It is the in-place tier and shares nothing with this.
- **Restore stays explicit.** No automatic restore, ever.
- **A failed upload must fail the command**, not leave a manifest entry pointing
  at an object that is not there. Manifest write happens after the object lands.

## 4. Design decisions

1. **R2 is a destination, not a replacement.** `--dir` keeps working; a bucket is
   selected by a new flag/config. A local snapshot is still the right answer for
   "pull production down to my laptop".
2. **One destination interface with two implementations** (fs, R2), chosen once
   at the top of each verb. `create`, `list` and `restore` must not each learn
   about buckets.
3. **The manifest lives beside the snapshots**, in the same bucket and prefix, so
   a bucket is self-describing and `list` is one read. Do not split the index
   into a second store.
4. **Retention is explicit**, not clever: a `--keep <n>` / age-based prune the
   operator invokes or schedules. No silent deletion of anything.
   **Amended 2026-08-09 — this is not what shipped.** `backupRetain` still
   deletes inside the cron run. It only prunes snapshots carrying its own
   cron expression and keeps anything ambiguous, so it is safe, but it is
   narrower rather than explicit. §10 has the reasoning; WS4 remains open
   and is the work that would make this decision true.
5. **Phase 2's scheduled backup runs in-platform** (cron trigger → action →
   export → R2), which is the point of the plan: no external machine in the
   durability path.

## 5. Workstreams

| #   | Work                                                                                                                                                  | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Destination interface + fs implementation refactored behind it, no behaviour change (`create`/`list`/`restore` identical output)                      | S    |
| 2   | R2 implementation via `@lunora/storage`; bucket/prefix from config or flag                                                                            | M    |
| 3   | `--verify` on restore: checksum the object before importing, mirroring plan 304's verified upload                                                     | S    |
| 4   | Retention (`--keep`, `--older-than`), prune as its own verb so it is never implicit                                                                   | S    |
| 5   | Phase 2 — in-platform scheduled backup: a cron-triggered action that exports and writes to R2, with failures surfaced as issues rather than swallowed | M    |
| 6   | Docs: which tier answers which question (30-day in-place vs long-term portable), and how to restore from a bucket when the CLI machine is gone        | S    |

## 6. Platform parity

| Feature                                | `cloudflare` | `node`   | Notes                                                                                                                                                                                                                   |
| -------------------------------------- | ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backup destination: filesystem         | native       | native   | unchanged; `node:fs` on both                                                                                                                                                                                            |
| backup destination: object storage     | native       | emulated | Cloudflare via the R2 binding; `@lunora/platform-node` already backs object storage with an fs-backed R2 shim, so a "bucket" there is a directory — correct but not a separate failure domain, and the docs must say so |
| in-platform scheduled backup (phase 2) | native       | emulated | needs the host's scheduler; `platform-node` has one, but it is not a shipping target                                                                                                                                    |

No new `ctx.*` surface. If phase 2 adds one, it states its own row here.

## 7. Phasing & ordering

| Phase | Work   | Gate                                                                                                                                                     |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | WS 1   | `create`/`list`/`restore` against a directory produce byte-identical output to `alpha` — assert on the file bytes and the manifest JSON                  |
| 1     | WS 2–3 | A snapshot written to R2 and restored produces the same rows as the same snapshot written to disk, **including a `v.bigint()` and a `v.bytes()` column** |
| 2     | WS 4   | Prune removes exactly the intended objects and updates the manifest; a dry run lists them without deleting                                               |
| 3     | WS 5–6 | A cron-triggered backup lands an object and a manifest entry; a forced failure surfaces rather than passing silently                                     |

## 8. Risks & STOP conditions

- **STOP if the two destinations need different snapshot code.** That means the
  abstraction is in the wrong place — the format must not know where it is going.
- **STOP if restore can run without an explicit target.** A backup tool that can
  guess is a backup tool that can overwrite the wrong environment.
- **Bigint/bytes round-trip is the acceptance test, not an edge case.** Plan 265
  showed `exportShard` returning decoded documents through `jsonResponse` would
  500 on a bigint and flatten bytes to `{}` in a consumer's backup. That is fixed;
  this plan must prove it stays fixed across a new destination.
- **Watch snapshot size against Worker limits** if phase 2 exports from inside a
  Worker rather than from the CLI. Streaming to R2 may be required; measure
  before assuming a whole table fits in memory.
- **Do not put credentials in the manifest.** The bucket binding is the auth.

## 9. Open questions (answer during execution)

- Should `list` merge a bucket and a local directory, or refuse to mix? Merging
  is convenient and makes provenance ambiguous.
- Does phase 2 belong in `@lunora/scheduler` as a first-party cron, or as a
  documented recipe an app opts into? A framework that silently schedules writes
  to a customer's bucket is a surprise; one that makes it a one-liner is a
  feature.
- Is there an interaction with `pitr` worth surfacing — e.g. `backup create`
  recording the current PITR bookmark alongside the snapshot, so an operator can
  see which of the two tiers is the better restore point for a given moment?

## 10. Execution record and one deviation (2026-08-08)

Phases 0–1 shipped as designed: a `BackupDestination` seam with filesystem and R2
implementations, `restore --verify`, and a `GET /_lunora/admin/storage/object`
read route so a bucket restore does not depend on URL signing.

**WS5 shipped too, outside the phasing it was given.** Reviewing both writers side
by side surfaced that the scheduled backup recorded no checksum, so
`restore --verify` refused precisely the snapshots nobody watches being taken.
That is worth recording: the in-platform tier was the one that most needed the
guarantee and the one that lacked it.

### The deviation: retention is implicit, and §4.4 said it would not be

§4.4 states _"Retention is explicit, not clever … **No silent deletion of
anything**"_, and WS4 scopes _"prune as its own verb so it is never implicit"_.
What shipped keeps `backupRetain` deleting inside every cron run. The writer
check added in review makes that deletion **narrower**, not **explicit**.

This is the single largest gap between the plan and the branch, and it is the
area that produced the branch's worst defect — an early revision deleted
operator-taken snapshots, because unifying the key layout (which is what makes
`list --bucket` one history) also made the two writers indistinguishable to the
existing prune. The feature and the bug were the same decision.

Retention now matches on the cron expression, stamped as object custom metadata
and read off the listing, so two deployments sharing a prefix keep the retention
each configured and pre-marker sidecars are never pruned. That is safe. It is
still not what §4.4 promised.

**Left open deliberately**, as either a follow-up plan or a WS4 phase: a `prune`
verb with a dry run, so the destructive step is something an operator invokes
and can preview rather than a side effect of a backup succeeding.

### Three rounds of review, and the pattern worth carrying forward

Each round found something the previous had declared clean, and every one was in
the remediation rather than the original work. The recurring defect was not stale
comments — it was **a claim about a second party's behaviour that was never
checked against the second party**: a guard documented as preventing an OOM it
could not prevent (the export fan-out resolves every shard's rows before the
first byte is encoded); an upload documented as checksum-verified above the size
where the verified route stops being used; remediation text telling an operator
to pass `createStorage(...).download` where the two signatures share no
properties and the assignment does not compile.

The tests that now guard these were written by asking what the _class_ would look
like: a tier-parity test comparing `id` values and derived keys across both
writers, and a retention test seeding a foreign deployment's snapshot under the
shared prefix.
