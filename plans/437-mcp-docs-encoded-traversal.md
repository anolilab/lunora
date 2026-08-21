# Plan 437: Reject percent-encoded dot segments in the MCP docs `url` argument

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/mcp/src/docs/tools.ts packages/mcp/__tests__/`
> On any in-scope change, compare the "Current state" excerpts against the
> live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`normalizeDocUrl` guards the docs-page fetch against path traversal, but only against *literal* `..` segments. The normalized path is concatenated into a fetch URL (`${baseUrl}/llms.mdx${url}`), and WHATWG URL parsing — which `fetch` applies — decodes and collapses percent-encoded dot segments, so `"/docs/%2e%2e/%2e%2e/api/search"` resolves to `/api/search` on the docs origin. A model calling `lunora_get_doc` with an encoded-traversal `url` fetches an arbitrary path on the configured docs origin and returns its body into the model context. The guard's own docstring names the threat: "less so against the internal host a self-hosted `--docs-url` may point at." The sibling `search` path already encodes its query; this path is the inconsistent one.

## Current state

- `packages/mcp/src/docs/tools.ts` — `normalizeDocUrl` ends with the only traversal check:
  ```ts
  if (value.split("/").includes("..")) {
      throw new RangeError(`"url" must not contain ".." segments: ${raw}`);
  }

  return value;
  ```
  The docstring above it (same file, ~line 140) explains the guard's purpose ("would walk back out of the documentation tree…").
- `packages/mcp/src/docs/remote-index.ts:186` — `fetchImplementation(\`${baseUrl}${path}\`, …)`; `:213` — `getPage` calls `get(\`/llms.mdx${url}\`)`. No decoding happens between the guard and the fetch — the collapse happens *inside* URL parsing at fetch time.
- `packages/mcp/src/docs/remote-index.ts:243` — the `search` sibling uses `encodeURIComponent(query)`.
- Existing test suite: `packages/mcp/__tests__/docs-tools.test.ts` (verify exact name with `ls packages/mcp/__tests__/ | grep -i doc`) already covers `normalizeDocUrl` rejections — extend it.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/mcp..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/mcp" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/mcp" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/mcp" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/mcp/src/docs/tools.ts` (`normalizeDocUrl` only)
- The docs tools test file in `packages/mcp/__tests__/`

**Out of scope**:
- `remote-index.ts` — keep the fetch-side concatenation as is; the fix belongs in the one validation choke point.
- The `search` path — already safe.

## Git workflow

- Branch: shared wave branch `improve/wave22-mcp`.
- Commit: `fix(mcp): reject encoded dot segments in docs urls`

## Steps

### Step 1: Decode-then-check in `normalizeDocUrl`

After the existing normalization (origin strip, query/hash drop, trailing-slash trim, slug prefixing) and before returning, replace the literal-only check with a per-segment decode + check:

```ts
for (const segment of value.split("/")) {
    let decoded: string;

    try {
        decoded = decodeURIComponent(segment);
    } catch {
        throw new RangeError(`"url" contains a malformed percent-escape: ${raw}`);
    }

    if (decoded === ".." || decoded === "." || decoded.includes("%")) {
        throw new RangeError(`"url" must not contain dot or encoded segments: ${raw}`);
    }
}
```

Rationale for rejecting residual `%` after one decode: double-encoding (`%252e`) must not survive to the fetch layer, and no legitimate docs slug contains a percent sign. Keep the original literal `..` error message shape if the test suite asserts on it — adjust wording to cover both cases rather than breaking existing assertions gratuitously.

**Verify**: `pnpm --filter "@lunora/mcp" run test` → existing docs-tools tests pass.

### Step 2: Tests

Add cases to the existing `normalizeDocUrl` rejection tests: `"/docs/%2e%2e/%2e%2e/api/search"`, `"/docs/%2E%2E/x"`, `"/docs/%252e%252e/x"`, `"/docs/a%2Fb/.."` (malformed/mixed), and one accepting case with an ordinary hyphenated slug to prove no over-rejection.

**Verify**: `pnpm --filter "@lunora/mcp" run test` → all pass including the new cases.

## Test plan

- New rejection tests as above, in the existing docs tools test file, modeled on its current RangeError assertions.

## Done criteria

- [ ] `pnpm --filter "@lunora/mcp" run test` exits 0 including ≥4 new traversal cases
- [ ] `pnpm --filter "@lunora/mcp" run lint:types` exits 0
- [ ] `node -e 'const u = new URL("https://x.test/llms.mdx" + "/docs/%2e%2e/%2e%2e/api/search"); console.log(u.pathname)'` still shows `/api/search` (documents the hazard the guard now blocks) — and the new guard rejects that input in a unit test.

## STOP conditions

- The excerpts don't match the live code.
- Legitimate documented slugs in the repo's own docs contain `%` or dots-as-segments (check a handful of real doc paths if unsure) — report instead of loosening silently.

## Maintenance notes

- If the docs tool ever accepts anchors or query params again, they are stripped *before* this check — keep it that way so the guard sees the final path.
- Reviewer: confirm the error type stays `RangeError` (or whatever the dispatch layer maps to a directed tool error) so the model gets a usable message.
