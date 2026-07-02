# Plan 087 — Structured error propagation across RPC + WS (Cap'n Web `["error", …]`)

> **Source:** Wave 9 Cap'n Web analysis. Cap'n Web serializes errors as
> `["error", name, message, stack?, props?]`, preserving the error class name and
> arbitrary application properties across the wire. Lunora flattens every error to
> `{ code, message }` and drops app-defined properties, so a
> `ConvexError`-style typed application error can't carry a structured payload to
> the client. This plan adds structured, **redaction-aware** error propagation.
>
> Builds on **plan 086**'s codec (shares the tagged-expression machinery and the
> encode/decode insertion points). Anchors at HEAD (`advisor/wave-8`); re-verify.

## 0. The gap, first-hand

- **RPC:** `packages/client/src/lunora-client.ts:2950-2954` — the client builds
  `new Error(body.error.message)` and copies only `.code`. Any structured payload
  an application threw is gone.
- **Server error envelope:** `RpcResponseBody`'s error arm is
  `{ error: { code: string; message: string } }` — two strings, no `data`, no
  `name`, no props.
- **WS:** the `error` frame is `{ type: "error", id?, message?, error?: { code?, message? } }`
  (client message union) — same two-string ceiling.

**Hard constraint — plan 064's redaction.** `shard-do.ts`'s RPC fall-through was
deliberately changed (plan 064, commit `dd340715`) to return a generic
`"internal error"` and log the raw message server-side, so internal errors never
leak to clients. This plan must **not** regress that: structured details are
propagated **only** for errors the application _opts into_ exposing — never for
uncaught/internal throws.

## 1. Design — an opt-in "public error" channel

Introduce (or reuse, if one already exists — check `@lunora/values`
`errors.ts` and `@lunora/server`) a tagged application error the developer throws
deliberately:

```ts
// thrown in a query/mutation/action handler
throw new LunoraError("RATE_LIMITED", "Slow down", { retryAfterMs: 3000 });
//                     code           message        data (public, structured)
```

Only `LunoraError` (name + code + JSON-serializable `data`) is propagated with
structure. Everything else keeps 064's behavior: generic message, server-side log.

Wire form, reusing 086's expression tags:

```json
["error", "LunoraError", "Slow down", null, { "code": "RATE_LIMITED", "data": { "retryAfterMs": 3000 } }]
```

`stack` stays `null` on the wire in production (only populated when a dev flag is
set — stacks are an info leak). `data` is encoded through 086's `encodeWire`, so a
`bigint`/`bytes` inside error data round-trips too.

## 2. Where it plugs in (anchored)

| #   | Concern              | File / anchor                                                | Change                                                                                                                                             |
| --- | -------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Error class          | `@lunora/server` (+ re-export `lunorash/server`)             | `LunoraError` (or bless an existing one) carrying `code` + JSON `data`. Named-export only (repo rule).                                             |
| 2   | Server classify/emit | `packages/do/src/shard-do.ts` (RPC catch + WS error path)    | `if (err instanceof LunoraError)` → emit `["error", name, msg, stack?, {code,data}]`; **else** keep 064's generic `"internal error"` + server log. |
| 3   | RPC error envelope   | `RpcResponseBody` error arm (`packages/client/src/types.ts`) | Widen to allow the structured form alongside the legacy `{code,message}` (back-compat).                                                            |
| 4   | Client RPC decode    | `packages/client/src/lunora-client.ts:2950`                  | If `error` is the structured form, rebuild a `LunoraError` with `.code` + `.data`; else current behavior.                                          |
| 5   | Client WS decode     | `packages/client/src/lunora-client.ts:3424` + error frame    | Same reconstruction for the `error` frame; surface `.data` to subscription error callbacks.                                                        |
| 6   | Adapters             | `@lunora/react` / `vue` / `solid` / `svelte`                 | Ensure `useMutation`/`useQuery` error state exposes `.code`/`.data` (mostly free once the client reconstructs the typed error).                    |

## 3. Scope fence

- **No stacks to clients in prod.** Gate behind an explicit dev flag; default off.
- **No structure for internal errors.** 064's redaction is the default path;
  structure is strictly opt-in via `LunoraError`. A verification test must assert
  a plain `throw new Error("db exploded")` still arrives as generic + is logged.
- **`data` must be JSON+086-encodable.** Reject/stringify non-encodable `data` at
  throw time (or on emit) so a bad `data` can't crash the error path itself.
- **No error chaining / `cause` graphs.** One level (Cap'n Web itself keeps errors
  flat — the `props` object, not a linked cause chain).

## 4. Verification plan

1. `@lunora/do` (workerd): `throw new LunoraError("X","msg",{n:1n})` in a mutation
   → client catches a `LunoraError` with `.code==="X"`, `.data.n===1n` (proves 086
   composition). A plain `throw new Error("secret")` → client sees generic message,
   raw logged server-side (064 regression guard).
2. Client unit: decode legacy `{code,message}` and new structured form both work
   (back-compat).
3. Adapter test: `useMutation` error state carries `.code`/`.data`.

## 5. Effort & risk

**S.** Small once 086 lands (shares codec + insertion points). Main risk is
**not** regressing 064 — the classify step must fail closed to the generic path
for anything that isn't an explicit `LunoraError`. Ship 086 first.

## 6. Open decisions

1. **New `LunoraError` vs. existing type** — check whether `@lunora/values`
   `errors.ts` or `@lunora/server` already exposes a public app-error; extend it
   rather than add a parallel one.
2. **Dev-stack flag name/source** — reuse an existing dev/debug env signal if one
   exists rather than inventing a new flag.
3. **Do subscriptions need per-frame typed errors**, or is the RPC path enough for
   v1? Recommend RPC first; WS error-frame structure is a fast follow.
