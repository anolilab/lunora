# @lunora/errors

The unified error layer for Lunora: one `LunoraError` base and a central catalog of error
**codes**, transport **statuses**, and actionable **hints**, surfaced consistently across the CLI,
the Vite overlay, the Studio UI, and the client SDK.

## Why

Before this package, error handling was fragmented — many bespoke `Error` subclasses, two conflicting
`LunoraError` classes, and brittle `name === "…"` string-matching to map errors across the wire. Only
codegen errors carried a "here's how to fix it" hint. `@lunora/errors` unifies all of that.

## Usage

```ts
import { LunoraError, isLunoraError } from "@lunora/errors";

// Code fills in status/title/hint from the catalog.
throw new LunoraError("NOT_FOUND", `no message with id ${id}`);

// Attach structured data + an actionable hint.
throw new LunoraError("TOO_MANY_REQUESTS", "slow down", { data: { retryAfterMs: 1_000 } });

// Realm-safe structural guard (works on wire-decoded errors too).
if (isLunoraError(error)) {
    console.log(error.code, error.status, error.hint);
}
```

Invariants participate too:

```ts
import { invariant, unreachable } from "@lunora/errors";

invariant(table !== undefined, `unknown table: ${name}`); // throws an INTERNAL LunoraError
```

### Rendering (CLI / Node only)

The terminal renderer lives on a separate subpath so the Node-only code never reaches browser/worker
bundles:

```ts
import { renderLunoraError } from "@lunora/errors/render";

console.error(renderLunoraError(error, { reason: "codegen failed" }));
```

## Exports

- `@lunora/errors` — `LunoraError`, `ERROR_CATALOG`, `isLunoraError`, `resolveHint`,
  `findSolutionByMessage`, `invariant`, `unreachable`, and the supporting types. **Browser/workerd-safe.**
- `@lunora/errors/render` — `renderLunoraError` + `renderError`/`VisulimaError` re-exports. **Node only.**
