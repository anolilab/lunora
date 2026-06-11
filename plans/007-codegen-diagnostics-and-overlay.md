# Plan 007: Give codegen errors file:line locations and surface fatal failures in the Vite overlay

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2f6a466f..HEAD -- packages/codegen/src packages/vite/src/codegen-plugin.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `2f6a466f`, 2026-06-11

## Why this matters

Cirrus's competitive pitch is the dev loop: edit `cirrus/schema.ts`, types
flow to the client. Today, when a user's schema is invalid, two things go
wrong: (1) codegen throws plain `Error`s with the offending *AST text* but no
file path or line number, so the user hunts through their schema by hand; and
(2) the Vite plugin catches all codegen failures, logs one terminal line, and
returns `undefined` — so codegen silently stops, types go stale, and the
browser shows nothing. The code itself acknowledges the gap
(`codegen-plugin.ts:~76`: "the richer error-overlay presentation is a later
step"). This plan makes schema errors actionable (file:line in the message)
and makes fatal codegen failures visible in the browser via Vite's error
overlay during dev.

## Current state

- `packages/codegen/src/discover-schema.ts` — AST discovery over the user's
  `cirrus/schema.ts` via **ts-morph** (already a dependency). Throws plain
  `Error`s at multiple sites. Example (`discover-schema.ts:171`):

```ts
// `unique` must be a literal `true`/`false`. A computed value ... can't be
// resolved statically here, so we fail loudly rather than silently
// dropping a `uniqueIndex` from the emitted metadata.
if (initializer && !Node.isTrueLiteral(initializer) && !Node.isFalseLiteral(initializer)) {
    throw new Error(`@cirrus/codegen: \`unique\` must be a literal \`true\` or \`false\`, got ${JSON.stringify(initializer.getText())}`);
}
```

  Find all sibling sites with:
  `grep -n "throw new Error" packages/codegen/src/discover-schema.ts packages/codegen/src/discover-functions.ts packages/codegen/src/discover-queries.ts packages/codegen/src/discover-inserts.ts packages/codegen/src/discover-http-routes.ts packages/codegen/src/discover-migrations.ts packages/codegen/src/discover-crons.ts 2>/dev/null`
  Only the throw sites that have a ts-morph `Node` in hand are in scope for
  location enrichment (a node gives you file + line); sites with no node
  (e.g. "schema.ts not found" in `run-codegen.ts:64`) already name the file
  and stay as they are.

- `packages/vite/src/codegen-plugin.ts` — Vite plugin wrapping
  `@cirrus/codegen`. `runCodegenSafely` (~lines 78–93):

```ts
        for (const advisory of result.advisories) {
            logger.warn(`[cirrus] schema advisory [${advisory.level}] ${advisory.name}: ${advisory.detail} — ${advisory.remediation}`);
        }

        return resolve(result.outputDirectory);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`[cirrus] codegen failed: ${message}`);

        return undefined;
    }
```

  Note the existing split: **advisories** (lint-level, from `@cirrus/advisor`)
  are warnings; a thrown error from codegen is **fatal** (no output was
  produced / outputs are stale). That fatal/advisory split already exists —
  this plan does not need to invent a classification.

- Vite dev-server error overlay: from a plugin with a dev-server reference
  (`configureServer(server)` hook), send
  `server.hot.send({ type: "error", err: { message, stack, ...loc } })`
  (Vite 6+/7 environments API: also available per-environment; use whatever
  hook shape `codegen-plugin.ts` already uses — read the whole file first).
  Clearing: a subsequent successful codegen should send a full-reload or rely
  on the HMR update from the regenerated files to dismiss the overlay.

Repo conventions:
- ESM, no `.js` extensions on relative imports — EXCEPT inside codegen's
  emitted-code template strings (do not touch those).
- Codegen has golden fixtures; if you change only *error* messages, fixtures
  should be unaffected. If a fixture asserts an error message text, update it.
- Tests live in `packages/<name>/__tests__`, Vitest.

## Commands you will need

| Purpose            | Command                                              | Expected on success |
| ------------------ | ---------------------------------------------------- | ------------------- |
| Install            | `pnpm install`                                       | exit 0              |
| Codegen tests      | `pnpm --filter "@cirrus/codegen" run test`           | all pass            |
| Vite plugin tests  | `pnpm --filter "@cirrus/vite" run test`              | all pass            |
| Typecheck both     | `pnpm --filter "@cirrus/codegen" run lint:types && pnpm --filter "@cirrus/vite" run lint:types` | exit 0 |
| Lint both          | `pnpm --filter "@cirrus/codegen" run lint:eslint && pnpm --filter "@cirrus/vite" run lint:eslint` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `packages/codegen/src/` — a new small `diagnostics.ts` helper + the throw
  sites in the `discover-*.ts` files.
- `packages/codegen/__tests__/` — new/updated tests for located errors.
- `packages/vite/src/codegen-plugin.ts` — overlay wiring.
- `packages/vite/__tests__/` — new/updated tests.

**Out of scope** (do NOT touch):
- `packages/codegen/src/emit.ts` and all emitted-code template strings,
  golden fixtures' *generated* content (`.js` extensions there are correct).
- `packages/advisor` — advisories stay warnings; their presentation is not
  this plan.
- The CLI's codegen command (`packages/cli/src/commands/codegen/`) — it gets
  the better messages for free via the error text; no CLI changes.
- Watcher/debounce behavior in the Vite plugin.

## Git workflow

- Branch: `dx/codegen-diagnostics-overlay` off `alpha`.
- Two commits: `dx(codegen): include schema file:line in discovery errors`
  then `dx(vite): surface fatal codegen failures in the error overlay`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a located-error helper to codegen

Create `packages/codegen/src/diagnostics.ts` exporting (named exports only —
repo rule: never mix default + named):

```ts
import type { Node } from "ts-morph";

/** Error carrying the schema source location it was raised from. */
export class CodegenDiagnosticError extends Error {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    // message format: "@cirrus/codegen: <detail> (<file>:<line>:<column>)"
}

export const diagnosticAt = (node: Node, detail: string): CodegenDiagnosticError => { ... };
```

Use `node.getSourceFile().getFilePath()`, `node.getStartLineNumber()`, and
`node.getStart() - node.getStartLinePos()` (or ts-morph's
`getLineAndColumnAtPos`) for the location. Keep the `@cirrus/codegen:` prefix
the existing messages use. Export the class from `packages/codegen/src/index.ts`
alongside the existing named exports.

**Verify**: `pnpm --filter "@cirrus/codegen" run lint:types` → exit 0.

### Step 2: Convert the discovery throw sites

For every `throw new Error(...)` in the `discover-*.ts` files where a
ts-morph `Node` is in scope (the grep from "Current state" lists them),
replace with `throw diagnosticAt(<nearest relevant node>, "<existing detail text>")`.
Keep the detail text identical apart from the appended location. Do not
convert sites with no node in hand.

**Verify**: `pnpm --filter "@cirrus/codegen" run test` → all pass (update any
test that asserts an exact error message to match the new suffix — use
`toThrow(/must be a literal/)`-style partial matching where the test was
asserting full equality).

### Step 3: Test a located error end-to-end

In `packages/codegen/__tests__/`, add a test (model it on the existing
discover-schema tests in that directory — find them with
`ls packages/codegen/__tests__/`) that feeds an in-memory schema with
`unique: someFlag` (non-literal) and asserts the thrown error's `message`
contains `schema.ts:` followed by the right line number, and that `error.file`
/ `error.line` are set.

**Verify**: `pnpm --filter "@cirrus/codegen" run test` → all pass, new test included.

### Step 4: Wire the Vite overlay for fatal failures

In `packages/vite/src/codegen-plugin.ts`:

1. Read the whole file first. Capture the dev server in the plugin's
   `configureServer` hook (add the hook if absent) into a local
   `let devServer: ViteDevServer | undefined`.
2. In `runCodegenSafely`'s catch: keep the `logger.error` line, and
   additionally, when `devServer` is set (dev mode only), send the overlay
   payload:

```ts
devServer.hot.send({
    type: "error",
    err: {
        message: `[cirrus] codegen failed: ${message}`,
        stack: error instanceof Error ? (error.stack ?? "") : "",
        // When the error is a CodegenDiagnosticError, map file/line/column
        // into `loc` so the overlay deep-links the schema file.
        ...(isDiagnostic(error) ? { loc: { column: error.column, file: error.file, line: error.line } } : {}),
    },
});
```

   (`import { CodegenDiagnosticError } from "@cirrus/codegen"` — check the
   actual exported type shape from step 1; Vite's `ErrorPayload["err"]`
   requires `message` and `stack`.)
3. On a subsequent **successful** codegen run, if the previous run failed,
   trigger `devServer.hot.send({ type: "full-reload" })` so the overlay
   clears even when no module changed. Track this with a simple
   `let lastRunFailed = false` flag.
4. Build mode (`vite build`): keep current behavior (log + return undefined)
   — do not throw; the build-path behavior change is out of scope.

**Verify**: `pnpm --filter "@cirrus/vite" run lint:types` → exit 0.

### Step 5: Test the overlay wiring

In `packages/vite/__tests__/` (model on the existing codegen-plugin tests —
`ls packages/vite/__tests__/` to find them), add tests with a stubbed dev
server (`{ hot: { send: vi.fn() } }`):

1. Codegen throws → `hot.send` called once with `type: "error"` and a message
   containing `codegen failed`.
2. Codegen throws a `CodegenDiagnosticError` → the payload includes
   `err.loc.file` / `err.loc.line`.
3. Failure then success → second run sends `type: "full-reload"`.
4. No dev server captured (build mode) → no send, still returns undefined.

**Verify**: `pnpm --filter "@cirrus/vite" run test` → all pass, 4 new cases.

## Test plan

Covered in steps 3 and 5. Full gates:
`pnpm --filter "@cirrus/codegen" run test && pnpm --filter "@cirrus/vite" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Both packages: `lint:types`, `lint:eslint`, `test` all exit 0
- [ ] `grep -rn "diagnosticAt" packages/codegen/src/discover-schema.ts` returns ≥1 match
- [ ] New codegen test asserts a `schema.ts:<line>` location in an error message
- [ ] New vite tests cover error-send, loc mapping, overlay clearing, build-mode no-op
- [ ] `git status` shows changes only under the in-scope paths
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `runCodegenSafely` in `codegen-plugin.ts` no longer matches the excerpt.
- The plugin has no way to obtain a dev-server/hot-channel reference (e.g. it
  only runs in an environment without `configureServer`) — the overlay design
  needs a maintainer decision.
- More than ~5 existing tests assert exact error-message strings that the
  location suffix breaks — report the blast radius before mass-editing.
- ts-morph's location APIs differ from what step 1 names (version drift).

## Maintenance notes

- Future error sites in `discover-*.ts` should use `diagnosticAt` whenever a
  node is in hand — a reviewer should reject new bare `throw new Error` with
  a node in scope.
- The advisor's advisories remain terminal warnings; promoting them into the
  overlay (as warning-level) is a possible follow-up once this lands.
- If `@cloudflare/vite-plugin` / Vite major bumps change the `hot.send`
  payload type, the overlay tests here are the canary.
