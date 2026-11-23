# Plan 659: Secrets a failed bulk push already set are still recorded

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/cli/src/commands/deploy/secrets.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/cli-hardening-audit-round-5`, PR #1662

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

On deploy the CLI generates missing secrets, pushes them, and records the values locally, because Cloudflare secrets are write-only: a value that was pushed but not recorded is lost and can only be fixed by rotating it by hand. The push tries one `wrangler secret bulk` call and, if that exits non-zero, retries key by key with the same values, stopping at the first failure:

```ts
    // One `wrangler secret bulk` instead of K spawns. A failure falls through to
    // the per-key loop below (same values — a put is idempotent), which is what
    // gives the precise per-key error and the partial `minted` list.
    if (secretBulk !== undefined && pending.length >= 2) {
        const bulkExec = toolchainExecArgs(manager, secretBulk({ environment: options.env, temporary: options.temporary }));
        const bulkResult = await spawner({
            args: bulkExec.args,
            command: bulkExec.command,
            cwd,
            input: JSON.stringify(Object.fromEntries(pending.map((entry) => [entry.key, entry.value]))),
        });

        if (bulkResult.code === 0) {
            for (const { key } of pending) {
                logger.success(`generated + pushed ${key}`);
            }

            return { minted: pending, ok: true };
        }

        logger.warn(`bulk secret push failed (exit ${String(bulkResult.code)}); retrying one key at a time`);
    }

    const minted: { key: string; value: string }[] = [];

    for (const { key, value } of pending) {
        const secretCommand = secretPut({ environment: options.env, key, temporary: options.temporary });
        const exec = toolchainExecArgs(manager, secretCommand);

        // `wrangler secret put <name>` reads the value from stdin, so the value
        // never lands on the command line, in env, or in shell history.
        // eslint-disable-next-line no-await-in-loop -- push sequentially so a failure aborts before the rest.
        const pushResult = await spawner({ args: exec.args, command: exec.command, cwd, input: value });

        if (pushResult.code !== 0) {
            logger.error(
                `failed to push secret ${key} (exit ${String(pushResult.code)}); set it manually with \`wrangler secret put ${key}${environmentFlag}\`.`,
            );

            return { minted, ok: false };
        }

        minted.push({ key, value });
```

Only `minted` — the keys the key-by-key loop pushed itself — is recorded. If the bulk call applied some keys before failing, and the loop then fails on an earlier key (for example because auth expired), the later keys are set on the target with values nobody recorded. Later deploys see them as present and never regenerate them. **Assumption to verify**: that `secret bulk` can apply part of a batch before exiting non-zero.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                                 | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                        | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/cli..." run build`                              | exit 0              |
| One test file                 | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/cli" run test`                                  | all pass            |
| Types                         | `pnpm --filter "@lunora/cli" run lint:types`                            | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/cli" run lint:eslint`                           | exit 0, 0 warnings  |

Note: the full `@lunora/cli` suite is slow and has shown 1–2 unrelated flaky failures under load. Run the touched test files directly.

## Design (decided)

When the bulk call has been attempted and failed, every value in `pending` **may** already be live. So if the key-by-key retry also stops early, record all of `pending` (not just `minted`) in the local file — a recorded value that was never applied is harmless provided the next deploy converges: read `offerMissingSecrets` / `persistMintedSecrets`, and make sure a key that is recorded locally and missing remotely is pushed with the **recorded** value, not a freshly generated one. Tell the operator which keys are in that uncertain state. When bulk was not attempted (fewer than two keys) nothing changes.

## Steps

1. Read the whole flow (`pushMintableSecrets`, `offerMissingSecrets`, `persistMintedSecrets`) and state what a re-deploy does with a locally recorded key that is missing remotely. If wrangler's source in `node_modules` shows `secret bulk` is all-or-nothing (`rg -n "secret bulk|bulk" node_modules/.pnpm/wrangler*/node_modules/wrangler/wrangler-dist/cli.js | head`), report NOT REPRODUCED with the evidence and stop.
2. Tests first in the deploy secrets tests (`rg -ln "secretBulk|secret bulk" packages/cli/__tests__`): spawner stub where bulk exits non-zero and the second key-by-key put fails → all pending keys are recorded and the result reports failure and the uncertain keys; a follow-up run pushes the recorded value. Red at baseline. 3. Implement. 4. Build, the touched test files, types, eslint.

## Git workflow

- Branch: `fix/cli-hardening-audit-round-5 (same branch, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(cli): record secrets a failed bulk push may have set`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- Recording a not-applied value would cause a later deploy to treat the secret as present remotely (it must check the remote list, not the local file): STOP and report.
