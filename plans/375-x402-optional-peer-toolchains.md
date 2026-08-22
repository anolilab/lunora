# Plan 375: Make the EVM and SVM toolchains optional peers of `@lunora/x402`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/x402/package.json packages/x402/src/charge/resource-server.ts packages/x402/src/pay/wallet.ts packages/x402/src/config.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: deps
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`@lunora/x402` dynamic-`import()`s the EVM (`@x402/evm`, viem) and SVM (`@x402/svm`, `@solana/kit`) scheme modules explicitly "so an EVM-only deployment never pulls Solana's (heavy) toolchain into its bundle" — but the manifest declares all four as **hard runtime dependencies**, so every install still downloads both chain toolchains, and a consumer cannot opt out at resolve time. The manifest already models the correct pattern for `@coinbase/cdp-sdk` and `@coinbase/x402`: optional peers with a friendly "install the optional peer" error at the import site. This plan applies the same treatment to the two scheme families. The package is experimental tier.

## Current state

- `packages/x402/package.json:68-102` (verbatim):
    ```json
    "dependencies": {
        "@lunora/errors": "1.0.0-alpha.22",
        "@solana/kit": "catalog:web3",
        "@x402/core": "catalog:web3",
        "@x402/evm": "catalog:web3",
        "@x402/fetch": "catalog:web3",
        "@x402/svm": "catalog:web3",
        "viem": "catalog:web3"
    },
    "devDependencies": { ... "@coinbase/cdp-sdk": "catalog:web3", "@coinbase/x402": "catalog:web3", ... },
    "peerDependencies": {
        "@coinbase/cdp-sdk": ">=1.0.0",
        "@coinbase/x402": ">=2.0.0"
    },
    "peerDependenciesMeta": {
        "@coinbase/cdp-sdk": { "optional": true },
        "@coinbase/x402": { "optional": true }
    }
    ```
- Every EVM/SVM import site (complete list, verified by grep):
    - Type-only (safe under optional peers — erased at compile): `src/config.ts:13-14`, `src/pay/wallet.ts:26-28` (`viem/accounts` type included).
    - Dynamic runtime imports: `src/charge/resource-server.ts:28` (`@x402/evm/exact/server`), `:32` (`@x402/svm/exact/server`); `src/pay/wallet.ts:122` (`viem/accounts`), `:137` (`@solana/kit`), `:218` (`@x402/evm/exact/client`), `:222` (`@x402/svm/exact/client`).
- The error pattern to copy — `src/pay/wallet.ts:80-87`:
    ```ts
    try {
        cdpModule = await import("@coinbase/cdp-sdk");
    } catch {
        throw new LunoraError(
            "ENV_INVALID",
            'x402 pay: CDP-managed custody needs the optional @coinbase/cdp-sdk peer — install it, or use "raw-key"/"signer" custody instead.',
        );
    }
    ```
- `@x402/core` and `@x402/fetch` stay hard deps — they are the protocol core, imported unconditionally.

## Commands you will need

| Purpose        | Command                                        | Expected on success |
| -------------- | ---------------------------------------------- | ------------------- |
| Install        | `pnpm install`                                 | exit 0              |
| Build deps     | `pnpm --filter "@lunora/x402..." run build`    | exit 0              |
| Tests          | `pnpm --filter "@lunora/x402" run test`        | all pass            |
| Typecheck      | `pnpm --filter "@lunora/x402" run lint:types`  | exit 0              |
| Lint           | `pnpm --filter "@lunora/x402" run lint:eslint` | exit 0              |
| Manifest order | `pnpm run lint:package-json`                   | exit 0              |

## Scope

**In scope**:

- `packages/x402/package.json`
- `packages/x402/src/charge/resource-server.ts`
- `packages/x402/src/pay/wallet.ts`
- `packages/x402/__tests__/resource-server.test.ts`, `packages/x402/__tests__/pay-wallet.test.ts` (error-path tests, only if mocking an absent module is feasible with the file's existing mock style — see Step 4)

**Out of scope**:

- `src/config.ts` — type-only imports are erased; no change.
- `@x402/core` / `@x402/fetch` — stay hard deps.
- `pnpm-workspace.yaml` catalogs — versions already live in `catalog:web3`; peer RANGES in package.json must be real semver ranges (see the gotcha below), so read the catalog to pick them.

## Git workflow

- Branch: `improve/wave22-x402`.
- Commit: `deps(x402): make chain toolchains optional peers`
- Commit body: note this is a breaking install-shape change (pre-1.0 alpha; consumers using SVM or raw-key EVM custody must install the peer).

## Steps

### Step 1: Move the four packages in the manifest

Remove `@solana/kit`, `@x402/evm`, `@x402/svm`, `viem` from `dependencies`. Add them to `peerDependencies` with real version ranges and to `peerDependenciesMeta` as `{ "optional": true }`, alongside the CDP entries. Add all four to `devDependencies` (`catalog:web3`) so the package's own tests/build still resolve them — exactly how `@coinbase/cdp-sdk` is handled today.

**Version-range gotcha (two rules):** (1) NEVER write `catalog:` in `peerDependencies` — it would publish the dev pin as the consumer's requirement; pnpm only warns, npm ERESOLVEs. Write a real range: look up each package's version in the `web3` catalog in `pnpm-workspace.yaml` and use `>=<major>.0.0` mirroring the CDP entries' style. (2) `peerDependencies` sorts BELOW `devDependencies` — run `pnpm run lint:package-json` (append `:fix` to autofix) after editing; key order has its own CI job that nothing else catches.

**Verify**: `pnpm install` → exit 0; `pnpm run lint:package-json` → exit 0.

### Step 2: Friendly errors in `resource-server.ts`

Wrap each of the two dynamic imports (`:28`, `:32`) in try/catch → `LunoraError("ENV_INVALID", …)` naming the missing peer and the network family that needs it, mirroring the CDP message shape, e.g.: `x402 charge: EVM networks need the optional @x402/evm + viem peers — install them, or configure an SVM network.` Check what `resource-server.ts` currently imports from `@lunora/errors` and add the import if absent.

**Verify**: `pnpm --filter "@lunora/x402" run lint:types` → exit 0.

### Step 3: Friendly errors in `wallet.ts`

Same wrap for the four dynamic imports at `:122` (viem/accounts), `:137` (@solana/kit), `:218` (@x402/evm/exact/client), `:222` (@x402/svm/exact/client), each naming its peer and the custody/network alternative, in the established message style.

**Verify**: `pnpm --filter "@lunora/x402" run lint:types` → exit 0; `pnpm --filter "@lunora/x402" run test` → all pass (peers are installed as devDeps, so happy paths unchanged).

### Step 4: Missing-peer error tests (best effort)

Look at how existing tests simulate the missing CDP peer (`grep -n "cdp-sdk" packages/x402/__tests__/pay-wallet.test.ts`). If a `vi.mock`-the-module-to-throw pattern exists, add one analogous case per family (EVM missing, SVM missing) asserting the `ENV_INVALID` code and that the message names the peer. If NO such pattern exists for CDP, skip this step (don't invent a new mocking strategy) and say so in your report.

**Verify**: `pnpm --filter "@lunora/x402" run test` → all pass.

## Test plan

Step 4, pattern-permitting. The main regression net is the existing suite passing with the peers now resolved via devDependencies.

## Done criteria

- [ ] `packages/x402/package.json` `dependencies` contains only `@lunora/errors`, `@x402/core`, `@x402/fetch`
- [ ] All four moved packages appear in `peerDependencies` (real ranges) + `peerDependenciesMeta` optional + `devDependencies` (`catalog:web3`)
- [ ] `pnpm run lint:package-json` exits 0
- [ ] Every dynamic `import()` of the four packages is wrapped with the `ENV_INVALID` friendly error (`grep -n 'await import("' packages/x402/src/` and inspect)
- [ ] `pnpm --filter "@lunora/x402" run test` exits 0
- [ ] `pnpm --filter "@lunora/x402" run lint:types` exits 0

## STOP conditions

- The manifest or import-site excerpts don't match the live code.
- The packem build fails because it tries to resolve/bundle the now-peer modules statically — report the exact error; bundler externals config is a maintainer decision.
- `pnpm install` produces unexpected resolution errors elsewhere in the workspace after the move.

## Maintenance notes

- Reviewer: check the published package still builds and that `dist/` doesn't inline any of the four peers (`pnpm run dist:check` covers production cleanliness).
- Consumers on EVM charge rails now need `@x402/evm` + `viem` installed explicitly; templates/examples using x402 (grep `examples/` for `@lunora/x402`) may need their manifests updated — out of scope here, note in the PR description if any exist.
