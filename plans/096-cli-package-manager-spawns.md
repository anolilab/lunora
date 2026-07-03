# Plan 096: Route every wrangler/tsc subprocess spawn through the detected package manager

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/cli/src/commands packages/cli/src/util`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / bug
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

`lunora init` offers npm / yarn / pnpm / bun as first-class choices, and the
`dev` command already runs wrangler through a package-manager–aware helper
(`execArgsFor`). But **every other command that spawns `wrangler` or `tsc`
hardcodes `command: "pnpm"`** with `["exec", …]` args. A user who scaffolds with
npm/yarn/bun and does not have pnpm on `PATH` gets `spawn pnpm ENOENT` on
`lunora deploy` (the money command), plus `logs`, `env` (secret push),
`analyze`, `verify`, `containers`, `deployments`, and the railpack container
push. Two of those (`logs`, `env`) even print `running pnpm exec wrangler …` to a
non-pnpm user. The guided `dev` path works, so the break stays invisible until
deploy/CI. The fix is mechanical: the helper already exists and is battle-tested
by `dev`.

## Current state

The helper (already correct, handles all four managers):

`packages/cli/src/util/detect-package-manager.ts:95-113`:

```ts
/** Map a package manager to the argv pair that runs an installed CLI. */
const execArgsFor = (manager: PackageManager, command: string, args: ReadonlyArray<string>): { args: string[]; command: string } => {
    if (manager === "yarn") {
        return { args: [command, ...args], command: "yarn" };
    }
    if (manager === "bun") {
        return { args: ["x", command, ...args], command: "bun" };
    }
    if (manager === "npm") {
        return { args: ["--", command, ...args], command: "npx" };
    }
    // pnpm default
    return { args: ["exec", command, ...args], command: "pnpm" };
};

export { detectInstalledManagers, detectPackageManager, execArgsFor, installArgsFor };
```

The one **correct** call site, to copy (`packages/cli/src/commands/dev/handler.ts:154-163`):

```ts
const manager = detectPackageManager(cwd);
// …
const exec = execArgsFor(manager, "wrangler", ["dev", "--port", String(workerPort), "--var", "WORKER_ENV:development", ...remote.args]);
// … used as { args: exec.args, command: exec.command, cwd, tag: "wrangler" }
```

The **broken** call sites (each hardcodes `command: "pnpm"` with an `exec`-style
args array). For each, the current args after `"exec"` are the real command +
its flags:

| File:line | Current descriptor (abridged) | Real command / args |
|---|---|---|
| `packages/cli/src/commands/deploy/handler.ts:449` | `spawner({ args, command: "pnpm", cwd, input: … })` where `args` starts `["exec","wrangler","secret","put", …]` | `wrangler secret put <name> …` |
| `packages/cli/src/commands/deploy/handler.ts:990` | `{ args: buildWranglerDeployArgs(cwd, options), captureStdout, command: "pnpm", cwd, stdoutToStderr }` — `buildWranglerDeployArgs` returns `["exec","wrangler","deploy", …]` | `wrangler deploy …` |
| `packages/cli/src/commands/verify/handler.ts:53` | `spawner({ args: ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"], command: "pnpm", cwd })` | `tsc --noEmit -p tsconfig.json` |
| `packages/cli/src/commands/env/handler.ts:266` | `{ args, command: "pnpm", cwd, input: entry.value }` — `args` starts `["exec","wrangler","secret","put", …]` | `wrangler secret put <name> …` |
| `packages/cli/src/commands/logs/handler.ts:91` | `{ args, command: "pnpm", cwd }` — `args` starts `["exec","wrangler","tail", …]` | `wrangler tail …` |
| `packages/cli/src/commands/analyze/handler.ts:136` | `{ args: ["exec","wrangler","deploy","--dry-run","--outdir",outdir], command: "pnpm", cwd }` | `wrangler deploy --dry-run …` |
| `packages/cli/src/commands/containers/handler.ts:77` | `{ args, command: "pnpm", cwd }` — `args` starts `["exec","wrangler","containers", …]` | `wrangler containers …` |
| `packages/cli/src/commands/deployments/handler.ts:122` | `{ args, command: "pnpm", cwd }` — `args` starts `["exec","wrangler", …]` | `wrangler …` |
| `packages/cli/src/util/railpack.ts:71` | `{ args: ["exec","wrangler","containers","push",tag], command: "pnpm", cwd }` | `wrangler containers push <tag>` |

**Important structural note**: several sites build the `["exec","wrangler",…]`
array *upstream* (e.g. `deploy`'s `buildWranglerDeployArgs`, `env`/`deployments`
build `args` before the descriptor). You must find where the `"exec"` /
`"wrangler"` prefix is prepended and change the shape there, OR strip the
`"exec"`/leading tokens and re-derive via `execArgsFor`. Read each file's arg
construction before editing — do NOT blindly string-replace.

The two lines that log the command to the user (must reflect the real manager
after the fix):
- `logs/handler.ts:93` — `options.logger.info(\`tailing logs via ${descriptor.command} ${descriptor.args.join(" ")}\`)`
- `analyze/handler.ts:139` — `logger.info(\`analyze: building via ${descriptor.command} ${descriptor.args.join(" ")}\`)`
- `containers/handler.ts:79`, `deployments/handler.ts:124` — similar info logs.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build the package (deps first) | `pnpm --filter "@lunora/cli..." run build` | exit 0 |
| Typecheck | `pnpm --filter "@lunora/cli" run lint:types` | exit 0, no errors |
| Tests | `pnpm --filter "@lunora/cli" run test` | all pass |
| Lint | `pnpm --filter "@lunora/cli" run lint:eslint` | exit 0 |

If the `...`-filter build fails to resolve deps in a fresh checkout, run
`pnpm run build:packages` once first.

## Scope

**In scope** (modify only these):
- `packages/cli/src/commands/deploy/handler.ts`
- `packages/cli/src/commands/verify/handler.ts`
- `packages/cli/src/commands/env/handler.ts`
- `packages/cli/src/commands/logs/handler.ts`
- `packages/cli/src/commands/analyze/handler.ts`
- `packages/cli/src/commands/containers/handler.ts`
- `packages/cli/src/commands/deployments/handler.ts`
- `packages/cli/src/util/railpack.ts`
- The existing test files under `packages/cli/__tests__/commands/` and
  `packages/cli/__tests__/util/` that assert `command === "pnpm"` (update
  assertions; see Test plan).

**Out of scope** (do NOT touch):
- `packages/cli/src/commands/dev/handler.ts` — already correct; it is the model.
- `execArgsFor` / `detectPackageManager` themselves — they already handle all
  four managers correctly. Do not change their behavior.
- The `installArgsFor` / `runScriptCommand` helpers — different concern.
- Any `command: "railpack"` spawn (`railpack.ts:70` `build`) — railpack is its
  own binary, not run through a package manager. Only the `wrangler containers
  push` spawn on line 71 changes.

## Git workflow

- Branch: `advisor/096-cli-package-manager-spawns`
- Conventional commits; example from `git log`: `fix(cli): route wrangler/tsc spawns through detected package manager`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Convert `verify` (simplest — no upstream arg builder)

In `packages/cli/src/commands/verify/handler.ts:53`, replace the hardcoded
descriptor with a manager-derived one. `cwd` is already in scope. Add
`import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";`
(match the existing import path used by `dev/handler.ts`; verify relative depth).

Target shape:
```ts
const exec = execArgsFor(detectPackageManager(cwd), "tsc", ["--noEmit", "-p", "tsconfig.json"]);
const result = await spawner({ args: exec.args, command: exec.command, cwd });
```

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 2: Convert `logs`, `analyze`, `containers`, `deployments`, and `railpack`

For each, locate where the `["exec", "wrangler", …]` array is built, strip the
`"exec"` (and the leading `"wrangler"`/`"tsc"` token, which becomes the
`command` arg to `execArgsFor`), and rebuild via `execArgsFor(manager, "wrangler",
[…rest])`. Thread `detectPackageManager(cwd)` (use the `cwd`/`options.cwd` each
handler already resolves). Update the info-log lines so they print the real
`descriptor.command`/`descriptor.args` (they already interpolate `descriptor.*`,
so they self-correct once the descriptor is right).

For `railpack.ts:71`, only the `push` descriptor changes; leave the `build`
(railpack) descriptor untouched.

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 3: Convert `env` and `deploy` (the secret-push + deploy paths)

These carry an `input` (stdin) channel and, for deploy, `captureStdout` /
`stdoutToStderr` — preserve all of those; only `command`/`args` change. Find the
`args` builder (deploy uses `buildWranglerDeployArgs`; if it prepends
`["exec","wrangler"]`, change it to return only the wrangler subcommand args and
apply `execArgsFor` at the call site). The `secret put <name>` stdin-piping
behavior MUST be preserved exactly (the secret must never reach argv) — only the
launcher (`pnpm`→`npx`/`yarn`/`bun`) changes.

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 4: Update the tests that assert `command === "pnpm"`

Run `grep -rn 'command.*"pnpm"\|"pnpm"' packages/cli/__tests__` to find
assertions. For each, either (a) drive the test through a non-pnpm manager and
assert the mapped command (`npx`/`yarn`/`bun`), or (b) keep a pnpm case and add a
new case asserting an npm project yields `command === "npx"` with
`args[0] === "--"`. Prefer adding at least one npm-path assertion per converted
command so a regression back to hardcoded `pnpm` is caught.

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass.

## Test plan

- In `packages/cli/__tests__/commands/verify.test.ts` (exists) add a case: a cwd
  whose package manager resolves to npm produces a spawn with
  `command === "npx"` and `args === ["--", "tsc", "--noEmit", "-p", "tsconfig.json"]`.
- In `packages/cli/__tests__/commands/deploy.test.ts` (exists) add: an npm
  project's deploy spawn has `command === "npx"` and `args[0] === "--"`,
  `args[1] === "wrangler"`, `args[2] === "deploy"`; the secret-push spawn still
  pipes via `input` (stdin) and never puts the value in `args`.
- Model the manager-mocking after however `dev`'s tests exercise
  `detectPackageManager` (grep `packages/cli/__tests__` for `detectPackageManager`
  or a fixture `package.json` with `packageManager`/lockfile). If `dev` has no
  such test, mock `detectPackageManager` with `vi.mock` on the util module.
- Verification: `pnpm --filter "@lunora/cli" run test` → all pass, including the
  new npm-path cases.

## Done criteria

ALL must hold:

- [ ] `grep -rn '"pnpm"' packages/cli/src/commands packages/cli/src/util/railpack.ts` returns **no** matches inside a `SpawnDescriptor`/`spawner(...)` `command` field (the only remaining `"pnpm"` literals, if any, must be in comments or unrelated strings — inspect each).
- [ ] `pnpm --filter "@lunora/cli" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/cli" run test` exits 0; new npm-path assertions exist and pass.
- [ ] `pnpm --filter "@lunora/cli" run lint:eslint` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- An `args` array is built somewhere you cannot cleanly trace (e.g. passed
  through several helpers) and stripping `"exec"` risks changing a pnpm user's
  behavior — report the site rather than guessing.
- Any test that pipes a secret via stdin would be changed to put the value in
  `args` — that is a security regression; STOP.
- `execArgsFor`/`detectPackageManager` do not exist at the cited path (drift) —
  the excerpts in "Current state" don't match live code.
- Converting `deploy`'s `buildWranglerDeployArgs` requires changing the public
  deploy arg-assembly logic in a way that alters the wrangler flags emitted —
  the flags must be byte-identical; only the launcher changes.

## Maintenance notes

- Any **new** CLI command that spawns wrangler/tsc must use
  `execArgsFor(detectPackageManager(cwd), …)`, never a literal `command: "pnpm"`.
  Consider a lint/grep guard in review.
- A reviewer should confirm the secret-push stdin path is untouched and that
  `deploy` still auto-links (the `captureStdout` branch) under all four managers.
- Deferred: the template READMEs and init "next steps" still print
  `pnpm`-specific guidance — that is plan 099, not this one.
