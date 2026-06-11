# Plan 002: Guard the shared template scaffold files against drift

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 491e6314..HEAD -- templates/ tests/vis-templates/`
> Note: the earlier uncommitted template edits have since been committed, but
> the byte-identity invariant below was re-confirmed to still hold at commit
> `491e6314` (one unique md5 across all 8 `messages.ts`, one across all 8
> `schema.ts`). Step 1 re-verifies it regardless before writing the test.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / tech-debt
- **Planned at**: commit `491e6314`, 2026-06-11 (identity invariant re-confirmed at this SHA)

## Why this matters

All 8 project templates under `templates/` ship the same demo backend: each
has a `cirrus/` directory containing `messages.ts` and `schema.ts` that are
**byte-for-byte identical** across all 8 templates (verified by md5 at
planning time: one unique hash for all 8 `messages.ts`, one for all 8
`schema.ts`). Every change to this scaffold is currently a manual 8-way
copy-paste (git history shows repeated lockstep commits touching all 8), and
nothing stops a contributor from editing one copy and silently diverging the
rest. A cheap test that asserts the identity invariant turns silent drift into
a red CI run and documents the invariant for contributors.

## Current state

- `templates/<fw>/cirrus/` for `fw` in `astro, nuxt, react-router,
  solid-start, standalone, sveltekit, tanstack-start, vite` — each contains
  exactly two files, `messages.ts` and `schema.ts` (confirmed by `ls` for
  `standalone` and `sveltekit`; re-confirm for all 8).
- `tests/vis-templates/__tests__/templates.test.ts` — the existing static
  template-validation suite. It reads every `templates/<framework>/package.json`
  with `node:fs` and asserts invariants (the `{{name}}` placeholder contract,
  `@cirrus/*` deps name real packages, the `^0.0.0` registry contract,
  framework majors via a `LATEST_MAJORS` manifest). Its header comment says it
  is "the guardrail that replaces" in-repo type-checking of templates. It does
  **not** look at `cirrus/` file contents. Use this file as the structural
  exemplar — plain `readdirSync`/`readFileSync` + vitest `describe`/`test`,
  repo-root resolution via:

  ```ts
  // tests/vis-templates/__tests__/templates.test.ts:31
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const TEMPLATES_DIR = join(REPO_ROOT, "templates");
  ```

- `tests/vis-templates/package.json` — package name is
  `@cirrus/vis-templates-tests`, test script is `vitest run`.
- Repo conventions: TypeScript ESM, **no `.js` extensions on relative
  imports**, vitest, `__tests__/` directory, conventional commits.

## Commands you will need

| Purpose   | Command                                                        | Expected on success |
| --------- | -------------------------------------------------------------- | ------------------- |
| Install   | `pnpm install`                                                 | exit 0              |
| Run suite | `pnpm --filter "@cirrus/vis-templates-tests" run test`         | all tests pass      |
| Typecheck | `pnpm --filter "@cirrus/vis-templates-tests" run lint:types`   | exit 0              |

## Scope

**In scope** (the only files you should modify/create):

- `tests/vis-templates/__tests__/scaffold-drift.test.ts` (create)

**Out of scope** (do NOT touch):

- The templates themselves (`templates/**`) — if the identity assertion fails
  on the live tree, that is a STOP condition, not something to "fix" by
  editing templates.
- `tests/vis-templates/__tests__/templates.test.ts` — leave the existing suite
  alone; the new invariant gets its own file.
- Any generator under `.vis/templates/` — building a sync *mechanism* is a
  possible follow-up, deliberately not in this plan.

## Git workflow

- Branch: `test/template-scaffold-drift` off `alpha`.
- Commit style: conventional commits, e.g. `test(templates): assert cirrus scaffold identity across templates`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Re-verify the invariant on the live tree

Run:

```sh
md5 -q templates/*/cirrus/messages.ts | sort -u | wc -l
md5 -q templates/*/cirrus/schema.ts  | sort -u | wc -l
```

**Verify**: both print `1`. If either prints more than 1, STOP (see below).

### Step 2: Write the drift test

Create `tests/vis-templates/__tests__/scaffold-drift.test.ts`:

- Resolve `TEMPLATES_DIR` exactly as `templates.test.ts` does (excerpt above).
- Discover template directories dynamically (same `listDirectories` approach
  as the existing test — do not hard-code the 8 names, so a new template is
  automatically covered).
- Designate `templates/standalone/cirrus/` as the **canonical copy** (it is
  the minimal worker-only template).
- For each shared scaffold file (`messages.ts`, `schema.ts` — derive the list
  from `readdirSync` of the canonical dir so a new shared file is auto-covered):
  - assert every other template has the file,
  - assert its contents (`readFileSync(..., "utf8")`) strictly equal the
    canonical copy's contents.
- Make the failure message actionable, e.g.:
  `templates/<fw>/cirrus/<file> differs from the canonical copy in templates/standalone/cirrus/<file>. The cirrus/ scaffold is intentionally identical across all templates — apply your change to every template (or update the canonical copy and propagate).`
- Add a short header comment explaining the invariant and pointing at this
  plan's rationale (manual 8-way sync; test exists to catch a forgotten copy).

**Verify**: `pnpm --filter "@cirrus/vis-templates-tests" run test` → all pass,
including the new file.

### Step 3: Prove the test bites

Temporarily append a comment line to `templates/vite/cirrus/schema.ts`, rerun
the suite, confirm the new test **fails** with the actionable message, then
revert the temporary edit (`git checkout -- templates/vite/cirrus/schema.ts`
— but first check `git status`: if that file already had uncommitted changes
before your edit, undo your line manually instead of checking out).

**Verify**: suite fails during the tamper, passes after revert;
`git status` shows `templates/` unchanged relative to before Step 3.

## Test plan

The deliverable *is* a test. Cases it must cover (all in the one file):

- identity of every shared `cirrus/` file across all discovered templates,
- a missing `cirrus/<file>` in any template fails (covered by the
  has-the-file assertion),
- new templates and new shared files are picked up without editing the test
  (dynamic discovery — assert at least 2 files and at least 8 templates were
  compared so silent under-discovery fails loudly).

## Done criteria

- [ ] `tests/vis-templates/__tests__/scaffold-drift.test.ts` exists and passes
- [ ] Tamper check (Step 3) demonstrated failure and was reverted
- [ ] `pnpm --filter "@cirrus/vis-templates-tests" run test` exits 0
- [ ] `pnpm --filter "@cirrus/vis-templates-tests" run lint:types` exits 0
- [ ] `git status` shows no changes outside the in-scope file
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 shows the files are **not** identical on the live tree — the
  in-progress template edits may have intentionally diverged them; the
  invariant needs maintainer confirmation before being encoded in a test.
- `templates/<fw>/cirrus/` contains files other than `messages.ts`/`schema.ts`
  in some templates but not others (the "shared file set" assumption is wrong).
- The vis-templates test package fails to run for environmental reasons you
  cannot fix with `pnpm install`.

## Maintenance notes

- When the scaffold legitimately changes, contributors must update all
  templates; this test is the reminder. If that 8-way edit becomes frequent,
  the follow-up is a sync script (single canonical source + a
  `scripts/sync-template-scaffold` copier) — deferred because the invariant
  test alone removes the *silent* failure mode at ~5% of the cost.
- If a future template intentionally needs a *different* demo backend, the
  test needs an explicit exclusion list — add one with a comment, don't
  delete the test.
