# Plan 317 — Route every `.dev.vars` write through the owner-only atomic writer

**Baseline:** `70b7451b5` (2026-08-11)
**Status:** TODO

> **Executor instructions**: follow this file top to bottom, run every verification
> command, and stop if a STOP condition in §8 fires. Update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first):**
> `git diff --stat 70b7451b5..HEAD -- packages/cli/src/commands/env/handler.ts packages/cli/src/commands/registry/apply.ts packages/config/src/scaffold-dev-variables.ts`
>
> **Build before you measure:** `pnpm run build:packages` once, or a stale
> `@lunora/config` dist will hide the new export.

## 0. Headline finding

Four CLI code paths write the project's local secrets file with a plain
`writeFileSync`. The repo already has the correct writer — `atomicWrite(path,
content, { mode: 0o600 })` in `@lunora/config` — and `deploy` already uses it on the
_same file_, with a docblock explaining why. The four stragglers create `.dev.vars`
at `0o666 & ~umask` (0644 on a default umask) and truncate-then-write, so:

- `lunora env generate --set` — the command that mints 32-byte secrets on a fresh
  project, i.e. the common **creating** call — leaves live secrets world-readable on
  any shared, CI, or dev-container host. Whether the file ends up 0600 or 0644 today
  depends on which command happened to create it first.
- An interrupted write truncates the file and destroys **every other secret in it** —
  the exact failure the deploy path documents as unacceptable.

Cloudflare secrets are write-only after push, so for `env generate --set` the value
in this file may be the only copy.

## 1. Current state (audit)

The four sites:

- `packages/cli/src/commands/env/handler.ts:209` — `env set <KEY> <VALUE>`
- `packages/cli/src/commands/env/handler.ts:238` — `env unset` (rewrites the whole file)
- `packages/cli/src/commands/env/handler.ts:490` — `env generate --set`
- `packages/cli/src/commands/registry/apply.ts:205` — `registry add` scaffolding
  secret-marked vars

All four are the same shape:

```ts
writeFileSync(devVariablesPath, /* content */, "utf8");
```

The writer they should use, `packages/config/src/scaffold-dev-variables.ts:313`:

```ts
const atomicWrite = (path: string, content: string, options: { flag?: "wx"; mode?: number } = {}): void => {
```

wrapped at `:335` as `writeDevVariablesFileAtomically` and exported from the package
barrel (`packages/config/src/index.ts`, export list line ~714). Its existing consumer
is `packages/cli/src/commands/deploy/handler.ts:699`, with the rationale spelled out
at `deploy/handler.ts:657-663`.

Prior wave plan 261 converted only the deploy mint path; these four were not in its
scope.

## 2. Existing seams (do not reinvent)

- `writeDevVariablesFileAtomically` from `@lunora/config` — already exported, already
  proven on this file by the deploy path. Do not write a second atomic writer, and do
  not inline `chmod`.
- `@lunora/cli` already depends on `@lunora/config` (check `packages/cli/package.json`
  — `deploy/handler.ts` imports from it), so no manifest change is needed. If it turns
  out `registry/apply.ts` is in a package that does not depend on `@lunora/config`,
  that is a STOP condition, not a manifest edit.

## 3. The behavioural contract to preserve

1. File **content** is byte-identical to today for every one of the four paths. This
   plan changes how bytes reach disk, not which bytes.
2. `env unset` still removes only the named key.
3. An existing `.dev.vars` keeps working; a mode change on an existing file is
   acceptable and desirable (0600), but content must survive.
4. Windows: `renameSync` over an existing file must not throw. The deploy path already
   exercises this, so the behaviour is proven — but if the atomic writer's temp file
   lands on a different volume, the rename fails. Verify on the CI matrix if it covers
   Windows; otherwise note it.

## 4. Design decisions

**Chosen: reuse `writeDevVariablesFileAtomically` verbatim at all four sites.**
Rejected: adding a `mode` argument to the existing `writeFileSync` calls. That fixes
permissions on creation but leaves the truncate-then-write window, which is the half
that loses other people's secrets.

**Chosen: no rotation guidance in the CLI output.** Rejected: printing a "your
previous .dev.vars may have been world-readable, rotate" warning on every run — it
would fire for every user regardless of exposure and train people to ignore it. The
rotation note belongs in the PR body and the changelog entry, not in the tool.

## 5. Workstreams

### WS1 — Convert the four call sites (S)

In `packages/cli/src/commands/env/handler.ts`, import
`writeDevVariablesFileAtomically` from `@lunora/config` and replace the writes at
`:209`, `:238`, `:490`. Do the same at `packages/cli/src/commands/registry/apply.ts:205`.

Leave the _other_ `writeFileSync` calls in `registry/apply.ts` alone — `:155`
(`package.json`) and `:426` (`wrangler.jsonc`) are not secret files and are out of
scope.

If `writeFileSync` becomes unused in a file, remove it from the `node:fs` import; the
lint gate will tell you.

**Verify:** `grep -n "writeFileSync" packages/cli/src/commands/env/handler.ts` → no
matches. `grep -n "writeFileSync" packages/cli/src/commands/registry/apply.ts` → two
matches (`package.json`, `wrangler.jsonc`), neither on a `.dev.vars` path.

### WS2 — Pin the mode with a test (S)

See §"Test plan".

## 6. Platform parity

Not applicable — local filesystem behaviour in the CLI. No `ctx.*` surface, no binding,
no runtime capability.

## 7. Phasing & ordering

| Phase | Work | Gate                                              |
| ----- | ---- | ------------------------------------------------- |
| 0     | WS1  | `pnpm --filter "@lunora/cli" run test` green      |
| 1     | WS2  | the new mode assertion fails when WS1 is reverted |

## Commands you will need

| Purpose      | Command                                              | Expected |
| ------------ | ---------------------------------------------------- | -------- |
| Build        | `pnpm run build:packages`                            | exit 0   |
| CLI tests    | `pnpm --filter "@lunora/cli" run test`               | all pass |
| Typecheck    | `pnpm --filter "@lunora/cli" run lint:types`         | exit 0   |
| Format, lint | `pnpm run lint:prettier:fix && pnpm run lint:eslint` | exit 0   |

## Scope

**In scope:**

- `packages/cli/src/commands/env/handler.ts`
- `packages/cli/src/commands/registry/apply.ts` (the `.dev.vars` write only)
- `packages/cli/__tests__/` — one new or extended spec

**Out of scope:**

- `packages/config/src/scaffold-dev-variables.ts` — the writer is correct; do not
  change its signature or add options for this.
- The `package.json` and `wrangler.jsonc` writes in `registry/apply.ts`.
- Any change to what `.dev.vars` contains, or to `.dev.vars.example` handling.

## Git workflow

- Branch: `advisor/317-dev-vars-atomic-write`
- Suggested commit: `fix(cli): write .dev.vars atomically at 0600`
- The commit body should note the rotation implication: a `.dev.vars` created by an
  older CLI on a shared host may have been readable by other local users.

## Test plan

New or extended spec under `packages/cli/__tests__/` (find the existing env-command
spec first: `ls packages/cli/__tests__ | grep -i env`). Use a temp directory, not the
repo tree.

1. **Mode on creation** — run `env generate --set` (or the handler function directly)
   against a directory with **no** `.dev.vars`; assert
   `statSync(path).mode & 0o777 === 0o600`. This is the regression test.
2. **Content parity** — `env set FOO=bar` on an existing file produces byte-identical
   content to what the old path produced (capture the expected string in the test).
3. **`env unset` preserves siblings** — a file with three keys loses only the named one.
4. Skip 1 on Windows if the CI matrix runs it (`process.platform === "win32"`) — POSIX
   mode bits are not meaningful there. Guard it explicitly rather than letting it fail.

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test` exits 0 with the new mode assertion passing
- [ ] `grep -rn "writeFileSync" packages/cli/src/commands/env/handler.ts` → no matches
- [ ] The `.dev.vars` write in `registry/apply.ts` no longer uses `writeFileSync`
- [ ] `pnpm --filter "@lunora/cli" run lint:types` exits 0
- [ ] `pnpm run lint:package-json` exits 0 (CI-only gate; run it if you touched a manifest)
- [ ] `git status` shows no files outside the in-scope list
- [ ] `plans/README.md` row updated

## 8. Risks & STOP conditions

- **STOP** if `writeDevVariablesFileAtomically` is not exported from the
  `@lunora/config` barrel, or `@lunora/cli` does not already depend on
  `@lunora/config`. Both should hold (`deploy/handler.ts` imports it) — if not,
  report rather than adding a dependency or a new export on your own judgement.
- **STOP** if any of the four sites turns out to write something other than
  `.dev.vars` (read the surrounding code to confirm the path variable).
- **Risk:** the atomic writer may create its temp file in the OS temp dir rather than
  next to the target; a cross-device `rename` then fails with `EXDEV`. Read
  `scaffold-dev-variables.ts:313-340` and confirm the temp file is a sibling of the
  target before assuming this is safe.

## 9. Open questions

1. Should `lunora doctor` warn when an existing `.dev.vars` is group- or
   world-readable? Cheap, local, and the only way an already-exposed file gets
   noticed. Deliberately out of scope here — record a yes/no.
