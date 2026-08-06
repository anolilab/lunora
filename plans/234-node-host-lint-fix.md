# Plan: fix lint in node-workflow-host.ts, then test + commit

## Remaining lint errors (53 in node-workflow-host.ts)

### 1. Restructure file (import/exports-last, jsdoc)
- Move `export interface` + `export const` declarations to bottom; use `export { ... }` + `export type { ... }` at end
- Flatten JSDoc header continuation lines (no extra indent) to fix `jsdoc/check-indentation`

### 2. Remove `any` from generic constraints
- Change `Workflows extends Record<string, WorkflowDefinition<any, any>>` → `Workflows extends Record<string, WorkflowDefinition>`
- Inside the function, narrow each `definition: unknown` with `isWorkflowDefinition(definition)` before using it
- This fixes `no-explicit-any` at 3 sites

### 3. Rewrite `toMs` (cognitive complexity 23 → <15, regex complexity, static regex)
- Move regex to module scope (`DURATION_PATTERN`) → fixes `prefer-static-regex`
- Replace nested ternaries with a lookup table (`DURATION_MS: Record<string, number>`) → fixes `no-nested-conditional` + cognitive complexity
- Simplify regex: match `(\d+(?:\.\d+)?)\s*([a-z]+)$` and validate unit via lookup → fixes `regex-complexity` + `prefer-\d`

### 4. Fix `no-non-null-assertion` (line 118)
- Replace `match[2]!` with `(match[2] ?? "")` (defensive, regex guarantees it exists)

### 5. Fix `require-await` (run, pause, restart, get)
- `run`: add `await` before `definition.handler(context)` → `return await definition.handler(context)`
- `pause`/`restart`: rewrite as non-async returning `Promise.reject(...)` (no `async` needed)
- `get`: rewrite as non-async returning `Promise.resolve(instanceFor(id))`

### 6. Fix `no-unsafe-return` (line 242)
- After narrowing `definition` with `isWorkflowDefinition`, the return type is `Promise<unknown>`, not `any` → safe

## After rewriting
1. `pnpm --filter @lunora/platform-node run lint:types`
2. `pnpm --filter @lunora/platform-node run lint:eslint`
3. `pnpm --filter @lunora/platform-node run lint:prettier`
4. `pnpm --filter @lunora/platform-node run test` — fix any test failures (known: "unknown id" test bug)
5. `pnpm --filter @lunora/config run lint:types` (node-driver change)
6. Update `plans/234-node-host-findings.md`
7. Commit + push
