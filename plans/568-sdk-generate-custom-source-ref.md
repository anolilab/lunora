# Plan 568 — `sdk generate --source` resolves refs against the named source and stamps it

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** TODO

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/cli/src/commands/sdk/vendor.ts packages/cli/__tests__/commands/sdk-vendor-symlink-guard.test.ts packages/cli/__tests__/commands/sdk-vendor-source.test.ts`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 26 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

`lunora sdk generate --source <other repo>` fetches the transport from the other repo but resolves
the ref against `anolilab/lunora` (pinning `anolilab/lunora`'s release-branch commit SHA, which the
fork may not have) and writes `gh:anolilab/lunora/sdks/<lang>` into `lunora-transport.json` as the
source. The registry path deliberately leaves a custom source unpinned; the SDK path bypasses that
by passing an already-pinned ref.

## 1. Current state (audit)

- `packages/cli/src/commands/sdk/vendor.ts`:
    - Line 28: `import { resolveCliVersionRef, resolvePinnedSourceRef } from "../../util/source-ref";`
    - Line 32: `const SDK_SOURCE_BASE = "gh:anolilab/lunora/sdks";`
    - Lines 155-181, `vendorAtRef(ref, { language, logger, outputDirectory, registryOptions, target })`:
      calls `resolveItemDirectory(language, { ...registryOptions, ref }, SDK_SOURCE_BASE)`; on a
      missing transport warns `\`${SDK_SOURCE_BASE}/${language} does not exist at ${ref}.\``; returns
`source: \`${SDK_SOURCE_BASE}/${language}\``.
    - Lines 222-283, `vendorTransport`: `registryOptions = { allowUnsafeSource, logger, names: [], source }`
      and

        ```ts
        const attempt = async (candidate: string | undefined): Promise<VendorResult | undefined> =>
            vendorAtRef(await resolvePinnedSourceRef(candidate, logger), { language, logger, outputDirectory, registryOptions, target });
        ```

- `packages/cli/src/util/source-ref.ts`: `resolveSourceRef(ref)` (line 81) validates an explicit ref
  or derives the release branch from the CLI version, unpinned; `resolvePinnedSourceRef(ref, logger)`
  (line 216) does that and then pins the branch to a commit SHA of `SOURCE_REPO = "anolilab/lunora"`
  (line 98). Both are exported.
- `packages/cli/src/commands/registry/resolve.ts`: `resolveItemDirectory(name, options, defaultBase)`
  fetches `${options.source ?? defaultBase}/${name}#${await resolveRemoteRef(options)}`;
  `resolveRemoteRef` (lines 118-133) leaves a custom source unpinned ("A custom `--source` may point at
  a different repo we can't resolve against, so it stays unpinned").
- Tests: `packages/cli/__tests__/commands/sdk.test.ts` (end to end with `--from`, no `--source`
  coverage); `packages/cli/__tests__/commands/sdk-vendor-symlink-guard.test.ts` calls
  `vendorTransport` directly (line 17, options at ~line 37 with `source: undefined`).

## 2. Existing seams (do not reinvent)

`resolveSourceRef` is the registry's own unpinned resolver; use it for a custom source.

## 3. The behavioural contract to preserve

Without `--source`, the fetched refs, the pinning and the stamp are exactly as today. `--from` is
untouched.

## 4. Design decisions

- In `vendorTransport`, compute the base once: `const base = source ?? SDK_SOURCE_BASE`. Pass it to
  `vendorAtRef` (new field in its options) and use it for the `resolveItemDirectory` default, the
  warning and the returned `source` (`\`${base}/${language}\``).
- `attempt` resolves with `source === undefined ? await resolvePinnedSourceRef(candidate, logger) : resolveSourceRef(candidate)`,
  with a why-comment (pinning resolves against `anolilab/lunora`, which a custom source is not).
- **Rejected:** teaching `resolvePinnedSourceRef` to pin arbitrary repos. A `--source` base is a
  giget spec, not always a GitHub repo, and the registry already chose "unpinned" for it.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `cli`.

### Commands you will need

| Purpose         | Command (worktree root)                                                                                                                                                       | Expected |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Install         | `pnpm install --frozen-lockfile`                                                                                                                                              | exit 0   |
| Build deps once | `pnpm --filter "@lunora/cli..." run build`                                                                                                                                    | exit 0   |
| Test files      | `pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/sdk-vendor-source.test.ts __tests__/commands/sdk-vendor-symlink-guard.test.ts __tests__/commands/sdk.test.ts` | all pass |
| Package tests   | `pnpm --filter "@lunora/cli" run test`                                                                                                                                        | all pass |
| Format          | `pnpm exec oxfmt <each changed .ts file>`                                                                                                                                     | exit 0   |
| ESLint          | `pnpm --filter "@lunora/cli" run lint:eslint`                                                                                                                                 | exit 0   |
| Types           | `pnpm --filter "@lunora/cli" run lint:types`                                                                                                                                  | exit 0   |

### Scope

**In scope:** `packages/cli/src/commands/sdk/vendor.ts`,
`packages/cli/__tests__/commands/sdk-vendor-source.test.ts` (create).

**Out of scope:** `util/source-ref.ts`, `commands/registry/**`, `commands/sdk/handler.ts`, the
stale-file behaviour (plan 569), `plans/README.md`.

### Git workflow

- Branch `fix/improve-568-sdk-source-ref`, from `origin/alpha`. Do not push.
- One commit: `fix(cli): resolve sdk generate refs against a custom --source`; body ≤ 3 lines; last
  line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- No network in tests: mock the fetch. No `.skip`, `@ts-expect-error`, `as any`, or new
  `eslint-disable` without rule + `-- reason`.

### Step 1: Install and build

**Verify:** exit 0.

### Step 2: Write the failing test

Create `packages/cli/__tests__/commands/sdk-vendor-source.test.ts`, following
`sdk-vendor-symlink-guard.test.ts` for how `vendorTransport` is called and how a fake transport
directory and `SdkTarget` are built. Use Vitest module mocks:

- `vi.mock("../../src/commands/registry/resolve", …)` so `resolveItemDirectory` records its
  `(name, options, defaultBase)` arguments and returns `{ cleanup: () => {}, directory: <a temp dir holding a minimal transport for the target> }`.
- `vi.mock("../../src/util/source-ref", async (importOriginal) => ({ ...(await importOriginal()), resolvePinnedSourceRef: vi.fn(async () => { throw new Error("must not pin a custom source"); }) }))`.

Cases:

1. `source: "gh:someone/fork/sdks"`, no `ref`: resolves; `resolvePinnedSourceRef` was never
   called; the first `resolveItemDirectory` call's options carry `source: "gh:someone/fork/sdks"`;
   the result's `source` is `"gh:someone/fork/sdks/<lang>"`.
2. Same with `ref: "v9.9.9"`: the recorded `options.ref` is exactly `"v9.9.9"`.
3. No `source`: `resolvePinnedSourceRef` IS called (make the mock resolve to a fixed SHA for this
   case, e.g. via `mockResolvedValueOnce`) and the result's `source` is `"gh:anolilab/lunora/sdks/<lang>"`.

**Verify:** test-file command → cases 1 and 2 FAIL.

### Step 3: Implement

Per section 4.

**Verify:** the three test files pass.

### Step 4: Gates, then commit

**Verify:** format, ESLint, types, package tests exit 0. Commit. `git status --short` empty.

### Step 5: Prove the test needs the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/cli/src/commands/sdk/vendor.ts > packages/cli/src/commands/sdk/vendor.ts
pnpm --filter "@lunora/cli" exec vitest run __tests__/commands/sdk-vendor-source.test.ts   # cases 1 and 2 FAIL
git checkout HEAD -- packages/cli/src/commands/sdk/vendor.ts
git status --short   # empty
```

## 6. Platform parity

Not applicable.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                   |
| ----- | --------- | ------------------------------------------------------ |
| 0     | Steps 1-5 | new cases red on base, green with fix; cli gates green |

## 8. Risks & STOP conditions

- **STOP** if section 1 does not match the live code.
- **STOP** if module mocking `resolve.ts` breaks unrelated imports in the new test file twice in a
  row; report the error.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test`, `lint:eslint`, `lint:types` exit 0.
- [ ] Cases 1 and 2 fail against `79b0c5a6a`'s `vendor.ts`.
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only the two in-scope files.

## Maintenance notes

Plan 569 (stale-file removal, blocked on a decision) touches the same file; rebase it on this.
