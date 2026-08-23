# Plan 376: Derive the umbrella parity test's package list from disk, with reasoned opt-outs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/lunora/__tests__/re-exports.test.ts packages/lunora/package.json`
> If either changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The `lunorash` umbrella's subpath-parity test only checks packages someone remembered to type into a ten-entry literal array. Subpath-level exclusions get a reasoned `OPT_OUT` map, but there is no package-level counterpart — so `@lunora/payment`, `@lunora/x402`, `@lunora/mail`, and ~40 other packages are simply absent from the umbrella with no assertion and no recorded rationale. A reader cannot tell "deliberate heavy add-on, installed directly" from "someone forgot", and the next package that _should_ join the umbrella will be silently missing too. Deriving the list from `packages/*` on disk and requiring every package to be either covered or opted out with one sentence closes the hole. Test-only change.

## Current state

- `packages/lunora/__tests__/re-exports.test.ts:27-38`:
    ```ts
    const UPSTREAM_PACKAGE_DIRS: ReadonlyArray<string> = [
        "server",
        "values",
        "errors",
        "runtime",
        "do",
        "platform",
        "observability",
        "client",
        "flags",
        "ratelimit",
    ];
    ```
- The file already reads manifests from disk relative to itself (`:7-8, :17-18`):
    ```ts
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const monorepoPackagesRoot = join(packageRoot, "..");
    const readManifest = (packageDirName: string): UpstreamManifest =>
        JSON.parse(readFileSync(join(monorepoPackagesRoot, packageDirName, "package.json"), "utf8")) as UpstreamManifest;
    ```
    It imports `readFileSync` from `node:fs`; `readdirSync` comes from the same module.
- The subpath-level precedent — `OPT_OUT` map (`:76-89` region) with a docstring: "Add a new opt-out here (with a reason) rather than letting a future upstream subpath silently fall through the umbrella."
- The 56 dirs under `packages/` include the umbrella itself (`lunora`) and non-`@lunora/*`-published dirs; each dir's manifest `name` tells you which are `@lunora/*`.
- Not-published/internal packages that must be opted out with an "internal, not published" reason: check each manifest for `"private": true` (e.g. auth-ui, search-core, dispatch are documented internal — verify by reading their manifests, don't assume).

## Commands you will need

| Purpose    | Command                                    | Expected on success |
| ---------- | ------------------------------------------ | ------------------- |
| Install    | `pnpm install`                             | exit 0              |
| Build deps | `pnpm --filter "lunorash..." run build`    | exit 0              |
| Tests      | `pnpm --filter "lunorash" run test`        | all pass            |
| Typecheck  | `pnpm --filter "lunorash" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "lunorash" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/lunora/__tests__/re-exports.test.ts`

**Out of scope**:

- `packages/lunora/package.json` / `src/` — do NOT add re-exports; this plan records the current surface honestly, it does not grow it.
- Every upstream package.
- The existing `OPT_OUT` / `ALIAS_SUFFIX` subpath maps — unchanged.

## Git workflow

- Branch: `improve/wave22-lunorash`.
- Commit: `test(lunora): derive umbrella parity list from disk`

## Steps

### Step 1: Add the package-level opt-out map and the completeness test

Keep `UPSTREAM_PACKAGE_DIRS` (it drives the existing per-subpath cases). Add:

```ts
/**
 * Packages deliberately NOT re-exported by the umbrella, with the reason. Every
 * `packages/*` directory must appear either in UPSTREAM_PACKAGE_DIRS or here —
 * the completeness test below enforces it, so a new package cannot be silently
 * absent from the umbrella without a recorded decision.
 */
const PACKAGE_OPT_OUT = new Map<string, string>([
    ["lunora", "the umbrella itself"],
    // ... one entry per remaining dir
]);
```

Then a new `describe`/`it` (matching the file's existing test style):

```ts
it("every packages/* directory is either re-exported or opted out with a reason", () => {
    const dirs = readdirSync(monorepoPackagesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    const unaccounted = dirs.filter((dir) => !UPSTREAM_PACKAGE_DIRS.includes(dir) && !PACKAGE_OPT_OUT.has(dir));
    const stale = [...PACKAGE_OPT_OUT.keys()].filter((dir) => !dirs.includes(dir));
    const doubled = UPSTREAM_PACKAGE_DIRS.filter((dir) => PACKAGE_OPT_OUT.has(dir));

    expect(unaccounted, "add each to UPSTREAM_PACKAGE_DIRS or PACKAGE_OPT_OUT (with a reason)").toEqual([]);
    expect(stale, "PACKAGE_OPT_OUT names dirs that no longer exist").toEqual([]);
    expect(doubled, "a dir cannot be both re-exported and opted out").toEqual([]);
});
```

Import `readdirSync` alongside `readFileSync`.

**Verify**: `pnpm --filter "lunorash" run test` → the new test FAILS listing ~46 unaccounted dirs (proves it bites).

### Step 2: Fill `PACKAGE_OPT_OUT` with honest reasons

One entry per unaccounted dir. Reason guidelines (write one sentence each, grounded — read the package's role in `CLAUDE.md`'s package table if unsure):

- The umbrella's stated scope is "the base packages" (see `CLAUDE.md`: server + subpaths, values, runtime, do, client — plus the ones already listed). Everything else is an add-on/adapter/tool by that decision: e.g. `payment`/`x402`: "optional add-on with heavy provider/chain deps — installed directly"; framework adapters (`react`, `vue`, `solid`, `svelte`, `angular`, `astro`, `nuxt`, `react-native`, `db`, `replica`): "framework adapter — installed per framework, not part of the base surface"; `cli`/`vite`/`codegen`/`studio`/`advisor`/`config`/`testing`/`seed`: "tooling — dev-time, not a runtime re-export"; internal/not-published (`auth-ui`, `search-core`, `dispatch`, `sql-store`, and any manifest with `"private": true` — verify each): "internal, not published"; platform hosts (`platform-cloudflare`, `platform-node`, `platform-celld`, `shard-engine`, `d1`): "host/engine layer — consumed by @lunora/do or experimental, never app code"; the rest of the Cloudflare service add-ons (`storage`, `scheduler`, `queue`, `workflow`, `container`, `bindings`, `browser`, `hyperdrive`, `mail`, `notify`, `ai`, `agent`, `mcp`, `auth`, `cloudflare-access`, `fingerprint`, `errors`… note `errors` IS in the list already): "add-on — installed directly when used".
- Do not guess for a package you can't classify — its reason can be "not yet decided; absent since the umbrella's introduction", which is still an honest record.

**Verify**: `pnpm --filter "lunorash" run test` → all tests pass.

## Test plan

The new completeness test IS the deliverable; the fail-first check in Step 1 proves it enforces. All existing parity cases must stay green.

## Done criteria

- [ ] `pnpm --filter "lunorash" run test` exits 0; the completeness test exists and passes
- [ ] Temporarily removing one `PACKAGE_OPT_OUT` entry makes it fail naming that dir (spot check, then restore)
- [ ] `pnpm --filter "lunorash" run lint:types` exits 0
- [ ] Only `packages/lunora/__tests__/re-exports.test.ts` modified (`git status`)

## STOP conditions

- The test-file excerpts don't match the live code.
- You find a package that plausibly SHOULD be re-exported (its docs say `lunorash/<name>` works, or `src/index.ts` references it) — do not add the re-export; opt it out with "candidate for inclusion — flagged by plan 376" and report it.

## Maintenance notes

- Adding a new package now forces a one-line decision in this file — that friction is the feature.
- Reviewer: skim the reasons for accuracy, especially which dirs are claimed "internal, not published" (must match `"private": true` or the CLAUDE.md table).
