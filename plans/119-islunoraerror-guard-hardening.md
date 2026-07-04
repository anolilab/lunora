# Plan 119: [Investigate] Harden isLunoraError so foreign errors can't ride the non-internal echo path

> **Executor instructions**: This is an INVESTIGATE-FIRST plan. Steps 1–2
> establish facts and a failing test; Step 3 is conditional on what they show.
> Follow it step by step, run every verification command, and honor the STOP
> conditions — do not improvise. When done, update the status row for this
> plan in `plans/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/errors/src/ shared/wire-codec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: MED (tightening the guard can re-open the redaction gap it fixed)
- **Depends on**: plans/117-errors-redaction-quick-wins.md and
  plans/118-error-envelope-consolidation.md (they route more traffic through
  the seam this plan changes — land them first so tests exist)
- **Category**: security
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`toErrorBody` (the single wire-redaction seam) echoes an error's raw `.message`
to the client whenever `isLunoraError(error)` is true and the code is
non-internal. But `isLunoraError` is **structural and loose**: any `Error`
carrying a string `code` and a numeric `status` passes. A thrown third-party
error that happens to have both fields (HTTP-client and DB-driver error shapes
commonly do — e.g. a fetch-wrapper error with `code: "ECONNREFUSED"`-style
strings plus a numeric `status`) is then treated as a _deliberately
client-safe_ error and its internal message crosses the wire, instead of being
redacted to the generic fallback. The looseness is **deliberate** (see the
docstring below): `instanceof` fails across the workerd DO↔worker RPC boundary
and for wire-decoded twins, and the structural predicate is what fixed a prior
bug where legitimate Lunora subclass errors were wrongly redacted. So the fix
must add a discriminator that (a) survives the wire codec, (b) survives
DO↔worker RPC, and (c) doesn't break app-authored custom codes — which is why
this is investigate-first.

## Current state

- `packages/errors/src/guards.ts:25-33`:

    ```ts
    export const isLunoraError = (error: unknown): error is LunoraErrorLike => {
        if (!(error instanceof Error)) {
            return false;
        }

        const candidate = error as { code?: unknown; status?: unknown };

        return typeof candidate.code === "string" && typeof candidate.status === "number";
    };
    ```

    Its file docstring explains the deliberate looseness: "`instanceof
LunoraError` is unreliable across the workerd DO↔worker RPC boundary and for
    errors rebuilt from the wire (which decode to a plain `Error` carrying the
    copied own props)."

- `packages/errors/src/to-error-body.ts:53-77` — non-internal + `isLunoraError`
  ⇒ `body.message = error.message` (the echo path).
- `packages/errors/src/base.ts:60,80,91` — `LunoraError`'s constructor accepts
  `LunoraErrorCodeInput = LunoraErrorCode | (string & {})`, i.e. **apps may
  throw custom, non-catalog codes** — so "code must be in ERROR_CATALOG" is
  NOT a valid tightening (it would redact intentional app errors).
- `shared/wire-codec.ts:361-376` — the error-decode path copies **own
  enumerable props key-wise** onto a rebuilt `Error` (with a `__proto__`
  guard). So any own data property set by `LunoraError`'s constructor WILL
  survive the wire and appear on the decoded twin.

## Commands you will need

| Purpose                 | Command                                                                          | Expected on success |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------- |
| Errors tests            | `pnpm --filter "@lunora/errors" run test`                                        | all pass            |
| Client wire-codec tests | `pnpm --filter "@lunora/client" run test`                                        | all pass            |
| DO RPC-boundary tests   | `pnpm --filter "@lunora/do..." run build && pnpm --filter "@lunora/do" run test` | all pass            |
| Types                   | `pnpm --filter "@lunora/errors" run lint:types`                                  | exit 0              |

## Scope

**In scope**:

- `packages/errors/src/{guards,base}.ts`
- `packages/errors/__tests__/`
- `shared/wire-codec.ts` ONLY if the investigation shows the discriminator
  needs explicit encode support (it should not — own props already round-trip)
- One failing-then-passing regression test in the transport-seam suites
  (`packages/do/__tests__/` or `packages/runtime/__tests__/errors.test.ts`)

**Out of scope**:

- `to-error-body.ts` logic (the guard is the knob; the seam stays as-is)
- Client-side error reconstruction in `packages/client` (it builds real
  errors from decoded bodies — different layer)
- Any change to which codes are `internal` (plan 117 handled that)

## Git workflow

- Branch: `advisor/119-islunoraerror-guard`
- Suggested commit: `security(errors): brand LunoraError so foreign errors don't ride the echo path`

## Steps

### Step 1: Establish the leak with a failing test

In `packages/errors/__tests__/` add (temporarily expected-to-fail, flip at the
end):

```ts
it("does not echo a foreign error that merely has code+status", () => {
    const foreign = Object.assign(new Error("internal driver detail: host=10.0.0.5"), { code: "PROTOCOL_ERROR", status: 502 });
    const { body, redacted } = toErrorBody(foreign);

    expect(redacted).toBe(true);
    expect(body.message).not.toContain("10.0.0.5");
});
```

**Verify**: the test FAILS at `b6eb48dcd` behavior (message echoed) — this
confirms the finding is still live. If it already passes, STOP (someone fixed
it independently; mark the plan REJECTED in the index).

### Step 2: Inventory what must keep matching

Enumerate, with file:line evidence in your report, every producer whose errors
must still satisfy the guard after tightening:

1. Real `LunoraError` instances and subclasses (`NotUniqueError` at
   `packages/do/src/ctx-db.ts:1133`, `LunoraEnvError` at
   `packages/server/src/env.ts:203`, `LunoraAuthHeadersError` at
   `packages/auth/src/middleware.ts:108`, `WorkflowsRestError` in
   `packages/workflow/src/rest-api.ts`, …) — find the full set with
   `grep -rn "extends LunoraError" packages/*/src`.
2. **Wire-decoded twins**: run the round-trip in a test — encode a
   `LunoraError` with `shared/wire-codec.ts`'s encoder, decode it, and inspect
   which own props the twin carries (`Object.keys(decoded)`). Record whether
   `name` and any brand prop survive.
3. **DO↔worker RPC copies**: check how `packages/do/__tests__/` simulates the
   boundary (search for existing tests asserting `isLunoraError` or the
   RPC error mapping, e.g. the plan-064 redaction test) and what shape those
   errors have.

### Step 3: Implement the brand (conditional on Step 2)

Recommended design (adjust only per Step 2's facts):

1. In `packages/errors/src/base.ts`, have `LunoraError`'s constructor set an
   **own enumerable data property** brand, e.g.
   `this.type = "LunoraError"` (matching the `@visulima/error` shape the class
   already mirrors — check whether a `type` prop already exists; if so, reuse
   it). Own+enumerable is required so the wire codec copies it (Step 2.2
   verifies).
2. Extend `guards.ts`:

    ```ts
    return typeof candidate.code === "string" && typeof candidate.status === "number" && candidate.type === "LunoraError";
    ```

3. Run the full transport-seam suites. Every failure is a producer from Step 2
   that doesn't carry the brand — fix the _producer_ (make it a real
   `LunoraError` / carry the brand), never by loosening the guard again.

**Verify**: Step 1's test now PASSES; `pnpm --filter "@lunora/errors" run test`,
`pnpm --filter "@lunora/client" run test`, `pnpm --filter "@lunora/do" run test`,
`pnpm --filter "@lunora/runtime" run test` → all pass.

## Test plan

- Step 1's foreign-error test (the regression this plan exists for).
- A wire round-trip test: encode→decode a `LunoraError`, assert
  `isLunoraError(decoded) === true` (the twin keeps matching).
- A subclass test: `NotUniqueError` (import from `@lunora/do`) passes the
  guard.
- Negative: plain `Error` and `Object.assign(new Error(), { code: 1, status: "x" })`
  fail the guard (existing behavior, keep covered).

## Done criteria

- [ ] Foreign-error test passes (leak closed)
- [ ] Wire-twin round-trip test passes (no re-opened redaction gap)
- [ ] All four package suites above pass; `lint:types` exit 0
- [ ] Report includes the Step 2 inventory table
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's test already passes (independent fix landed — mark REJECTED).
- Step 2.2 shows the wire codec does NOT round-trip own enumerable props onto
  decoded error twins (the brand strategy is then invalid — report; do not
  invent an alternative encode format).
- Step 2.3 shows the DO↔worker RPC boundary strips own props (same reason).
- More than ~5 producer sites fail after the brand lands — the blast radius
  exceeds this plan's estimate; report the list instead of fixing them all.
- Any app-facing documented pattern constructs Lunora-compatible errors as
  plain objects (grep docs for `code:` + `status:` construction examples) —
  tightening would break documented userland code.

## Maintenance notes

- The brand becomes part of the wire contract: the codec must keep copying own
  enumerable props on the error-decode path (`shared/wire-codec.ts:361-376`) —
  a reviewer touching that path should know `isLunoraError` depends on it.
- Anyone adding a new transport edge must construct real `LunoraError`s (or
  brand-carrying twins), not shape-alike literals.
- If Step 2 kills the brand approach, the fallback design to evaluate in a
  future plan: an allow-list of known wire codes + explicit opt-in for app
  codes (worse DX; that's why it's not the primary).
