# Plan 103: Harden wire-codec error decode against the `__proto__` setter via `Object.assign`

> **Executor instructions**: This plan has an INVESTIGATE-first step — confirm
> the vulnerability reproduces before changing code. Follow step by step; run each
> verify. STOP conditions halt you. Update `plans/README.md` when done unless a
> reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- shared/wire-codec.ts`
> If the codec changed, re-read it before proceeding.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (correctness / low-confidence — verify first)
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

The Cap'n-Web-inspired wire codec (`shared/wire-codec.ts`) carefully avoids the
`__proto__` prototype-setter footgun in its object branch (writing a wire
`__proto__` key with `Object.defineProperty` so it becomes an own data property,
not a prototype mutation — Cap'n Web #190). But the **error** decode branch
reconstructs the error and then does `Object.assign(error, decodeWire(value[4]))`.
`decodeWire` returns an object that may carry `__proto__` as an own enumerable
data property; `Object.assign` copies own enumerable props with `[[Set]]`
semantics, which **invokes the `__proto__` setter** on the reconstructed `error`.
A hostile decode payload `[TAG,"error","Error","msg",{"__proto__":{…}}]` would
therefore swap that one Error object's prototype. Impact is bounded (it changes
one reconstructed Error's prototype, not global `Object.prototype`), so this is
LOW-confidence/low-severity — but it is an inconsistency with the object branch's
own hard-won `defineProperty` handling on the untrusted decode path, and worth
aligning.

## Current state

Error decode branch (`shared/wire-codec.ts:353-370`):
```ts
                    const Ctor = (Object.hasOwn(ERROR_CTORS, name) ? ERROR_CTORS[name] : undefined) ?? Error;
                    const error = new Ctor(message) as Error & Record<string, unknown>;
                    if (error.name !== name) {
                        Object.defineProperty(error, "name", { configurable: true, value: name, writable: true });
                    }
                    Object.assign(error, decodeWire(value[4], depth + 1) as Record<string, unknown>);   // <-- line 361
                    if (value.length > 5) {
                        Object.defineProperty(error, "cause", { configurable: true, value: decodeWire(value[5], depth + 1), writable: true });
                    }
                    return error;
```

The object branch that does it correctly (`shared/wire-codec.ts:410-426`):
```ts
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
        const decoded = decodeWire(source[key], depth + 1);
        if (key === UNSAFE_KEY) {   // UNSAFE_KEY = "__proto__" (line 86)
            Object.defineProperty(result, key, { configurable: true, enumerable: true, value: decoded, writable: true });
        } else {
            result[key] = decoded;
        }
    }
    return result;
```

`UNSAFE_KEY = "__proto__"` is defined at `shared/wire-codec.ts:86`.

Existing codec tests: `packages/client/__tests__/wire-codec.test.ts` (and
`wire-rpc.test.ts`). `shared/wire-codec.ts` is bundler-inlined into
`@lunora/client`, `@lunora/do`, `@lunora/runtime` (see `CLAUDE.md` "shared/"
notes) — it is dependency-free and imported by relative path.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Run the codec test | `pnpm --filter "@lunora/client" run test -- wire-codec` | all pass |
| Typecheck client | `pnpm --filter "@lunora/client" run lint:types` | exit 0 |
| Build (deps) | `pnpm --filter "@lunora/client..." run build` | exit 0 |

(The codec lives in `shared/` but is verified through a consumer — `@lunora/client`
inlines it and has the test suite.)

## Scope

**In scope**:
- `shared/wire-codec.ts` — the error decode branch's property-merge (line ~361).
- `packages/client/__tests__/wire-codec.test.ts` — add a regression test.

**Out of scope**:
- The object branch (already correct).
- The encode path.
- Any consumer package source — the fix is inline in `shared/` and picked up by
  the bundler.

## Git workflow

- Branch: `advisor/103-wire-codec-error-proto-assign`
- Commit: `fix(wire-codec): avoid __proto__ setter when merging decoded error props`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: INVESTIGATE — reproduce the setter invocation

Before changing code, write a failing/confirming test in
`packages/client/__tests__/wire-codec.test.ts` that decodes a hand-built wire
error payload whose props object contains a `__proto__` key, e.g. the array form
the codec expects for an error (read the encode branch to get the exact tuple
shape — `[TAG, "error", name, message, propsObject, cause?]`). Assert on the
decoded error's prototype: does `Object.getPrototypeOf(decoded)` get swapped away
from the expected `Error.prototype` (or the ctor's prototype)?

- If the prototype IS swapped → vulnerability confirmed; proceed to Step 2.
- If it is NOT swapped (e.g. `decodeWire`'s object branch already returned the
  `__proto__` as a non-`[[Set]]`-triggering own property such that `Object.assign`
  copies it harmlessly, OR the encode path never emits `__proto__` in the props
  slot) → **STOP** and report "not reproducible; finding does not hold at
  `fc9c915b`". Do not change code for a non-issue.

**Verify**: the test demonstrates the current behavior unambiguously (swapped or not).

### Step 2: Fix the merge

Replace the `Object.assign(error, decodeWire(value[4], …))` with a key-wise merge
that mirrors the object branch's `UNSAFE_KEY` handling. Extract a small shared
helper if clean (e.g. `assignDecodedProps(target, source)`), or inline:
```ts
const props = decodeWire(value[4], depth + 1) as Record<string, unknown>;
for (const key of Object.keys(props)) {
    if (key === UNSAFE_KEY) {
        Object.defineProperty(error, key, { configurable: true, enumerable: true, value: props[key], writable: true });
    } else {
        (error as Record<string, unknown>)[key] = props[key];
    }
}
```
Note: `decodeWire(value[4])` already recursed, so `props` values are decoded —
do not re-decode. (The object branch decodes per-key; here `value[4]` is decoded
once as a whole. Confirm `value[4]` is the props object and that decoding it
whole vs per-key yields equivalent results — it should, since the object branch
IS what decodes it. Keep the single decode.)

**Verify**: the Step 1 test now shows the prototype is NOT swapped;
`pnpm --filter "@lunora/client" run test -- wire-codec` → all pass.

### Step 3: Confirm no regression to normal error props

Ensure ordinary error props (custom fields like `code`, `data`) still round-trip
onto the reconstructed error — the existing error-roundtrip tests must still pass.

**Verify**: `pnpm --filter "@lunora/client" run test -- wire-codec` → all pass,
including pre-existing error-roundtrip cases.

## Test plan

- Add to `packages/client/__tests__/wire-codec.test.ts`:
  - Regression: a wire error payload with `__proto__` in its props does not swap
    the decoded error's prototype (asserts `Object.getPrototypeOf(decoded) ===`
    the expected prototype), and the `__proto__` value is present as an own data
    property.
  - A wire error with normal custom props (`code`, `data`) still reconstructs
    them onto the error (regression).
- Verification: `pnpm --filter "@lunora/client" run test -- wire-codec` → all pass.

## Done criteria

- [ ] The error decode branch no longer uses `Object.assign` for the props merge (or is otherwise proven not to invoke the `__proto__` setter).
- [ ] A regression test asserts a `__proto__`-bearing error payload does not swap the reconstructed error's prototype.
- [ ] `pnpm --filter "@lunora/client" run test -- wire-codec` and `run lint:types` exit 0.
- [ ] `git status` shows only `shared/wire-codec.ts` + the client test file.
- [ ] `plans/README.md` status row updated (mark REJECTED with the reason if Step 1 shows it doesn't reproduce).

## STOP conditions

- Step 1 shows the prototype is NOT swapped at `fc9c915b` → the finding does not
  hold; STOP, mark the plan REJECTED in the index with "not reproducible — Object.assign path does not invoke the setter here", do not change code.
- The encode path is found to never place a `__proto__` key in the props slot AND
  the decode is unreachable with such a payload from any real transport → same
  as above; the fix is defense-in-depth only — note that and let the operator
  decide whether to ship it.
- The single-decode vs per-key-decode equivalence is unclear — STOP and report
  rather than risk changing decode semantics.

## Maintenance notes

- Any future place that merges wire-decoded properties onto a target object must
  use the `UNSAFE_KEY` guard, never bare `Object.assign`/spread. The codec has two
  such sites now (object branch + error branch); keep them consistent.
- A reviewer should confirm the fix doesn't alter the `cause` handling (line 366,
  already uses `defineProperty` — leave it).
