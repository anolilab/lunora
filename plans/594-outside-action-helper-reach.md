# Plan 594 — "outside action" lints in helpers and separate handlers (rejected)

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** REJECTED — the type system already refuses the pattern; see §1.
**Source:** row 56 of the 2026-11-11 audit (advisor lints), reported at MED confidence and never re-opened.

## 0. Headline finding (as reported)

`packages/codegen/src/discover/context-property-calls.ts:76` walks only exported declarations and the
inline handler, so `hyperdrive_outside_action` and `r2sql_outside_action` miss `ctx.sql` / `ctx.r2sql`
reached through a helper or a separately declared handler. The audit asked whether the type system
already rejects passing a query ctx to such a helper.

## 1. Evidence (re-verified at `79b0c5a6a`)

- `ctx.sql` and `ctx.r2sql` exist only on the action context. `packages/codegen/src/capabilities.ts:352-378`
  (Hyperdrive) and `:484-500` (R2 SQL) declare `serverCtxField: readonly sql: …SqlClient` /
  `readonly r2sql: …R2SqlClient` with `tier: "action"`, and `packages/codegen/src/emit/server.ts:209-215`
  emits a capability's field only into the contexts of its tier. `QueryCtx` / `MutationCtx`
  (`packages/server/src/types.ts:2548, 2638`) carry neither field.
- So a helper typed to use `ctx.sql` takes an action context (or a type with a required `sql`), and
  passing a query or mutation `ctx` to it fails `tsc` with a missing-property error. The inline case the
  lint covers is likewise a type error; the lint is a backstop for code that bypasses the types
  (`as any`, an untyped helper), and widening its reach to helpers only adds more of that backstop
  at the cost of the call-site attribution work the audit sketched.

## 2. Not done

No code change. If the generated ctx types ever add `sql`/`r2sql` to the query or mutation context,
reopen this.
