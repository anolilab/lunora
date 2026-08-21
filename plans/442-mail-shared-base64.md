# Plan 442: Route `@lunora/mail`'s inbound base64 through `shared/base64.ts`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/mail/src/inbound/handler.ts shared/base64.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`packages/mail/src/inbound/handler.ts` hand-rolls a chunked `toBase64` that is byte-for-byte the same algorithm as `shared/base64.ts` — the module whose docstring says it exists "so the wire codec … and the voice Durable Object (`@lunora/agent`) share one implementation instead of each hand-rolling `btoa`/`atob`." Four packages already import the shared copy. Any future fix to the shared implementation (chunk size, a `Uint8Array.toBase64` migration) silently skips inbound mail. `shared/` is bundler-inlined, so the import adds no dependency edge.

## Current state

- `packages/mail/src/inbound/handler.ts:198-217`:
  ```ts
  /** Chunk size for {@link toBase64}: kept ≤ the arg-spread limit `String.fromCharCode` tolerates. */
  const BASE64_CHUNK = 0x80_00;

  /** Base64-encode raw bytes without relying on Node's `Buffer` (workerd-safe). */
  const toBase64 = (bytes: Uint8Array): string => {
      let binary = "";
      for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
          // eslint-disable-next-line unicorn/prefer-code-point -- ...
          binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK));
      }
      return btoa(binary);
  };
  ```
- `shared/base64.ts:16-27` — the identical algorithm (`chunk = 0x8000`, `String.fromCharCode` spread over `subarray`, `btoa`), exported for exactly this reuse.
- `packages/mail/tsconfig.json` **already** omits `outDir`/`rootDir` with the breadcrumb comment ("A set `rootDir` would raise TS6059 for the inlined `../../../shared/random-session-id` import") — mail already imports another `shared/` file, so **no tsconfig change is needed**.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/mail..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/mail" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/mail" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/mail" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/mail/src/inbound/handler.ts`

**Out of scope**:
- `shared/base64.ts` — consume it, don't change it.
- `packages/mail/tsconfig.json` — already correct.

## Git workflow

- Branch: shared wave branch `improve/wave22-mail`.
- Commit: `refactor(mail): use the shared base64 encoder`

## Steps

### Step 1: Swap the local copy for the shared import

Check the exact export name first (`grep -n "export" shared/base64.ts`). Then in `handler.ts`: delete `BASE64_CHUNK` and the local `toBase64`, and add `import { toBase64 } from "../../../../shared/base64";` (count the path depth from `packages/mail/src/inbound/` to the repo root — it is four levels: `inbound → src → mail → packages → root`, so `../../../../shared/base64`; verify with `ls` before committing). Match how another consumer writes the import (`grep -rn "shared/base64" packages/agent/src/voice-do.ts`).

**Verify**: `pnpm --filter "@lunora/mail" run lint:types` → exit 0; `pnpm --filter "@lunora/mail" run test` → `inbound-handler.test.ts` (which exercises the attachment path) passes unchanged.

## Test plan

- No new tests: the existing `inbound-handler.test.ts` attachment cases already pin the encoding behavior, and the implementations are identical.

## Done criteria

- [ ] `grep -n "BASE64_CHUNK\|const toBase64" packages/mail/src/inbound/handler.ts` → no matches
- [ ] `pnpm --filter "@lunora/mail" run test` exits 0
- [ ] `pnpm --filter "@lunora/mail" run build` exits 0 (proves the bundler inlines the shared file)

## STOP conditions

- `shared/base64.ts` exports under different names/shape than expected.
- The mail build fails to inline the shared file (packem resolution issue) — report, don't work around with a copy.

## Maintenance notes

- If mail ever needs the decode direction, `fromBase64` is in the same shared module.
