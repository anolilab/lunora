# Plan 435: [Spike] Design the portability-budget leg of the platform conformance TCK

> **Executor instructions**: This is a DESIGN SPIKE — the deliverable is a
> design document plus an inventory, NOT implementation. Do not modify any
> source file. Follow the steps, then write the design doc as specified. If
> anything in the "STOP conditions" section occurs, stop and report. Your
> reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/platform/src packages/platform-cloudflare/src/cloudflare-host.ts packages/platform-node/src/node-socket-host.ts`
> On drift, re-verify the excerpts below before writing the doc.

## Status

- **Priority**: P2
- **Effort**: M (spike)
- **Risk**: LOW (no code ships from this plan)
- **Depends on**: none
- **Category**: direction / tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The platform contracts document portability budgets that only one host enforces. Example: `packages/platform/src/socket-host.ts:32-41` tells portable callers to assume "at most 9 usable tags, each bounded to at most 256 characters", and concedes that an over-budget `accept` "fails loudly on the host that enforces it … rather than passing silently on hosts with no cap". Enforcement reality: `assertWithinTagBudget` exists **only inside** `packages/platform-cloudflare/src/cloudflare-host.ts:401` (called at `:476`); `packages/platform-node/src/node-socket-host.ts`'s `accept` checks nothing; and the TCK's only budget leg (`packages/platform/src/conformance/suite.ts:387` — "accepts the portable budget of nine caller tags") proves the floor, never the ceiling. So a developer on the Node host can ship 12 tags or a 400-character tag, pass the TCK, and discover the failure on Cloudflare — the exact class of contract drift the repo's platform-parity policy exists to prevent, and the repo already knows the right shape: `WORKERD_SQLITE_LIMITS` (`packages/shard-engine/src/drizzle.ts`, enforced in `do-exec.ts` for every host) makes workerd's SQLite caps host-independent at the engine layer.

## Current state

- Contract text: `packages/platform/src/socket-host.ts:32-41` (the 9×256 budget, quoted above).
- Cloudflare-only enforcement: `assertWithinTagBudget` local to `cloudflare-host.ts` with its own regression file `cloudflare-host.tag-budget.test.ts`.
- Node host: `node-socket-host.ts:157-180` `accept` — no budget check.
- TCK: `conformance/suite.ts:378-390` — a comment calling the nine-tag case "a regression fence, not a bug reproduction", asserting acceptance only.
- Precedent: `WORKERD_SQLITE_LIMITS` consumed by `do-exec.ts:37-40` and `ctx-db-companions.ts:253` — the engine refuses over-limit SQL on every host, so `better-sqlite3` deployments cannot pass what workerd would refuse.
- `@lunora/platform` is zero-dependency and snapshot-gated (`api-snapshots/platform.api.md`); the eventual helper must live there without adding deps.

## Commands you will need

| Purpose                      | Command                                     | Expected on success |
| ---------------------------- | ------------------------------------------- | ------------------- |
| Install                      | `pnpm install`                              | exit 0              |
| Read-only test run (context) | `pnpm --filter "@lunora/platform" run test` | all pass            |

## Scope

**In scope** (the only files you may create):

- `plans/435-budget-tck-design.md` — the design doc (deliverable)

**Out of scope**:

- ANY source or test file. This spike writes one markdown document.

## Git workflow

- Branch: `improve/wave22-platform`
- Commit: `docs(platform): budget-TCK spike design`

## Steps

### Step 1: Inventory the documented budgets

Read the three contract files end to end — `packages/platform/src/socket-host.ts`, `shard-host.ts`, `scheduler-host.ts` (plus `shard-kv-store.ts` / `shard-directory.ts` if they document caps) — and table every numeric budget/cap/limit the prose commits to: value, contract location, which hosts enforce it today (grep each `packages/platform-*` adapter), and which layer could enforce it host-independently (contract helper vs engine, per the `WORKERD_SQLITE_LIMITS` precedent).

**Verify**: the table names ≥ the tag-count and tag-length budgets, and every row has an "enforced by" answer (including "nobody").

### Step 2: Classify each budget

For each row, recommend one of:

- **Contract-enforced**: a shared zero-dep `assertWithin*` helper in `@lunora/platform`, called by every adapter's entry point, plus a TCK leg asserting _refusal_ of an over-budget call on every host.
- **Engine-enforced**: belongs beside `WORKERD_SQLITE_LIMITS` (already host-independent) — note it and move on.
- **Advisory**: genuinely Cloudflare-only semantics where refusing on other hosts would be wrong — justify in one sentence each.

### Step 3: Write the design doc

`plans/435-budget-tck-design.md` containing: the inventory table; the proposed helper signatures (moving `assertWithinTagBudget` from `cloudflare-host.ts` into `@lunora/platform` is the expected first candidate — the Cloudflare adapter then imports it, deleting its local copy); the new TCK legs (name each `it(...)` and which existing suite section it extends); the migration note for `platform-node`'s reference host and TCK doubles; and an **Open questions** section (at minimum: is refusing 10+ tags on Node a breaking change for any current Node-host user? does the reference `node:sqlite` host in `/conformance` need the same legs? how does the `api:check` snapshot move?).

**Verify**: the doc exists, and a reader could implement the follow-up plan from it without re-reading this spike's sources.

## Test plan

None — no code. The doc's TCK-leg section IS the future test plan.

## Done criteria

- [ ] `plans/435-budget-tck-design.md` exists with inventory + classification + helper design + TCK legs + open questions
- [ ] `git status` shows only that one new file
- [ ] Every budget in the inventory has an enforcement answer and a recommendation

## STOP conditions

- The contracts document fewer than two budgets (the premise shrinks — report what you found instead of padding).
- You find yourself editing source "while you're in there" — this plan forbids it.

## Maintenance notes

- The follow-up implementation plan should be filed as its own numbered plan referencing the design doc; its risk section must cover the behavior change for `platform-node` users (over-budget calls that used to succeed will refuse).
