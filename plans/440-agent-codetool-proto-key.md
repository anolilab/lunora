# Plan 440: Refuse `__proto__` as an object key when resolving code-tool step inputs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/agent/src/code-tool.ts packages/agent/__tests__/code-tool.test.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`resolveReferences` rebuilds a model-controlled input object by assigning into a plain `{}` accumulator: `resolved[key] = …`. When `key === "__proto__"` (an *own* property after `JSON.parse`, which is exactly what a model-emitted tool input is), the assignment invokes `Object.prototype`'s setter and replaces the accumulator's prototype instead of creating an own property. A prompt-injected model can hand a composed tool an input whose own keys look benign but that resolves inherited properties (`input.isAdmin`, `input.internal`) through a prototype it chose. The *read* side of this same file (`getPath`) was already hardened with `Object.hasOwn` and has a `__proto__` test; the write side got neither. Same class as the shipped wire-codec `__proto__` fix (plan 103). `JSON.stringify` drops inherited keys, so RPC-forwarded tools are safe — the exposure is any in-process `AgentToolDefinition.execute` reading `input.x` directly.

## Current state

- `packages/agent/src/code-tool.ts:129-135`:
  ```ts
  const resolved: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(object)) {
      resolved[key] = resolveReferences(nested, results);
  }

  return resolved;
  ```
- The hardened read side, same file (`getPath`, ~`:88-100`), uses `Object.hasOwn` per segment; its docstring names `__proto__`/`constructor`/`prototype`.
- Existing test: `packages/agent/__tests__/code-tool.test.ts:52` probes `$path: "__proto__"` / `"constructor"` on the read side.
- Input reaches here unfiltered: `CODE_TOOL_SCHEMA` declares `input` as `{ additionalProperties: true, type: "object" }` and `generate.ts` registers the tool with no custom validator.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/agent..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/agent" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/agent" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/agent" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/agent/src/code-tool.ts` (`resolveReferences` only)
- `packages/agent/__tests__/code-tool.test.ts`

**Out of scope**:
- `getPath` — already hardened.
- The tool JSON schema / `generate.ts` registration — the guard belongs in the pure function all inputs flow through.

## Git workflow

- Branch: shared wave branch `improve/wave22-agent`.
- Commit: `fix(agent): guard proto keys in code-tool input resolution`

## Steps

### Step 1: Skip unsafe keys in the accumulator loop

In `resolveReferences`, skip `"__proto__"`, `"constructor"`, and `"prototype"` keys when rebuilding the object (mirroring `getPath`'s named set — hoist a shared `const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])` if `getPath` can use it too without behavior change; otherwise a local check is fine):

```ts
for (const [key, nested] of Object.entries(object)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
    }

    resolved[key] = resolveReferences(nested, results);
}
```

Skipping (not throwing) matches how `JSON.stringify`-based forwarding already behaves for inherited keys and cannot break any legitimate tool input. Do not switch the accumulator to `Object.create(null)` — a null-prototype object changes downstream `instanceof`/spread expectations less predictably than a key skip, and the skip is the smaller diff.

**Verify**: `pnpm --filter "@lunora/agent" run test -- code-tool` → existing suite passes.

### Step 2: Mirror-image test

Next to the existing `$path: "__proto__"` case (`code-tool.test.ts:52`), add: resolving `JSON.parse('{"__proto__": {"isAdmin": true}, "a": 1}')` yields an object whose own keys are exactly `["a"]`, whose prototype is `Object.prototype` (unchanged), and where `(resolved as any).isAdmin === undefined`. Add the `constructor`/`prototype` key variants in the same test.

**Verify**: `pnpm --filter "@lunora/agent" run test -- code-tool` → all pass including the new case.

## Test plan

- The Step 2 test, modeled on the existing `resolveReferences` tests in the same file.

## Done criteria

- [ ] `pnpm --filter "@lunora/agent" run test` exits 0 with the new test
- [ ] `pnpm --filter "@lunora/agent" run lint:types` exits 0
- [ ] Reading the diff: the only behavior change is the three skipped keys

## STOP conditions

- The excerpts don't match the live code.
- Any existing test legitimately passes a `constructor` data key (would indicate the skip breaks a real input shape) — report before choosing throw-vs-skip.

## Maintenance notes

- If a future change replaces the accumulator entirely (e.g. structuredClone-based), keep the unsafe-key test — it is the regression tripwire.
