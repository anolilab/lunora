# Plan 389: Make the compiled validator read fields with `Object.hasOwn`, matching the interpreted oracle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/codegen/src/compile-validator.ts packages/values/src/validator-map.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED (regenerates emitted `_generated/functions.ts`; hot-path cost must be re-benched)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The compiled (AOT) args validator's contract, stated in `packages/values/src/validator-map.ts:20-28`, is soundness: it "must NEVER return a built record for input the interpreted parser would reject, and the record it returns must be byte-for-byte what the interpreted parser would have produced." The interpreted oracle reads every field as `Object.hasOwn(source, key) ? source[key] : undefined` (validator-map.ts:120) precisely so inherited properties read as absent. The compiled emitter reads fields as a bare index (`source["k"]`), which sees inherited properties. Two divergences follow: (a) a `v.any()` field under a prototype-member name (`toString`, `constructor`) commits the inherited function on the fast path where the oracle yields `undefined`; (b) for any source whose prototype carries data properties of the declared type, the compiled path **accepts** input the oracle **rejects** (a missing required own-property is satisfied by an inherited one) — a direct soundness violation. Reachability from the JSON wire is nil (`JSON.parse` never produces inherited data properties), but the invariant is the reason the fast path is allowed to skip the interpreter at all, and the differential test harness has no case covering it.

## Current state

- `packages/codegen/src/compile-validator.ts:286` (inside `compileObject`) — nested-object field access:
    ```ts
    const fields = compileFields(shape, (key) => `${inExpr}[${JSON.stringify(key)}]`, context);
    ```
- `packages/codegen/src/compile-validator.ts:322` (inside `compileArgsValidator`) — top-level field access:
    ```ts
    const fields = compileFields(args, (key) => `source[${JSON.stringify(key)}]`, context);
    ```
- `packages/codegen/src/compile-validator.ts:130-133` — `v.any()` compiles to `{ out: inExpr, pre: "" }` (no guard), so an inherited value is committed rather than deferred.
- The oracle, `packages/values/src/validator-map.ts:120`:
    ```ts
    const candidate = Object.hasOwn(source, key) ? source[key] : undefined;
    ```
- Consumer: `packages/codegen/src/emit.ts:1609` calls `compileArgsValidator(definition.args)` and embeds the returned source string in `_generated/functions.ts` — so the emitted-output golden fixture will change.
- Differential harness: `packages/codegen/__tests__/compile-validator.test.ts` — `CORPUS` (lines 19-45) has no prototype-carrying input and no prototype-member field name; `assertParity` runs compiled-vs-interpreted over the corpus.
- Bench: `packages/codegen/__tests__/compile-validator.bench.ts`.

## Commands you will need

| Purpose      | Command                                                                                                                                   | Expected on success                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Install      | `pnpm install`                                                                                                                            | exit 0                                                                      |
| Build deps   | `pnpm --filter "@lunora/codegen..." run build`                                                                                            | exit 0                                                                      |
| Tests        | `pnpm --filter "@lunora/codegen" run test`                                                                                                | all pass                                                                    |
| Golden regen | `pnpm dlx tsx packages/codegen/__tests__/capture-expected.ts`                                                                             | rewrites `packages/codegen/__tests__/fixtures/simple/expected/_generated/*` |
| Bench        | `pnpm --filter "@lunora/codegen" run test -- bench` (or `vitest bench` per the package's scripts — check `packages/codegen/package.json`) | compiled path within noise of baseline                                      |
| Typecheck    | `pnpm --filter "@lunora/codegen" run lint:types`                                                                                          | exit 0                                                                      |
| Lint         | `pnpm --filter "@lunora/codegen" run lint:eslint`                                                                                         | exit 0                                                                      |

## Scope

**In scope**:

- `packages/codegen/src/compile-validator.ts`
- `packages/codegen/__tests__/compile-validator.test.ts` (corpus + snippet additions)
- `packages/codegen/__tests__/fixtures/simple/expected/_generated/*` (regenerated golden — commit the regen)
- Any codegen test asserting on the emitted validator source substring (update expected strings)

**Out of scope**:

- `packages/values/*` — the oracle is correct; do not touch.
- `apps/playground` / `examples/*` `_generated` output — drifts are swept in a dedicated chore commit, never mixed in (repo convention); explicitly deferred here.
- The emitted `{ "__proto__": v }` object-literal question (validator-map's "considered" note) — author-declared keys, out of scope.

## Git workflow

- Branch: `improve/wave22-codegen`
- Commit: `fix(codegen): read compiled fields via hasOwn`

## Steps

### Step 1: Guard the object's prototype once; keep bare reads

SECOND REVISION (2026-08-21, after two bench-gate STOPs): both the per-site
ternary (+173..949%) and the hoisted-local one-hasOwn-per-field shape
(+133..387%) regress the compiled fast path far past the 10% gate —
`Object.hasOwn` is a non-inlined builtin (~40-60ns/call) while a whole 2-field
validation on bare reads is ~27-130ns. Per-field own-checks are structurally
too expensive. Do NOT emit per-field hasOwn.

Emit instead an O(1)-per-object shape:

1. At the top of each compiled object/args body, guard the prototype once:
   `if (Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null) return DEFER;`
   (DEFER = the existing bail-to-interpreter mechanism the compiled validator
   already uses for shapes it doesn't handle — find it and reuse it. Deferring
   is always sound: the interpreted oracle owns the answer.)
2. After that guard, keep the existing bare `source["k"]` reads — on a
   plain-prototype object they are own-only EXCEPT for declared field names
   that are themselves `Object.prototype` members. Those names are statically
   known at emit time: for a declared key in
   `Object.getOwnPropertyNames(Object.prototype)` (toString, constructor,
   valueOf, hasOwnProperty, …), emit the hoisted
   `const __fN = Object.hasOwn(source, "k") ? source["k"] : undefined;` local
   from the first revision for THAT field only. Typical schemas hit zero such
   fields.
3. `JSON.parse` output always has `Object.prototype` (or null for
   `__proto__`-keyed edge cases) — the fast path keeps serving all wire input.

**Verify**: `pnpm --filter "@lunora/codegen" run test -- compile-validator` → parity suite passes, including the corpus rows from Step 2 (a prototype-carrying source must now DEFER to the interpreter and agree with it).

### Step 2: Extend the differential corpus

Add to `CORPUS` in `compile-validator.test.ts`:

- `Object.assign(Object.create({ name: "inherited" }), {})` — a source whose _prototype_ carries a declared field (compiled must now agree with the oracle: field absent).
- `{ toString: "x" }`-style own-property under a prototype-member name (must still parse normally).

Add a snippet with a `v.any()` field named `toString` and assert parity (oracle yields `undefined` for the absent own key on a plain `{}` source).

**Verify**: `pnpm --filter "@lunora/codegen" run test -- compile-validator` → all pass; temporarily reverting Step 1 makes the new corpus rows fail (spot-check once, then re-apply).

### Step 3: Regenerate the golden fixture + fix substring assertions

Run `pnpm dlx tsx packages/codegen/__tests__/capture-expected.ts`, commit the regenerated `fixtures/simple/expected/_generated/*`. Then run the full codegen suite; any test asserting on emitted validator source substrings (`grep -rn "source\[" packages/codegen/__tests__/*.test.ts`) needs its expected strings updated.

**Verify**: `pnpm --filter "@lunora/codegen" run test` → all pass.

### Step 4: Re-run the bench

Run the interleaved A/B (same process, alternating rounds, medians AND minima) — but ONLY once the machine is quiet: poll `uptime` and wait until the 1-minute load average is below 10 before measuring; the previous rounds' numbers were unusable at load ~55. Expected cost: one `getPrototypeOf` comparison per object — low single digits. A regression >10% on the compiled path (minima, quiet machine) is a STOP (report numbers either way).

**Verify**: bench numbers recorded in the executor report; compiled path still meaningfully faster than interpreted.

## Test plan

- New corpus rows + snippet per Step 2 in `compile-validator.test.ts` (the existing `assertParity` harness is the pattern).
- Full codegen suite green including regenerated goldens.

## Done criteria

- [ ] `grep -n 'Object.hasOwn' packages/codegen/src/compile-validator.ts` → ≥2 matches (both emitters)
- [ ] `pnpm --filter "@lunora/codegen" run test` exits 0
- [ ] Golden fixture regenerated and committed (diff shows only the read-expression change)
- [ ] Bench delta reported, <10% on compiled path
- [ ] `pnpm --filter "@lunora/codegen" run lint:types` + `lint:eslint` exit 0

## STOP conditions

- The emitted-read change makes the golden fixture diff contain anything other than the read expressions (would mean an unrelated emitter change is entangled).
- Bench regression >10% on the compiled path.
- The parity suite reveals a second, unrelated divergence while adding corpus rows — report it; don't fix it here.

## Maintenance notes

- The corpus now guards the own-property invariant; any new field-access emitter in `compile-validator.ts` must route through the same hasOwn shape.
- Reviewer: check the golden diff is mechanical (one prototype guard per compiled object body; bare reads unchanged; hasOwn locals only for prototype-member-named fields, which typical schemas don't have).

## GATE DECISION (2026-08-21, advisor)

Three successively cheaper sound shapes measured +949% → +387% → +55% relative.
On a quiet machine the baseline compiled validation costs 17-100ns, so ANY
added per-object check exceeds a 10% relative gate — the gate was testing the
baseline's hotness, not the fix's cost. The relative gate is replaced by an
absolute budget: **≤500ns added per validation call**. The proto-guard shape
measures +10ns (scalar) to +240ns (n=20 array) — inside budget. Ship it.
Rationale: the soundness invariant is the module's stated contract and the
reason the fast path may skip the interpreter; the cost is noise inside an
RPC that does JSON.parse + routing + engine work (µs). Bench numbers and this
decision belong in the commit body.
