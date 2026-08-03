# Plan 302 — The repo lint gate reports success for ten projects it never runs

**Baseline:** `ab0afaf00` (2026-08-03)
**Status:** PHASE 1 DONE (root cause + the two clean packages) — phases 2+ TODO
**Priority:** P1 · **Effort:** M–L · **Risk:** LOW (per package) · **Category:** ci/tech-debt

> **Executor instructions**: follow this plan step by step, run every verification
> command, and confirm the expected result before moving on. If a STOP condition
> in §8 occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: re-derive the skip list (§1). If a package no
> longer appears, someone has already un-skipped it — check its lint is green
> rather than assuming.

## 0. Headline finding

`pnpm run lint:eslint` prints a green tick for ten projects **it never lints**:

```
> advisor:lint:eslint
✓  advisor:lint:eslint (13 ms)
No command configured for advisor:lint:eslint
```

13 ms is not a lint run. All ten define a real `lint:eslint`
(`eslint . --max-warnings=0`) in their own `package.json`, and running them
directly turns up **523 errors across 8 of them**.

CI's required status context is that aggregate run, so none of it gates
anything. This was found while executing plan 290: un-crashing advisor's linter
moved it from exit 2 to exit **1**, and chasing why the repo run stayed green
led here.

## 1. Root cause (verified)

It is a config-shape mismatch, and it is the *opposite* of the obvious guess —
the projects that fail are the ones carrying **more** configuration.

`packages/server/project.json` — one of the 48 that work — declares no targets
at all, so vis falls back to the `package.json` script:

```json
{ "name": "server", "tags": ["type:package", "category:runtime"] }
```

`apps/studio/project.json` declares a target in **vis's** shape, with a
top-level `command`, and runs correctly (5.2 s of real work in the repo run):

```json
"lint:eslint": { "cache": true, "inputs": [...], "command": "eslint ." }
```

`packages/advisor/project.json` declares the same target in **nx's** shape —
`executor` plus the command nested under `options`:

```json
"lint:eslint": {
    "executor": "nx:run-commands",
    "options": { "cwd": "{projectRoot}", "command": "eslint --config {workspaceRoot}/eslint.config.js ." },
    "cache": true,
    "inputs": ["default", "{workspaceRoot}/eslint.config.js"]
}
```

vis looks for a top-level `command`, finds none, and reports
`No command configured` — **as a success**. The declared target shadows the
`package.json` script that would otherwise have run.

Two further facts confirm these blocks are stale nx leftovers rather than
intentional config:

- The nested command is `eslint --config {workspaceRoot}/eslint.config.js .`,
  and **there is no root `eslint.config.js`** in this repo (configs are
  per-package). It could never have worked even if the executor were understood.
- It drops `--max-warnings=0`, which the `package.json` script has.

**Not a bug**: `packages/lunora/project.json` also has a `targets` block, but it
is config-only (`cache` / `dependsOn` / `inputs`, no `executor`, no `command`),
which vis merges onto the `package.json` script. `lunora:test` runs normally.
Only `executor`-bearing targets are affected — do not strip config-only blocks.

Derivation (do not trust a stale list):

```bash
for f in packages/*/project.json apps/*/project.json; do
  node -e "const t=require('./$f').targets||{};
    const nx=Object.keys(t).filter(k=>'executor' in t[k]);
    if(nx.length) console.log('$f', nx.join(','))"
done
```

## 2. Existing seams (do not reinvent)

- The 48 packages with a bare `{name, tags}` `project.json` are the working
  reference shape. Deleting an `executor`-bearing `targets` block restores that
  fallback — no new config to write.
- `apps/*/project.json` show the alternative (vis-native `command`). Either
  works; deletion is smaller and keeps `--max-warnings=0`.

## 3. The behavioural contract to preserve

- Un-skipping a package must not leave the repo lint red. Every phase below
  lands a package **only once its own lint is green**.
- `--max-warnings=0` stays in force (it comes from the `package.json` script).
- Config-only `targets` blocks (`packages/lunora`) are untouched.
- No ESLint **rule** is turned off to make a package pass. Suppression is a
  reviewed, per-finding decision, not a way to clear the backlog.

## 4. Design decisions

**Delete the `executor` blocks; don't port them to vis syntax.** The command
inside them is broken (nonexistent root config) and weaker (no
`--max-warnings=0`), so porting would preserve a mistake. Deletion falls back to
the manifest script, matching 48 of 58 projects.

**Land it package-by-package, gated on that package's own cleanup.** This is
the whole shape of the plan. Un-skipping all ten at once turns the repo lint red
with 523 errors and blocks every PR until the cleanup finishes. Un-skipping one
package at a time keeps the gate green at every commit and makes each cleanup
reviewable on its own.

Rejected: **turning the errors into warnings** to land the gate fix
immediately — `--max-warnings=0` means that changes nothing, and relaxing it
would re-create the same "green but not checked" illusion this plan exists to
remove.

## 5. Workstreams

### Phase 1 (S) — DONE

Root cause above; `platform-node` and `ratelimit` un-skipped, since both were
already clean. Verified each now actually runs:
`pnpm exec vis run lint:eslint --query "project=<p>"` → runs, exit 0, and the
`No command configured` line is gone.

### Phases 2–9 (one per package, S–L) — TODO

Fix the package's lint errors, then delete its `targets` block in the same
commit, so the gate and the cleanup land together:

| Phase | Package     | Errors | Notes                                                                  |
| ----- | ----------- | ------ | ---------------------------------------------------------------------- |
| 2     | `container` | 3      | Smallest — do this one first to prove the shape                        |
| 3     | `auth`      | 7      |                                                                        |
| 4     | `vue`       | 7      |                                                                        |
| 5     | `advisor`   | 21     | Needs plan 290 merged first, or the run crashes before reporting       |
| 6     | `svelte`    | 24     |                                                                        |
| 7     | `db`        | 40     |                                                                        |
| 8     | `ai`        | 118    |                                                                        |
| 9     | `replica`   | 303    | Largest by far; flagged as far back as wave-13 plan 146 ("pre-existing ESLint errors") |

Counts are from `pnpm --filter "@lunora/<pkg>" run lint:eslint` at baseline and
will drift — re-measure before starting a phase.

### Phase 10 (S) — close the hole

Add a check that fails when a `project.json` target carries an `executor` key,
so this cannot silently return. The derivation loop in §1 is the check; wire it
into the lint job.

## 6. Platform parity

**Not applicable.** Build/CI configuration only — no `ctx.*` surface, binding,
or deploy capability changes.

## 7. Phasing & ordering

Phase 1 first (done). Phase 5 (`advisor`) requires plan **290** merged. Phases
2–4 and 6–9 are independent of each other and of 290; take them in ascending
error count so the shape is proven on small ones. Phase 10 last, once no
`executor` block remains.

## Commands you will need

| Purpose            | Command                                                        | Expected                          |
| ------------------ | -------------------------------------------------------------- | --------------------------------- |
| Per-package lint   | `pnpm --filter "@lunora/<pkg>" run lint:eslint`                | exit 0 before un-skipping         |
| Prove it runs      | `pnpm exec vis run lint:eslint --query "project=<pkg>"`        | runs; no `No command configured`  |
| Whole-repo gate    | `pnpm run lint:eslint`                                         | exit 0                            |
| Re-derive the list | §1 loop                                                        | shrinks by one per phase          |

## Scope

**In scope:** the ten `packages/*/project.json` files carrying an
`executor`-bearing `targets` block, and the source fixes needed to make each
package's own lint pass.

**Out of scope:**

- `packages/lunora/project.json` — config-only block, correct as-is
- `apps/*/project.json` — they run; see §9.2 for the smaller issue there
- Any ESLint rule change or `--max-warnings` relaxation
- The `codegen` "no command configured" lines — those are genuine no-ops for
  packages without a codegen step, and vis says so explicitly

## Test plan

Per phase: the package's lint exits 0 **and** `vis run lint:eslint` for it
prints no `No command configured` line **and** the whole-repo lint still exits
0. The middle one is the load-bearing check — without it a phase could "pass"
by still being skipped.

## Done criteria

- [ ] The §1 derivation loop prints nothing
- [ ] `pnpm run lint:eslint` exits 0 with no `No command configured for
      <project>:lint:eslint` line for any project
- [ ] Each of the ten packages verified to actually run under vis
- [ ] Phase 10 check in place and failing on a reintroduced `executor` block
- [ ] No ESLint rule disabled to reach green

## 8. Risks & STOP conditions

- **STOP** if a package's errors cannot be fixed without disabling a rule or
  changing behaviour. Report it; do not un-skip that package (leaving it skipped
  is the status quo, and honest once recorded here) and do not disable the rule
  to make the phase close.
- **STOP** if removing a `targets` block changes anything other than lint — the
  same blocks carry `cache`/`inputs`, and a package whose caching or task
  dependencies visibly change needs the vis-native `command` shape instead of
  deletion.
- **Risk:** the 523 count is a moving target; other sessions land code into these
  packages continuously. Re-measure per phase rather than trusting the table.

## 9. Open questions

1. Why did ten projects get nx-shaped targets in the first place — a partial
   migration from nx to vis? If a migration script produced them, it may have
   produced others (only `lint:eslint*` was affected here, but the same script
   could have touched `build`/`test` targets in other repos).
2. `apps/*/project.json` **do** run, but their vis-native command is
   `eslint .` — dropping the `--max-warnings=0` the manifest script carries. So
   the three apps lint with warnings tolerated. Smaller than this plan's bug
   (they are at least checked), but the same class: config that silently weakens
   a gate. Fold into phase 10 or file separately.
3. Should `project.json` exist at all for the 48 packages that only carry
   `{name, tags}`? Out of scope, but the file's only load-bearing content there
   is the tag set.
