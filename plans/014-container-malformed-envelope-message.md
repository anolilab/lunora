# Plan 014: Container bridge surfaces the partial error on a malformed envelope

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/container/src/bridge.ts`
> Reconcile excerpt on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

When the container→Cirrus bridge receives an error envelope whose `code`/
`message` are missing or the wrong type, it throws a generic "malformed error
envelope" with no detail. A server legitimately returning, say,
`{ error: { code: "NOT_FOUND" } }` (no `message`) gives the developer nothing to
debug. Including the partial error payload in the thrown message keeps the
strictness (it still throws) while making the failure diagnosable.

## Current state

`packages/container/src/bridge.ts:165-179`:

```ts
const body = await parseResponseBody(response, functionPath);
if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body;
    if (typeof error === "object" && error !== null) {
        const { code, message } = error as { code?: unknown; message?: unknown };
        if (typeof code === "string" && typeof message === "string") {
            throw new ContainerBridgeError(code, message);
        }
    }
    throw new Error(`createContainerBridge: request to "${functionPath}" returned a malformed error envelope (status ${String(response.status)})`);
}
```

## Commands

| Purpose           | Command                                            | Expected |
| ----------------- | -------------------------------------------------- | -------- |
| Build deps (once) | `pnpm run build:packages`                          | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/container" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/container" run test`       | all pass |

## Scope

**In scope**: `packages/container/src/bridge.ts` (the malformed-envelope throw)

- the bridge test file.
  **Out of scope**: the well-formed `ContainerBridgeError` path, response parsing,
  auth/token handling.

## Steps

### Step 1: Include the partial error payload in the message

Change the fallback throw to serialize the offending `error` value (guard against
circular/huge payloads with a try/catch around `JSON.stringify`):

```ts
let detail: string;
try {
    detail = JSON.stringify(error);
} catch {
    detail = String(error);
}
throw new Error(`createContainerBridge: request to "${functionPath}" returned a malformed error envelope ` + `(status ${String(response.status)}): ${detail}`);
```

Do not weaken the strictness — it must still throw; this only enriches the
message. (Note: `error` here is bridge-internal/dev-facing; this is not user PII.)

**Verify**: `pnpm --filter "@cirrus/container" run lint:types` → exit 0.

### Step 2: Test

Add a test: a response with `{ error: { code: "NOT_FOUND" } }` (missing
`message`) throws an `Error` whose message contains `NOT_FOUND` (proving the
partial payload is surfaced). Keep/confirm the existing well-formed-error test
still throws `ContainerBridgeError`. Model on existing bridge tests.

**Verify**: `pnpm --filter "@cirrus/container" run test` → all pass.

## Done criteria

- [ ] Malformed-envelope error message includes the partial error payload
- [ ] Well-formed `ContainerBridgeError` path unchanged
- [ ] `pnpm --filter "@cirrus/container" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/container" run test` exits 0 with new case
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- The throw site no longer matches the excerpt.

## Maintenance notes

- Reviewer: confirm the `JSON.stringify` is guarded so a circular payload can't
  itself throw.
