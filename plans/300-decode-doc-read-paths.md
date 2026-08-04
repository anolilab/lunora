# Plan 300 — Decode wire-tagged doc columns on the three display read paths

**Baseline:** `071c6a29c` (2026-08-01)
**Status:** DONE — `advisor/300-decode-doc-read-paths`, stacked on 265.

Outcome, including the two places this plan was wrong (S3's premise, and S2
being a one-liner) and the answers to §9, is recorded in this plan's row in
[`README.md`](./README.md).

> **Executor instructions**: follow this plan step by step, run every verification
> command, and confirm the expected result before moving on. If a STOP condition
> in §8 occurs, stop and report — do not improvise. When done, update this plan's
> row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 071c6a29c..HEAD -- packages/shard-engine/src/introspect.ts packages/studio/src/features/data/hooks/use-data-browser.tsx packages/studio/src/features/payments/payments-panel.tsx`

## 0. Headline finding

Plan **265** made `v.bigint()` and `v.bytes()` storable on the Durable Object row
store by routing the `__doc__` column through `shared/wire-codec.ts` at a single
encode/decode choke point (`packages/shard-engine/src/do-sql.ts`). Three
**display-only** read paths parse `__doc__` themselves rather than going through
that choke point, so a row carrying a bigint or bytes column renders as the raw
tagged form — e.g. `["$lunora.wire$","bigint","1000"]` — instead of the value.

**This is not a regression.** Before 265 such a row could not be written at all
(`JSON.stringify` throws on a bigint), so no existing deployment has one. It is
an incomplete UI for a capability that just became possible. It matters because
the capability's headline consumer is the money path: `@lunora/payment`'s
`paymentSessions.amountMinor` / `capturedMinor` / `refundedMinor` are `v.bigint()`
on a shard-local table, and the Studio payments panel is exactly one of the three
paths.

## 1. Current state (audit)

Each of these parses the stored document itself instead of using
`decodeDocJson` (exported from `packages/shard-engine/src/do-sql.ts` by plan 265):

- `packages/shard-engine/src/introspect.ts` — `expandDocumentRows` /
  `safeParseObject`, backing the SQL console and the data-browser row expansion.
- `packages/studio/src/features/data/hooks/use-data-browser.tsx` — `rowDocument()`,
  which prefills the edit form.
- `packages/studio/src/features/payments/payments-panel.tsx` — `readField()` at
  ~`:38`, used for the money columns.

Read each of the three yourself and confirm the parse site before changing it;
the line numbers above are leads, not facts.

## 2. Existing seams (do not reinvent)

- **`decodeDocJson`** (`packages/shard-engine/src/do-sql.ts`) — the decode half of
  265's pair. This is the function to route through. Do **not** write a second
  decoder, and do **not** call `decodeWire` directly if `decodeDocJson` already
  wraps it with the behaviour these callers need.
- `@lunora/studio` already depends on `@lunora/shard-engine` — verify with
  `node -e 'console.log(require("./packages/studio/package.json").dependencies)'`
  before assuming the import is free. If it is **not** a dependency, that is a
  design decision to record in §4, not a dependency to add silently.

## 3. The behavioural contract to preserve

- A document containing **no** wire-tagged leaves must render exactly as it does
  today. 265's byte-identity property means the overwhelming majority of rows are
  plain JSON; this change must be invisible for them.
- The edit-form prefill (`use-data-browser.tsx`) round-trips: whatever it decodes
  for display must still **write back** correctly through the normal writer. A
  decode that produces a value the writer then re-encodes differently would
  corrupt the row on save. This is the sharpest risk in the plan.
- Display code must not throw on a malformed/legacy document — the existing
  `safeParseObject` naming suggests a deliberate non-throwing contract. Preserve it.

## 4. Design decisions

**Decode at the read boundary, not in the components.** One shared decode call per
read path, so a fourth display surface added later inherits it rather than
re-deriving it. The alternative — formatting the tagged array in each component —
was rejected: it spreads knowledge of the wire format into the UI layer.

**Bytes render as a summary, not as raw content.** A decoded `ArrayBuffer` has no
useful string form; render something like `<bytes: N>` rather than dumping it.
Decide the exact form and record it here.

## 5. Workstreams

- **S1 (S)** — `introspect.ts`: route `expandDocumentRows`/`safeParseObject`
  through `decodeDocJson`, preserving the non-throwing contract.
- **S2 (S)** — `use-data-browser.tsx`: decode in `rowDocument()`; prove the
  edit → save round-trip in a test before considering it done.
- **S3 (S)** — `payments-panel.tsx`: decode in `readField()` so the money columns
  render as numbers.

## 6. Platform parity

**Not applicable.** No `ctx.*` surface, binding, or deploy capability changes —
this is display-side decoding of a column whose storage format plan 265 already
settled. No `PlatformCapabilities` row changes.

## 7. Phasing & ordering

| Phase | Work | Gate                                                                        |
| ----- | ---- | --------------------------------------------------------------------------- |
| 1     | S1   | `pnpm --filter "@lunora/shard-engine" run test` green + new introspect test |
| 2     | S2   | studio tests green + the round-trip test from §3                            |
| 3     | S3   | studio tests green + a payments-panel render test over a bigint column      |

**Depends on plan 265** (`advisor/265-do-bigint-bytes-roundtrip`) — `decodeDocJson`
does not exist without it. If that branch is not merged, branch from it.

## Commands you will need

| Purpose   | Command                                                | Expected |
| --------- | ------------------------------------------------------ | -------- |
| Install   | `pnpm install`                                         | exit 0   |
| Build     | `vis run build --query "project=@lunora/shard-engine"` | exit 0   |
| Tests     | `pnpm --filter "@lunora/shard-engine" run test`        | all pass |
| Tests     | `pnpm --filter "@lunora/studio" run test`              | all pass |
| Typecheck | `pnpm --filter "@lunora/studio" run lint:types`        | exit 0   |

## Scope

**In scope:** the three files named in §1, plus their tests.

**Out of scope:**

- `packages/shard-engine/src/do-sql.ts` and every write path — 265 settled those.
- Any change to the wire format itself.
- `@lunora/payment`'s schema — the columns are correct as declared.

## Git workflow

- Branch: `advisor/300-decode-doc-read-paths` (branch from 265's branch if unmerged)
- Conventional commits, e.g. `fix(studio): decode wire-tagged doc columns for display`

## Test plan

Every new test must be demonstrated to **fail before** the change (check out the
base version of the file, run, observe failure, restore).

1. `introspect` — a row with a bigint column expands to the numeric/string value,
   not the tagged array.
2. `use-data-browser` — **the round-trip**: decode a bigint row for the edit form,
   save it unchanged, assert the stored `__doc__` is byte-identical to before.
3. `payments-panel` — a `paymentSessions` row with `amountMinor` renders the
   amount, not `["$lunora.wire$",…]`.
4. **No-regression**: a plain-JSON row renders identically before and after.

## Done criteria

- [ ] All three read paths route through `decodeDocJson` (grep each file)
- [ ] `pnpm --filter "@lunora/shard-engine" run test` exits 0
- [ ] `pnpm --filter "@lunora/studio" run test` exits 0
- [ ] `pnpm --filter "@lunora/studio" run lint:types` exits 0
- [ ] The §3 round-trip test exists and passes
- [ ] Each new test demonstrated to fail before the change
- [ ] No files outside §1 modified (`git status`)
- [ ] If `packages/studio` gained a dependency, `pnpm run lint:package-json` exits 0
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if decoding in `use-data-browser.tsx` breaks the edit→save round-trip
  and cannot be fixed inside the three in-scope files. Corrupting a row on save is
  far worse than displaying a tagged array; report rather than work around it.
- **STOP** if `@lunora/studio` does not already depend on `@lunora/shard-engine`.
  Adding a package dependency to fix a display string is a decision for the
  maintainer, not an executor — report and propose the alternative (re-export the
  decoder from a package studio already depends on).
- **Risk:** over-decoding. `decodeDocJson` revives `Date`, `Map`, `Set` and typed
  arrays too, so a display path may start receiving richer types than its
  formatter expects. Mitigate by asserting the plain-JSON no-regression case.

## 9. Open questions (answer during execution)

1. What is the right display form for a decoded `ArrayBuffer` — byte length,
   a hex prefix, or a download affordance?
2. Should `introspect.ts`'s SQL-console output decode at all, or is the raw
   stored form actually the more honest thing to show in a SQL console
   specifically (where the user asked to see the database, not the model)?
