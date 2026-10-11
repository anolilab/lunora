# Plan 483: Make the `.dev.vars` create-if-absent exclusive on the final path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d8a41fe8d..HEAD -- packages/config/src/scaffold-dev-variables.ts packages/config/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (security-adjacent: secret-bearing file)
- **Planned at**: commit `d8a41fe8d`, 2026-10-10

## Why this matters

`lunora dev` generates `.dev.vars`, which holds secrets, and the code claims the create is exclusive: a peer process that creates the file between the `existsSync` check and the write must not be overwritten. The implementation does not do that. The `wx` flag is applied only to a **temp file** named `${path}.tmp-${pid}`, and then `renameSync(temp, path)` replaces whatever is at `path`. A peer that wins the race is silently overwritten. The window is small, so impact is LOW, but the stated guarantee is false and the fix is small.

## Current state

- `packages/config/src/scaffold-dev-variables.ts:483-487`:

    ```ts
    // Re-check right before the write: another process may have created the
    // file since the `existsSync` above. If so, bail rather than overwrite the
    // peer's (possibly secret-bearing) file. The `wx` temp write keeps the
    // create exclusive against a peer racing this same path.
    if (existsSync(devVariablesPath)) {
        return { addedKeys: [], generatedKeys: [], status: "skipped-exists" };
    }

    atomicWrite(devVariablesPath, plan.content, { flag: "wx", mode: 0o600 });
    ```

- `packages/config/src/scaffold-dev-variables.ts:319-333` (`atomicWrite`):

    ```ts
    const temporaryPath = `${path}.tmp-${String(process.pid)}`;

    try {
        writeFileSync(temporaryPath, content, { encoding: "utf8", ...options });
        renameSync(temporaryPath, path);
    } catch (error) {
        rmSync(temporaryPath, { force: true });

        throw error;
    }
    ```

- **Check at drift time**: `renameSync` also appears at `scaffold-dev-variables.ts:427` (outside `atomicWrite`, as of the audit it was not covered by the original finding). Read that call site first. If it writes a secret-bearing file, it has the same overwrite and is in scope; if not, leave it.
- Convention: the doc comment above `atomicWrite` correctly states that `rename` preserves the temp file's mode, which is why `mode: 0o600` is set on the temp write. Keep that property.

## Commands you will need

| Purpose       | Command                                                   | Expected on success |
| ------------- | --------------------------------------------------------- | ------------------- |
| Build deps    | `pnpm --filter "@lunora/config..." run build`             | exit 0              |
| Package tests | `pnpm --filter "@lunora/config" run test -- scaffold-dev` | all pass            |
| Typecheck     | `pnpm --filter "@lunora/config" run lint:types`           | exit 0              |
| Lint          | `pnpm --filter "@lunora/config" run lint:eslint`          | exit 0              |

## Platform parity

Not applicable: a local dev-file scaffold; no `ctx.*` surface or binding changes.

## Scope

**In scope**:

- `packages/config/src/scaffold-dev-variables.ts`
- the scaffold-dev-variables test file under `packages/config/__tests__/`

**Out of scope**:

- The generation logic, key selection, or `.dev.vars.example` parsing.
- Any other file that writes secrets.

## Git workflow

- Branch: `advisor/483-dev-vars-exclusive-create`, from `alpha`.
- Subject example: `fix(config): make the dev-variables create exclusive on the final path`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing test for the overwrite

Add a test that uses the existing dependency-injection seam in the scaffold function (the function accepts `deps` with `confirm`, `info`, and `yes`). Simulate the race by making the file appear **after** the `existsSync` check: the simplest way is to spy on `existsSync` for the first call returning `false`, and have the write path create the target file before the rename. If the module's internals cannot be spied this way, instead write the target file from inside a `deps.info` callback that runs before the write, and assert the peer's content is preserved.

Assert: the peer file's content is unchanged and the result status is `skipped-exists`.

**Verify**: `pnpm --filter "@lunora/config" run test -- scaffold-dev` → the new case FAILS on current code (the peer content is overwritten). If it passes, STOP (see STOP conditions).

### Step 2: Use `linkSync` for the final, exclusive step

Change `atomicWrite` so the final step fails if the target exists:

1. Write the temp file as today (`writeFileSync(temporaryPath, content, { encoding: "utf8", ...options })`, with `mode` preserved).
2. Replace `renameSync(temporaryPath, path)` with `linkSync(temporaryPath, path)`. A hard link fails with `EEXIST` when `path` exists, so the create is exclusive.
3. In the `finally`/`catch`, always `rmSync(temporaryPath, { force: true })`, then rethrow on error. On `EEXIST`, map to the `skipped-exists` result at the call site (catch the error where `atomicWrite` is called and return `{ status: "skipped-exists", ... }`), instead of throwing.

Keep the `flag: "wx"` on the temp write; it is still correct for the temp file.

Update the `atomicWrite` doc comment to say the final step is an exclusive link, not a rename, and why.

**Verify**: `pnpm --filter "@lunora/config" run test -- scaffold-dev` → Step 1 test is green; all existing scaffold tests are green.

### Step 3: Confirm mode and cleanup

Add an assertion (or confirm the existing one) that the created `.dev.vars` has mode `0o600` on POSIX. Confirm the temp file is removed on success and on failure.

**Verify**: `pnpm --filter "@lunora/config" run test -- scaffold-dev` → all pass; `ls -la` of a test fixture dir shows no leftover `.tmp-*` file (the test should assert this with `readdirSync`).

### Step 4: Types and lint

**Verify**: `pnpm --filter "@lunora/config" run lint:types` → exit 0; `pnpm --filter "@lunora/config" run lint:eslint` → exit 0.

## Test plan

- Step 1 race case (peer file preserved, status `skipped-exists`).
- Mode case: `0o600` on the created file (POSIX only; skip on Windows with the repo's existing platform guard if one exists — match its style).
- Cleanup case: no `.tmp-*` leftover after success or failure.
- Structural pattern: existing scaffold tests in the same file.
- Verification: `pnpm --filter "@lunora/config" run test -- scaffold-dev` → all pass.

## Done criteria

- [ ] `grep -n "renameSync" packages/config/src/scaffold-dev-variables.ts` returns no match inside `atomicWrite` (the final step is `linkSync`)
- [ ] The Step 1 race test was red before Step 2 and green after
- [ ] `pnpm --filter "@lunora/config" run test -- scaffold-dev` exits 0
- [ ] `pnpm --filter "@lunora/config" run lint:types` exits 0
- [ ] `git status` shows changes only in scope
- [ ] `plans/README.md` row for 483 updated

## STOP conditions

- `linkSync` is unavailable or unsupported on a platform the package targets. Report which platform; do not fall back to `renameSync`.
- Step 1 cannot reproduce the overwrite with any seam. Report what was tried.
- Other code in `packages/config` depends on `renameSync`'s overwrite behaviour for this file.

## Maintenance notes

- Reviewers: `linkSync` requires the temp and final paths to be on the same filesystem, which they are (same directory).
- The window is narrow; this is a correctness fix with LOW practical impact, so prioritise it below the security and correctness plans.
